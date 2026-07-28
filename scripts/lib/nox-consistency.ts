/**
 * Eventual-consistency barriers for Nox handles.
 *
 * `resolved=true` from the handle status endpoint is a useful computation
 * signal, but it is not a guarantee that every downstream RPC/gateway path can
 * consume the handle yet. These helpers retry only the read-only operation
 * supplied by the caller. A transaction must be broadcast only after the
 * operation succeeds.
 *
 * This module deliberately has no Node-only dependencies so the browser app
 * and the Sepolia scripts can use the exact same retry semantics.
 */

export const DEFAULT_NOX_PROPAGATION_TIMEOUT_MS = 45_000;
export const DEFAULT_NOX_RETRY_INTERVAL_MS = 2_000;
export const DEFAULT_NOX_RESOLUTION_TIMEOUT_MS = 300_000;
export const DEFAULT_NOX_RESOLUTION_INTERVAL_MS = 3_000;

export type NoxRetryProgress = Readonly<{
  attempt: number;
  elapsedMs: number;
  remainingMs: number;
}>;

export type NoxUsabilityTiming = Readonly<{
  attempts: number;
  startedAt: number;
  usableAt: number;
  elapsedMs: number;
  resolvedAt?: number;
  resolvedToUsableMs?: number;
}>;

