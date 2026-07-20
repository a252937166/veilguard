import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { buildDemoMemoHash, createSerialExecutor } from './demo-security.mjs';

export class DemoDecisionError extends Error {
  constructor(status, message, details = undefined) {
    super(message);
    this.name = 'DemoDecisionError';
    this.status = status;
    this.details = details;
  }
}

export function assertDemoRunId(runId) {
  if (typeof runId !== 'string' || !/^[A-Za-z0-9_-]{8,96}$/.test(runId)) {
    throw new DemoDecisionError(400, 'runId must be 8-96 URL-safe characters');
  }
  return runId;
}

export function parseDemoRequestId(value) {
  const raw = String(value);
  if (!/^\d{1,9}$/.test(raw) || BigInt(raw) < 1n) {
    throw new DemoDecisionError(400, 'bad requestId');
  }
  return BigInt(raw);
}

export function assertDemoAction(action) {
  if (action !== 'approve' && action !== 'reject') {
    throw new DemoDecisionError(400, 'action must be approve or reject');
  }
  return action;
}

/**
 * Validate the public identity of one run-bound scenario request. The encrypted
 * amount is deliberately checked separately by verifyDemoAmount so callers
 * cannot accidentally sign after validating only public fields.
 */
export function assertDemoScenarioIdentity({
  request,
  runId,
  scenarioName,
  spec,
  chainId,
  module,
}) {
  assertDemoRunId(runId);
  if (!spec) throw new DemoDecisionError(400, 'unknown demo scenario');
  if (request[1].toLowerCase() !== spec.delegate.toLowerCase()) {
    throw new DemoDecisionError(403, 'request is not owned by this demo scenario');
  }
  if (request[2].toLowerCase() !== spec.recipient.toLowerCase()) {
    throw new DemoDecisionError(403, 'request recipient does not match this demo scenario');
  }
  const expectedMemo = buildDemoMemoHash({
    chainId,
    module,
    runId,
    scenario: scenarioName,
    mandateId: request[0],
    delegate: request[1],
  });
  if (request[3].toLowerCase() !== expectedMemo.toLowerCase()) {
    throw new DemoDecisionError(403, 'request is not bound to this demo run');
  }
  return spec;
}

export async function verifyDemoAmount({ request, spec, assertFinanceAdmin, decryptAmount }) {
  try {
    await assertFinanceAdmin();
    const amount = BigInt(await decryptAmount(request[6]));
    if (amount !== BigInt(spec.amount)) {
      throw new DemoDecisionError(403, 'decrypted amount does not match the demo scenario');
    }
    return amount;
  } catch (error) {
    if (Number.isInteger(error?.status)) throw error;
    throw new DemoDecisionError(503, 'finance admin could not decrypt and verify the request amount');
  }
}

const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));

function createDecisionStore({ load, persist }) {
  const serialise = createSerialExecutor();
  let entries;

  const ensureLoaded = async () => {
    if (!entries) entries = await load();
    return entries;
  };

  const mutate = (fn) => serialise(async () => {
    const current = await ensureLoaded();
    const result = fn(current);
    await persist(current);
    return result;
  });

  return {
    get(requestId) {
      return serialise(async () => clone((await ensureLoaded())[String(requestId)]));
    },
    observeAwaiting(requestId, observedAt) {
      if (!Number.isFinite(observedAt)) throw new Error('awaiting observation time must be finite');
      return serialise(async () => {
        const current = await ensureLoaded();
        const key = String(requestId);
        const entry = current[key];
        if (Number.isFinite(entry?.awaitingSince)) return entry.awaitingSince;
        if (entry?.receipt?.origin === 'timeout') return observedAt;
        current[key] = { ...entry, awaitingSince: observedAt };
        await persist(current);
        return observedAt;
      });
    },
    recordIntent(requestId, intent) {
      return mutate((current) => {
        const key = String(requestId);
        current[key] = { ...current[key], intent: clone(intent) };
      });
    },
    recordBroadcast(requestId, broadcast) {
      return mutate((current) => {
        const key = String(requestId);
        const entry = current[key];
        if (!entry?.intent
          || entry.intent.runId !== broadcast.runId
          || entry.intent.action !== broadcast.action) {
          throw new DemoDecisionError(409, 'decision broadcast has no matching run-bound intent');
        }
        current[key] = {
          ...entry,
          intent: {
            ...entry.intent,
            hash: broadcast.hash,
            broadcastAt: entry.intent.broadcastAt ?? broadcast.broadcastAt,
          },
        };
      });
    },
    clearIntent(requestId, runId, action) {
      return mutate((current) => {
        const key = String(requestId);
        const entry = current[key];
        if (entry?.intent?.runId === runId && entry.intent.action === action && !entry.receipt) {
          delete entry.intent;
          if (!Object.keys(entry).length) delete current[key];
        }
      });
    },
    recordUserReceipt(requestId, receipt) {
      return mutate((current) => {
        const key = String(requestId);
        const entry = current[key];
        if (!entry?.intent
          || entry.intent.runId !== receipt.runId
          || entry.intent.action !== receipt.action) {
          throw new DemoDecisionError(409, 'decision receipt has no matching run-bound intent');
        }
        current[key] = { ...entry, receipt: { ...clone(receipt), origin: 'user' } };
      });
    },
    recordTimeoutReceipt(requestId, receipt) {
      return mutate((current) => {
        const key = String(requestId);
        current[key] = { receipt: { ...clone(receipt), action: 'reject', origin: 'timeout' } };
      });
    },
  };
}

