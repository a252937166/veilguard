const DEFAULT_RESOLUTION_TIMEOUT_MS = 300_000;
const DEFAULT_RESOLUTION_INTERVAL_MS = 3_000;
const DEFAULT_USABILITY_TIMEOUT_MS = 45_000;
const DEFAULT_USABILITY_INTERVAL_MS = 2_000;
const SECRET_LIKE_HEX = /0x[0-9a-f]{40,}/gi;

const sleepDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const safeLabel = (label) => (
  String(label ?? 'Nox operation').replace(SECRET_LIKE_HEX, '[redacted]').trim().slice(0, 120)
);

function checkedDuration(value, label, allowZero = false) {
  if (!Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) {
    throw new Error(`invalid Nox ${label}`);
  }
  return Math.floor(value);
}

export class NoxProductionError extends Error {
  constructor({ phase, label, attempts, timeoutMs, code }) {
    const action = phase === 'resolution'
      ? 'did not resolve'
      : phase === 'simulation'
        ? 'did not become simulatable'
        : 'did not become readable';
    super(`${safeLabel(label)} ${action} within the production retry boundary`);
    this.name = 'NoxProductionError';
    this.phase = phase;
    this.attempts = attempts;
    this.timeoutMs = timeoutMs;
    this.code = code;
  }
}

async function retryReadOnly(phase, label, operation, {
  timeoutMs = DEFAULT_USABILITY_TIMEOUT_MS,
  intervalMs = DEFAULT_USABILITY_INTERVAL_MS,
  now = () => Date.now(),
  sleep = sleepDefault,
  shouldRetry = () => true,
} = {}) {
  const timeout = checkedDuration(timeoutMs, 'retry timeout', true);
  const interval = checkedDuration(intervalMs, 'retry interval');
  const startedAt = now();
  let attempts = 0;
  while (true) {
    attempts += 1;
    try {
      return await operation();
    } catch (error) {
      let retryable = false;
      try { retryable = shouldRetry(error) !== false; }
      catch { retryable = false; }
      if (!retryable) {
        throw new NoxProductionError({
          phase, label, attempts, timeoutMs: timeout, code: 'NOX_OPERATION_NOT_RETRYABLE',
        });
      }
      const elapsed = Math.max(0, now() - startedAt);
      if (elapsed >= timeout) {
        throw new NoxProductionError({
          phase, label, attempts, timeoutMs: timeout, code: 'NOX_PROPAGATION_TIMEOUT',
        });
      }
      await sleep(Math.min(interval, timeout - elapsed));
    }
  }
}

async function fetchResolution(statusUrl, handles, {
  fetchImpl = fetch,
  requestTimeoutMs = 6_000,
} = {}) {
  const unique = [...new Set(handles.map((handle) => String(handle).toLowerCase()))];
  if (unique.length === 0) return true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), checkedDuration(
    requestTimeoutMs,
    'status request timeout',
  ));
  try {
    const response = await fetchImpl(statusUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handles: unique }),
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const body = await response.json();
    if (!Array.isArray(body?.payload?.statuses)) return false;
    const status = new Map(
      body.payload.statuses
        .filter((entry) => typeof entry?.handle === 'string')
        .map((entry) => [entry.handle.toLowerCase(), entry.resolved === true]),
    );
    return unique.every((handle) => status.get(handle) === true);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** One-shot, non-blocking readiness probe for sweep discovery. */
export function areNoxHandlesResolved(statusUrl, handles, options = {}) {
  return fetchResolution(statusUrl, handles, options);
}

/** Poll status until every handle is resolved; errors never contain handles. */
export function waitForNoxHandlesResolved(statusUrl, handles, options = {}) {
  return retryReadOnly(
    'resolution',
    'Nox handles',
    async () => {
      if (!(await fetchResolution(statusUrl, handles, options))) {
        throw new Error('not resolved');
      }
    },
    {
      ...options,
      timeoutMs: options.timeoutMs ?? DEFAULT_RESOLUTION_TIMEOUT_MS,
      intervalMs: options.intervalMs ?? DEFAULT_RESOLUTION_INTERVAL_MS,
    },
  );
}

/** Retry only a read/decrypt call after status resolution. */
export function retryNoxRead(label, operation, options = {}) {
  return retryReadOnly('read', label, operation, options);
}

/** Retry only an exact eth_call/eth_estimateGas preflight; never a broadcast. */
export function waitUntilNoxSimulatable(label, simulate, options = {}) {
  return retryReadOnly('simulation', label, simulate, options);
}

/**
 * Shared production resolved→usable barrier. The status API is a prerequisite,
 * not proof that publicDecrypt/decrypt is already consumable downstream.
 */
export async function resolveThenRetryNoxRead({
  statusUrl,
  handles,
  label,
  operation,
  resolution = {},
  usability = {},
}) {
  await waitForNoxHandlesResolved(statusUrl, handles, resolution);
  return retryNoxRead(label, operation, usability);
}