export type NoxRetryOptions = Readonly<{
  timeoutMs?: number;
  intervalMs?: number;
  signal?: AbortSignal;
  /**
   * Override retry classification when a caller knows an error is terminal
   * (for example, a user-rejected wallet signature).
   */
  shouldRetry?: (error: unknown) => boolean;
  /**
   * Receives timing metadata only. The underlying error is intentionally not
   * exposed because SDK/RPC errors can contain handles or account addresses.
   */
  onRetry?: (progress: NoxRetryProgress) => void;
  /**
   * Timestamp returned by `waitForHandlesResolved`. Supplying it lets callers
   * measure status-resolution → actual-consumption propagation lag.
   */
  resolvedAt?: number;
  onUsable?: (timing: NoxUsabilityTiming) => void;
  /** Test seams for deterministic unit tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}>;

export type NoxHandleResolutionOptions = NoxRetryOptions & Readonly<{
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}>;

export type NoxHandleResolutionTiming = Readonly<{
  attempts: number;
  startedAt: number;
  resolvedAt: number;
  elapsedMs: number;
}>;

type NoxConsistencyPhase = 'resolution' | 'simulation' | 'read';

const secretLikeHex = /0x[0-9a-f]{40,}/gi;

function safeLabel(label: string): string {
  const redacted = label.replace(secretLikeHex, '[redacted]').trim();
  return (redacted || 'Nox operation').slice(0, 120);
}

function checkedDuration(value: number, name: string, allowZero: boolean): number {
  if (!Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) {
    throw new Error(`Invalid Nox retry ${name}`);
  }
  return Math.floor(value);
}

export class NoxConsistencyError extends Error {
  readonly code:
    | 'NOX_PROPAGATION_TIMEOUT'
    | 'NOX_PROPAGATION_ABORTED'
    | 'NOX_OPERATION_NOT_RETRYABLE';
  readonly phase: NoxConsistencyPhase;
  readonly attempts: number;
  readonly timeoutMs: number;

  constructor(args: {
    code: NoxConsistencyError['code'];
    phase: NoxConsistencyPhase;
    label: string;
    attempts: number;
    timeoutMs: number;
  }) {
    const action = args.phase === 'resolution'
      ? 'did not resolve'
      : args.phase === 'simulation'
        ? 'did not become simulatable'
        : 'did not become readable';
    const suffix = args.code === 'NOX_PROPAGATION_ABORTED'
      ? 'because the wait was cancelled'
      : args.code === 'NOX_OPERATION_NOT_RETRYABLE'
        ? 'because the failure is not retryable'
        : `within ${args.timeoutMs}ms`;
    super(`${safeLabel(args.label)} ${action} ${suffix} (${args.attempts} attempt${args.attempts === 1 ? '' : 's'})`);
    this.name = 'NoxConsistencyError';
    this.code = args.code;
    this.phase = args.phase;
    this.attempts = args.attempts;
    this.timeoutMs = args.timeoutMs;
  }
}

async function retryPropagation<T>(
  phase: NoxConsistencyPhase,
  label: string,
  operation: () => Promise<T>,
  options: NoxRetryOptions,
): Promise<{ value: T; timing: NoxUsabilityTiming }> {
  const timeoutMs = checkedDuration(
    options.timeoutMs ?? DEFAULT_NOX_PROPAGATION_TIMEOUT_MS,
    'timeout',
    true,
  );
  const intervalMs = checkedDuration(
    options.intervalMs ?? DEFAULT_NOX_RETRY_INTERVAL_MS,
    'interval',
    false,
  );
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = now();
  let attempts = 0;

  while (true) {
    if (options.signal?.aborted) {
      throw new NoxConsistencyError({
        code: 'NOX_PROPAGATION_ABORTED',
        phase,
        label,
        attempts,
        timeoutMs,
      });
    }

    attempts += 1;
    let value: T;
    try {
      value = await operation();
    } catch (error) {
      // Do not attach `cause` or interpolate the source error. viem and Nox SDK
      // messages can embed calldata, handles and actor addresses.
      let retryable = true;
      try {
        retryable = options.shouldRetry?.(error) ?? true;
      } catch {
        retryable = false;
      }
      if (!retryable) {
        throw new NoxConsistencyError({
          code: 'NOX_OPERATION_NOT_RETRYABLE',
          phase,
          label,
          attempts,
          timeoutMs,
        });
      }

      const elapsedMs = Math.max(0, now() - startedAt);
      const remainingMs = timeoutMs - elapsedMs;
      if (remainingMs <= 0) {
        throw new NoxConsistencyError({
          code: 'NOX_PROPAGATION_TIMEOUT',
          phase,
          label,
          attempts,
          timeoutMs,
        });
      }

      try {
        options.onRetry?.({
          attempt: attempts,
          elapsedMs,
          remainingMs,
        });
      } catch {
        // Observability hooks must never alter retry correctness.
      }
      try {
        await sleep(Math.min(intervalMs, remainingMs));
      } catch {
        throw new NoxConsistencyError({
          code: 'NOX_PROPAGATION_ABORTED',
          phase,
          label,
          attempts,
          timeoutMs,
        });
      }
      continue;
    }

    const usableAt = now();
    const timing: NoxUsabilityTiming = {
      attempts,
      startedAt,
      usableAt,
      elapsedMs: Math.max(0, usableAt - startedAt),
      ...(options.resolvedAt === undefined
        ? {}
        : {
            resolvedAt: options.resolvedAt,
            resolvedToUsableMs: Math.max(0, usableAt - options.resolvedAt),
          }),
    };
    try {
      options.onUsable?.(timing);
    } catch {
      // Timing export is best-effort and cannot turn a successful preflight
      // into another SDK/RPC attempt.
    }
    return { value, timing };
  }
}

/**
 * Repeats an exact read-only contract simulation until a freshly-created input
 * handle is consumable. The successful simulation result is returned so gas
 * estimation callers do not need to execute the preflight twice.
 */
export function waitUntilSimulatable<T>(
  label: string,
  simulate: () => Promise<T>,
  options: NoxRetryOptions = {},
): Promise<T> {
  return retryPropagation('simulation', label, simulate, options).then(({ value }) => value);
}

/**
 * Retries decrypt/publicDecrypt after handle resolution until the downstream
 * read path has caught up. No source error text is retained or rethrown.
 */
export function retryNoxRead<T>(
  label: string,
  operation: () => Promise<T>,
  options: NoxRetryOptions = {},
): Promise<T> {
  return retryPropagation('read', label, operation, options).then(({ value }) => value);
}

/**
 * Polls the Nox status endpoint until every requested handle is resolved.
 *
 * `statusUrl` is the complete `/v0/public/handles/status` endpoint. Handles are
 * sent to the gateway but never included in errors, progress callbacks or the
 * returned timing metadata.
 */
export async function waitForHandlesResolved(
  statusUrl: string,
  handles: readonly string[],
  options: NoxHandleResolutionOptions = {},
): Promise<NoxHandleResolutionTiming> {
  const uniqueHandles = [...new Set(handles.map((handle) => handle.toLowerCase()))];
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestTimeoutMs = checkedDuration(options.requestTimeoutMs ?? 6_000, 'request timeout', false);
  const now = options.now ?? Date.now;

  const { timing } = await retryPropagation(
    'resolution',
    'Nox handles',
    async () => {
      if (uniqueHandles.length === 0) return;

      const controller = new AbortController();
      const forwardAbort = () => controller.abort();
      options.signal?.addEventListener('abort', forwardAbort, { once: true });
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        const response = await fetchImpl(statusUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ handles: uniqueHandles }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('status unavailable');
        const data = await response.json() as {
          payload?: { statuses?: { handle?: unknown; resolved?: unknown }[] };
        };
        if (!Array.isArray(data.payload?.statuses)) throw new Error('invalid status payload');
        const byHandle = new Map(
          data.payload.statuses
            .filter((entry): entry is { handle: string; resolved: boolean } =>
              typeof entry.handle === 'string' && typeof entry.resolved === 'boolean')
            .map((entry) => [entry.handle.toLowerCase(), entry.resolved]),
        );
        if (!uniqueHandles.every((handle) => byHandle.get(handle) === true)) {
          throw new Error('handles unresolved');
        }
      } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', forwardAbort);
      }
    },
    {
      ...options,
      timeoutMs: options.timeoutMs ?? DEFAULT_NOX_RESOLUTION_TIMEOUT_MS,
      intervalMs: options.intervalMs ?? DEFAULT_NOX_RESOLUTION_INTERVAL_MS,
      now,
    },
  );

  return {
    attempts: timing.attempts,
    startedAt: timing.startedAt,
    resolvedAt: timing.usableAt,
    elapsedMs: timing.elapsedMs,
  };
}