export function createMemoryDecisionStore(initial = {}) {
  const values = clone(initial);
  return createDecisionStore({
    load: async () => values,
    persist: async () => {},
  });
}

/**
 * Small, non-secret journal. It survives a provisioner restart so a terminal
 * cancellation is never guessed to be a user's Reject merely from state=5.
 */
export function createFileDecisionStore(filePath) {
  if (!filePath) throw new Error('decision journal path is required');
  let writeCounter = 0;
  return createDecisionStore({
    load: async () => {
      try {
        const decoded = JSON.parse(await readFile(filePath, 'utf8'));
        if (decoded?.version !== 1 || !decoded.entries || typeof decoded.entries !== 'object') {
          throw new Error('unsupported decision journal');
        }
        return decoded.entries;
      } catch (error) {
        if (error?.code === 'ENOENT') return {};
        throw error;
      }
    },
    persist: async (entries) => {
      await mkdir(dirname(filePath), { recursive: true });
      const temporary = `${filePath}.${process.pid}.${++writeCounter}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, filePath);
    },
  });
}

function matchingUserReceipt(entry, runId, action, expectedState) {
  return !!entry?.intent
    && entry.intent.runId === runId
    && entry.intent.action === action
    && entry.receipt?.origin === 'user'
    && entry.receipt.runId === runId
    && entry.receipt.action === action
    && entry.receipt.state === expectedState;
}

function errorPayload(error, fallback = 'demo decision failed') {
  return {
    error: error?.shortMessage ?? error?.message ?? fallback,
    ...(error?.details ? { details: error.details } : {}),
  };
}

/**
 * Injectable decision boundary used by the HTTP provisioner and unit tests.
 * Every Safe mutation is performed inside the caller-provided Safe lock.
 */
export function createDemoDecisionService({
  readRequest,
  assertIdentity,
  verifyAmount,
  readActiveMandate,
  executeUnlocked,
  recoverBroadcast,
  withSafeLock,
  store,
  decisionWindowMs,
  now = () => Date.now(),
}) {
  if (!Number.isFinite(decisionWindowMs) || decisionWindowMs < 1) {
    throw new Error('decisionWindowMs must be positive');
  }
  const jobs = new Map();

  const terminalResult = async ({ requestId, request, runId, action }) => {
    const state = Number(request[5]);
    if (state !== 2 && state !== 3 && state !== 5) return null;
    const entry = await store.get(requestId);

    // A confirmed timeout receipt is authoritative even if an RPC temporarily
    // reports stale state=3. Never issue another Safe action for that request.
    if (entry?.receipt?.origin === 'timeout') {
      throw new DemoDecisionError(410, 'decision window expired; escrow was returned and budget restored', {
        hash: entry.receipt.hash,
        state: 'safe-rejected',
        origin: 'timeout',
      });
    }

    if (state === 3) return null;

    if (state === 2) {
      if (matchingUserReceipt(entry, runId, 'approve', 'safe-approved')) {
        if (action !== 'approve') throw new DemoDecisionError(409, 'request was already approved');
        return {
          ok: true,
          requestId: Number(requestId),
          action,
          hash: entry.receipt.hash,
          state: 'safe-approved',
          idempotent: true,
        };
      }
      throw new DemoDecisionError(409, action === 'reject'
        ? 'request was already executed'
        : 'executed request has no matching user approval receipt');
    }

    if (matchingUserReceipt(entry, runId, 'reject', 'safe-rejected')) {
      if (action !== 'reject') throw new DemoDecisionError(409, 'request was already rejected');
      return {
        ok: true,
        requestId: Number(requestId),
        action,
        hash: entry.receipt.hash,
        state: 'safe-rejected',
        idempotent: true,
      };
    }

    // State alone cannot distinguish a watchdog timeout from an external Safe
    // cancellation. Only our persisted timeout receipt is allowed to mean 410.
    throw new DemoDecisionError(409, action === 'approve'
      ? 'request was already cancelled'
      : 'cancelled request has no matching user rejection receipt');
  };

  const perform = async (input, report = async () => {}) => {
    const runId = assertDemoRunId(input.runId);
    const requestId = parseDemoRequestId(input.requestId);
    const action = assertDemoAction(input.action);

    const initial = await readRequest(requestId);
    const spec = assertIdentity(initial, runId);
    const initialState = Number(initial[5]);
    const recorded = await store.get(requestId);

    // A persisted receipt or broadcast is already past the authorization
    // boundary: the amount was verified before the intent was written. Recover
    // or return that trusted result before consulting Nox again, so a temporary
    // decrypt outage cannot break idempotency or strand a broadcast Safe tx.
    if (recorded?.intent && !recorded.receipt
      && (recorded.intent.runId !== runId || recorded.intent.action !== action)) {
      throw new DemoDecisionError(409, `request already has a ${recorded.intent.action} decision in progress`);
    }
    if (recorded?.intent?.hash && !recorded.receipt) {
      if (typeof recoverBroadcast !== 'function') {
        throw new DemoDecisionError(503, 'Safe transaction was broadcast but receipt recovery is unavailable', {
          hash: recorded.intent.hash,
          phase: 'recovering',
        });
      }
      return withSafeLock(async () => {
        const current = await readRequest(requestId);
        assertIdentity(current, runId);
        const currentEntry = await store.get(requestId);

        // The watchdog or another recovery may have completed while this call
        // waited for the Safe critical section.
        if (currentEntry?.receipt) {
          const terminal = await terminalResult({ requestId, request: current, runId, action });
          if (terminal) return terminal;
          throw new DemoDecisionError(503, 'Safe receipt is recorded but request settlement is not indexed yet', {
            hash: currentEntry.receipt.hash,
            phase: 'recovering',
          });
        }
        if (!currentEntry?.intent?.hash) {
          throw new DemoDecisionError(409, 'decision broadcast journal changed; retry from current chain state');
        }
        if (currentEntry.intent.runId !== runId || currentEntry.intent.action !== action) {
          throw new DemoDecisionError(409, `request already has a ${currentEntry.intent.action} decision broadcast`);
        }

        await report({ phase: 'recovering', hash: currentEntry.intent.hash });
        try {
          await recoverBroadcast(currentEntry.intent.hash, requestId, action);
        } catch (error) {
          if (Number.isInteger(error?.status)) throw error;
          throw new DemoDecisionError(503, 'Safe transaction was broadcast; receipt confirmation is still pending', {
            hash: currentEntry.intent.hash,
            phase: 'recovering',
          });
        }
        const recovered = await readRequest(requestId);
        assertIdentity(recovered, runId);
        const expectedNumericState = action === 'approve' ? 2 : 5;
        if (Number(recovered[5]) !== expectedNumericState) {
          throw new DemoDecisionError(503, 'Safe receipt confirmed but request settlement is not indexed yet', {
            hash: currentEntry.intent.hash,
            phase: 'recovering',
          });
        }
        const recoveredState = action === 'approve' ? 'safe-approved' : 'safe-rejected';
        await store.recordUserReceipt(requestId, {
          runId,
          action,
          hash: currentEntry.intent.hash,
          state: recoveredState,
          recordedAt: now(),
        });
        await report({ phase: 'settled', hash: currentEntry.intent.hash });
        return {
          ok: true,
          requestId: Number(requestId),
          action,
          hash: currentEntry.intent.hash,
          state: recoveredState,
          idempotent: true,
          recovered: true,
        };
      });
    }

    const already = await terminalResult({ requestId, request: initial, runId, action });
    if (already) return already;
    if (recorded?.receipt?.origin === 'user') {
      throw new DemoDecisionError(503, 'Safe receipt is recorded but request settlement is not indexed yet', {
        hash: recorded.receipt.hash,
        phase: 'recovering',
      });
    }
    if (initialState !== 3) {
      throw new DemoDecisionError(409, 'request is not awaiting Safe approval');
    }

    // Persist the first valid public observation before the only path that can
    // produce a new signature. New signing still fails closed unless Finance
    // Admin decrypts and verifies the exact scenario amount.
    await store.observeAwaiting(requestId, now());
    await verifyAmount(initial, spec);

    return withSafeLock(async () => {
      const current = await readRequest(requestId);
      assertIdentity(current, runId);
      const terminal = await terminalResult({ requestId, request: current, runId, action });
      if (terminal) return terminal;
      if (Number(current[5]) !== 3) {
        throw new DemoDecisionError(409, 'request is no longer awaiting Safe approval');
      }

      const activeMandate = await readActiveMandate(current[1]);
      if (BigInt(activeMandate) !== BigInt(current[0])) {
        throw new DemoDecisionError(409, 'request mandate is no longer active');
      }

      // request.createdAt predates TEE evaluation. Start the human decision
      // window only when state=3 is first observed, and persist that boundary
      // so process restarts cannot reset or consume it.
      const awaitingSince = await store.observeAwaiting(requestId, now());
      const age = now() - awaitingSince;
      if (age >= decisionWindowMs) {
        const hash = await executeUnlocked(requestId, 'reject');
        await store.recordTimeoutReceipt(requestId, {
          hash,
          state: 'safe-rejected',
          recordedAt: now(),
        });
        throw new DemoDecisionError(410, 'decision window expired; escrow was returned and budget restored', {
          hash,
          state: 'safe-rejected',
          origin: 'timeout',
        });
      }

      await store.recordIntent(requestId, { runId, action, recordedAt: now() });
      await report({ phase: 'signing' });
      let hash;
      let broadcastHash;
      try {
        hash = await executeUnlocked(requestId, action, async (progress = {}) => {
          const update = { ...progress };
          if (update.hash) {
            broadcastHash = update.hash;
            await store.recordBroadcast(requestId, {
              runId,
              action,
              hash: update.hash,
              broadcastAt: now(),
            });
          }
          await report(update);
        });
      } catch (error) {
        if (!broadcastHash) await store.clearIntent(requestId, runId, action).catch(() => {});
        if (broadcastHash) {
          throw new DemoDecisionError(503, 'Safe transaction was broadcast; receipt confirmation is still pending', {
            hash: broadcastHash,
            phase: 'recovering',
          });
        }
        throw error;
      }
      // Older injected executors may only return the hash after confirmation.
      // Persisting it here keeps those adapters compatible; the production Safe
      // executor reports it at broadcast time, before waiting for the receipt.
      await store.recordBroadcast(requestId, { runId, action, hash, broadcastAt: now() });
      await report({ phase: 'confirming', hash });
      const state = action === 'approve' ? 'safe-approved' : 'safe-rejected';
      await store.recordUserReceipt(requestId, {
        runId,
        action,
        hash,
        state,
        recordedAt: now(),
      });
      await report({ phase: 'settled', hash });
      return {
        ok: true,
        requestId: Number(requestId),
        action,
        hash,
        state,
        idempotent: false,
      };
    });
  };

  const snapshot = (job) => ({
    status: 202,
    body: {
      ok: true,
      processing: true,
      requestId: job.requestId,
      action: job.action,
      phase: job.phase,
      ...(job.hash ? { hash: job.hash } : {}),
    },
  });

  const start = (input) => {
    const runId = assertDemoRunId(input.runId);
    const requestId = parseDemoRequestId(input.requestId);
    const action = assertDemoAction(input.action);
    const key = String(requestId);
    const existing = jobs.get(key);
    if (existing) {
      if (existing.runId !== runId) {
        throw new DemoDecisionError(409, 'request already has a decision from another run in progress');
      }
      if (existing.action !== action) {
        throw new DemoDecisionError(409, `request already has a ${existing.action} decision in progress`);
      }
      return existing;
    }
    const job = {
      runId,
      action,
      requestId: Number(requestId),
      phase: 'validating',
      hash: undefined,
      result: undefined,
      delivered: false,
      promise: undefined,
      cleanup: undefined,
    };
    const report = async (progress = {}) => {
      if (typeof progress.phase === 'string') job.phase = progress.phase;
      if (typeof progress.hash === 'string') job.hash = progress.hash;
    };
    jobs.set(key, job);
    job.promise = Promise.resolve()
      .then(() => perform({ runId, requestId, action }, report))
      .then((body) => {
        job.phase = 'settled';
        job.hash = body.hash;
        job.result = { status: 200, body };
      })
      .catch((error) => {
        job.result = { status: error?.status ?? 500, body: errorPayload(error) };
      });
    // Retention starts only after the job settles. A slow decrypt, Safe
    // broadcast or receipt wait must never be evicted while it is processing,
    // otherwise polling could start a second recovery job for the same request.
    job.promise.finally(() => {
      job.cleanup = setTimeout(() => {
        if (jobs.get(key) === job) jobs.delete(key);
      }, Math.min(decisionWindowMs, 300_000));
      job.cleanup.unref?.();
    }).catch(() => {});
    return job;
  };

  const handle = async (input) => {
    try {
      const job = start(input);
      if (!job.result) return snapshot(job);
      if (job.result.status !== 200) {
        if (job.cleanup) clearTimeout(job.cleanup);
        jobs.delete(String(job.requestId));
        return job.result;
      }
      const result = job.delivered
        ? { ...job.result, body: { ...job.result.body, idempotent: true } }
        : job.result;
      job.delivered = true;
      return result;
    } catch (error) {
      return { status: error?.status ?? 500, body: errorPayload(error) };
    }
  };

  /**
   * Read-only decision attestation. Public chain state=5 proves cancellation,
   * not who selected it. Only a matching persisted user receipt may upgrade
   * that outcome to an explicit user Reject.
   */
  const attest = async (input) => {
    try {
      const runId = assertDemoRunId(input.runId);
      const requestId = parseDemoRequestId(input.requestId);
      const request = await readRequest(requestId);
      assertIdentity(request, runId);
      const chainState = Number(request[5]);
      const entry = await store.get(requestId);

      let origin = 'unknown';
      let action;
      let hash;
      let recordedAt;
      if (entry?.receipt?.origin === 'timeout') {
        origin = 'timeout';
        hash = entry.receipt.hash;
        recordedAt = entry.receipt.recordedAt;
      } else if (
        (chainState === 2 && matchingUserReceipt(entry, runId, 'approve', 'safe-approved'))
        || (chainState === 5 && matchingUserReceipt(entry, runId, 'reject', 'safe-rejected'))
      ) {
        origin = 'user';
        action = entry.receipt.action;
        hash = entry.receipt.hash;
        recordedAt = entry.receipt.recordedAt;
      }

      return {
        status: 200,
        body: {
          ok: true,
          requestId: Number(requestId),
          chainState,
          origin,
          ...(action ? { action } : {}),
          ...(hash ? { hash } : {}),
          ...(Number.isFinite(recordedAt) ? { recordedAt } : {}),
        },
      };
    } catch (error) {
      return { status: error?.status ?? 500, body: errorPayload(error, 'decision attestation failed') };
    }
  };

  const expire = async ({ requestId: value, windowMs = decisionWindowMs }) => {
    const requestId = parseDemoRequestId(value);
    if (!Number.isFinite(windowMs) || windowMs < 1) throw new Error('windowMs must be positive');
    return withSafeLock(async () => {
      const current = await readRequest(requestId);
      if (Number(current[5]) !== 3) {
        return { skipped: 'not-awaiting-approval', state: Number(current[5]) };
      }
      const entry = await store.get(requestId);
      if (entry?.receipt?.origin === 'timeout') {
        return { skipped: 'timeout-recorded', hash: entry.receipt.hash, origin: 'timeout' };
      }
      if (entry?.receipt?.origin === 'user') {
        return { skipped: 'user-decision-recorded', hash: entry.receipt.hash, origin: 'user' };
      }
      if (entry?.intent?.hash) {
        // A run-bound decision crossed the broadcast boundary before this
        // watchdog acquired the shared Safe lock. Never submit a competing
        // timeout cancellation; the browser/recovery path will reconcile it.
        return {
          skipped: 'decision-broadcast-pending',
          hash: entry.intent.hash,
          action: entry.intent.action,
        };
      }
      const awaitingSince = await store.observeAwaiting(requestId, now());
      const age = now() - awaitingSince;
      if (age < windowMs) return { skipped: 'not-expired', awaitingSince };
      const hash = await executeUnlocked(requestId, 'reject');
      await store.recordTimeoutReceipt(requestId, {
        hash,
        state: 'safe-rejected',
        recordedAt: now(),
      });
      return { ok: true, requestId: Number(requestId), hash, state: 'safe-rejected', origin: 'timeout' };
    });
  };

  return {
    jobs,
    get processingCount() {
      return [...jobs.values()].filter((job) => !job.result).length;
    },
    start,
    handle,
    attest,
    expire,
  };
}
