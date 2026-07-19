import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertDemoScenarioIdentity,
  createDemoDecisionService,
  createFileDecisionStore,
  createMemoryDecisionStore,
  verifyDemoAmount,
} from '../lib/demo-decision.mjs';
import { buildDemoMemoHash, createSerialExecutor } from '../lib/demo-security.mjs';

const CHAIN_ID = 11155111n;
const MODULE = '0x02e9b09f5929604b101244661835605b1ee67fea';
const DELEGATE = '0x17ee5ad7e4b40cadafad27c5f68f74d02c7fd532';
const OTHER_DELEGATE = '0xdfc0c6e0baed0948d8ba22a4917438938f2a40f4';
const RECIPIENT = '0xe32148e45c3b1f8a692bec3baa0079ad103a4c6b';
const OTHER_RECIPIENT = '0x6152f8ebe4e9b35c5042e095fc0e4af98c6a347d';
const RUN_ID = 'run_12345678';
const REQUEST_ID = 7n;
const MANDATE_ID = 42n;
const AMOUNT = 60_000_000n;
const WINDOW_MS = 180_000;
const NOW = 1_800_000_000_000;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function settleDecision(service, input, limit = 200) {
  for (let attempt = 0; attempt < limit; attempt++) {
    const response = await service.handle(input);
    if (response.status !== 202) return response;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const pending = [...service.jobs.values()].map(({ requestId, action, phase, result }) => ({
    requestId, action, phase, result,
  }));
  throw new Error(`decision did not settle within the test poll limit: ${JSON.stringify(pending)}`);
}

function makeHarness({
  runId = RUN_ID,
  memo,
  delegate = DELEGATE,
  recipient = RECIPIENT,
  state = 3,
  ageMs = 30_000,
  decryptedAmount = AMOUNT,
  decryptError,
  financeAdminError,
  execute,
  recover,
  now = NOW,
  store = createMemoryDecisionStore(),
  decisionWindowMs = WINDOW_MS,
} = {}) {
  let currentNow = now;
  const request = [
    MANDATE_ID,
    delegate,
    recipient,
    memo ?? buildDemoMemoHash({
      chainId: CHAIN_ID,
      module: MODULE,
      runId,
      scenario: 'approval',
      mandateId: MANDATE_ID,
      delegate,
    }),
    BigInt(Math.floor((now - ageMs) / 1000)),
    state,
    '0xencrypted-amount',
    '0xencrypted-decision',
  ];
  const executions = [];
  const spec = { delegate: DELEGATE, recipient: RECIPIENT, amount: AMOUNT };
  const service = createDemoDecisionService({
    readRequest: async () => [...request],
    assertIdentity: (value, candidateRunId) => assertDemoScenarioIdentity({
      request: value,
      runId: candidateRunId,
      scenarioName: 'approval',
      spec,
      chainId: CHAIN_ID,
      module: MODULE,
    }),
    verifyAmount: (value, candidateSpec) => verifyDemoAmount({
      request: value,
      spec: candidateSpec,
      assertFinanceAdmin: async () => {
        if (financeAdminError) throw financeAdminError;
      },
      decryptAmount: async () => {
        if (decryptError) throw decryptError;
        return decryptedAmount;
      },
    }),
    readActiveMandate: async () => MANDATE_ID,
    executeUnlocked: async (id, action, report) => {
      executions.push({ id, action });
      await report?.({ phase: 'broadcasting' });
      const hash = execute
        ? await execute({ id, action, request, report })
        : `0x${action === 'approve' ? 'a' : 'b'}`;
      await report?.({ phase: 'confirming', hash });
      request[5] = action === 'approve' ? 2 : 5;
      return hash;
    },
    recoverBroadcast: recover ?? (async () => {}),
    withSafeLock: createSerialExecutor(),
    store,
    decisionWindowMs,
    now: () => currentNow,
  });
  return {
    service,
    request,
    executions,
    store,
    setNow(value) { currentNow = value; },
  };
}

test('decision authorization binds run, memo, delegate, recipient and decrypted amount', async (t) => {
  await t.test('rejects malformed and mismatched run ids', async () => {
    const malformed = makeHarness();
    assert.equal((await settleDecision(malformed.service, { runId: 'short', requestId: REQUEST_ID, action: 'approve' })).status, 400);

    const mismatched = makeHarness();
    const response = await settleDecision(mismatched.service, { runId: 'run_87654321', requestId: REQUEST_ID, action: 'approve' });
    assert.equal(response.status, 403);
    assert.match(response.body.error, /not bound to this demo run/);
    assert.equal(mismatched.executions.length, 0);
  });

  await t.test('rejects a memo that does not commit to the request mandate', async () => {
    const wrongMemo = buildDemoMemoHash({
      chainId: CHAIN_ID,
      module: MODULE,
      runId: RUN_ID,
      scenario: 'approval',
      mandateId: 99n,
      delegate: DELEGATE,
    });
    const harness = makeHarness({ memo: wrongMemo });
    const response = await settleDecision(harness.service, { runId: RUN_ID, requestId: REQUEST_ID, action: 'approve' });
    assert.equal(response.status, 403);
    assert.equal(harness.executions.length, 0);
  });

  await t.test('rejects a recipient outside the ShieldOps scenario', async () => {
    const harness = makeHarness({ recipient: OTHER_RECIPIENT });
    const response = await settleDecision(harness.service, { runId: RUN_ID, requestId: REQUEST_ID, action: 'approve' });
    assert.equal(response.status, 403);
    assert.match(response.body.error, /recipient/);
    assert.equal(harness.executions.length, 0);
  });

  await t.test('rejects a request owned by the isolated blocked-scenario delegate', async () => {
    const harness = makeHarness({ delegate: OTHER_DELEGATE });
    const response = await settleDecision(harness.service, { runId: RUN_ID, requestId: REQUEST_ID, action: 'approve' });
    assert.equal(response.status, 403);
    assert.match(response.body.error, /not owned/);
    assert.equal(harness.executions.length, 0);
  });

  await t.test('rejects a decrypted amount outside the exact 60 cUSDC scenario', async () => {
    const harness = makeHarness({ decryptedAmount: AMOUNT + 1n });
    const response = await settleDecision(harness.service, { runId: RUN_ID, requestId: REQUEST_ID, action: 'approve' });
    assert.equal(response.status, 403);
    assert.match(response.body.error, /decrypted amount/);
    assert.equal(harness.executions.length, 0);
  });
});

test('decryption or finance-admin verification failure returns 503 and never signs', async (t) => {
  for (const [name, options] of [
    ['decrypt unavailable', { decryptError: new Error('gateway unavailable') }],
    ['finance admin mismatch', { financeAdminError: new Error('wrong finance admin') }],
  ]) {
    await t.test(name, async () => {
      const harness = makeHarness(options);
      const response = await settleDecision(harness.service, { runId: RUN_ID, requestId: REQUEST_ID, action: 'approve' });
      assert.equal(response.status, 503);
      assert.match(response.body.error, /could not decrypt and verify/);
      assert.equal(harness.executions.length, 0);
      assert.equal((await harness.store.get(REQUEST_ID)).awaitingSince, NOW);
    });
  }
});

test('same-direction work returns 202 while the opposite action returns 409', async () => {
  const entered = deferred();
  const release = deferred();
  const harness = makeHarness({
    execute: async ({ action }) => {
      entered.resolve();
      await release.promise;
      return `0x${action === 'approve' ? 'a' : 'b'}`;
    },
  });

  const first = await harness.service.handle({ runId: RUN_ID, requestId: REQUEST_ID, action: 'approve' });
  assert.equal(first.status, 202);
  assert.equal(first.body.phase, 'validating');
  await entered.promise;

  const retry = await harness.service.handle({ runId: RUN_ID, requestId: REQUEST_ID, action: 'approve' });
  assert.equal(retry.status, 202);
  assert.equal(retry.body.processing, true);

  const opposite = await harness.service.handle({ runId: RUN_ID, requestId: REQUEST_ID, action: 'reject' });
  assert.equal(opposite.status, 409);
  assert.match(opposite.body.error, /approve decision in progress/);

  release.resolve();
  const completed = await settleDecision(harness.service, { runId: RUN_ID, requestId: REQUEST_ID, action: 'approve' });
  assert.equal(completed.status, 200);
  assert.equal(completed.body.idempotent, false);

  const idempotent = await harness.service.handle({ runId: RUN_ID, requestId: REQUEST_ID, action: 'approve' });
  assert.equal(idempotent.status, 200);
  assert.equal(idempotent.body.idempotent, true);

  const conflict = await harness.service.handle({ runId: RUN_ID, requestId: REQUEST_ID, action: 'reject' });
  assert.equal(conflict.status, 409);
  assert.equal(harness.executions.length, 1);
});

test('processing snapshots expose and persist the Safe hash before receipt confirmation', async () => {
  const broadcasted = deferred();
  const releaseReceipt = deferred();
  const hash = '0xbroadcast';
  const harness = makeHarness({
    execute: async ({ report }) => {
      await report({ phase: 'confirming', hash });
      broadcasted.resolve();
      await releaseReceipt.promise;
      return hash;
    },
  });

  const accepted = await harness.service.handle({ runId: RUN_ID, requestId: REQUEST_ID, action: 'approve' });
  assert.equal(accepted.status, 202);
  await broadcasted.promise;

  const processing = await harness.service.handle({ runId: RUN_ID, requestId: REQUEST_ID, action: 'approve' });
  assert.equal(processing.status, 202);
  assert.equal(processing.body.phase, 'confirming');
  assert.equal(processing.body.hash, hash);
  const journalBeforeReceipt = await harness.store.get(REQUEST_ID);
  assert.equal(journalBeforeReceipt.intent.hash, hash);
  assert.equal(journalBeforeReceipt.receipt, undefined);

  releaseReceipt.resolve();
  const completed = await settleDecision(harness.service, { runId: RUN_ID, requestId: REQUEST_ID, action: 'approve' });
  assert.equal(completed.status, 200);
  assert.equal(completed.body.hash, hash);
  assert.equal((await harness.store.get(REQUEST_ID)).receipt.hash, hash);
});

test('a persisted broadcast is recovered after service recreation without a second Safe execution', async () => {
  const store = createMemoryDecisionStore();
  const hash = '0xrecoverable';
  const interrupted = makeHarness({
    store,
    execute: async ({ report }) => {
      await report({ phase: 'confirming', hash });
      throw new Error('receipt transport timed out');
    },
  });
  const failed = await settleDecision(interrupted.service, { runId: RUN_ID, requestId: REQUEST_ID, action: 'approve' });
  assert.equal(failed.status, 503);
  assert.equal(failed.body.details.hash, hash);
  assert.equal((await store.get(REQUEST_ID)).intent.hash, hash);

  let recoveredHash;
  const restarted = makeHarness({
    state: 2,
    store,
    decryptError: new Error('Nox temporarily unavailable'),
    recover: async (candidate) => { recoveredHash = candidate; },
  });
  const recovered = await settleDecision(restarted.service, { runId: RUN_ID, requestId: REQUEST_ID, action: 'approve' });
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.recovered, true);
  assert.equal(recovered.body.hash, hash);
  assert.equal(recoveredHash, hash);
  assert.equal(restarted.executions.length, 0);
});

test('a persisted terminal receipt remains idempotent while Nox decryption is unavailable', async () => {
  const store = createMemoryDecisionStore();
  await store.recordIntent(REQUEST_ID, { runId: RUN_ID, action: 'approve', recordedAt: NOW - 2_000 });
  await store.recordUserReceipt(REQUEST_ID, {
    runId: RUN_ID,
    action: 'approve',
    hash: '0xapproved',
    state: 'safe-approved',
    recordedAt: NOW - 1_000,
  });
  const harness = makeHarness({
    state: 2,
    store,
    decryptError: new Error('Nox temporarily unavailable'),
  });

  const response = await settleDecision(harness.service, {
    runId: RUN_ID,
    requestId: REQUEST_ID,
    action: 'approve',
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.idempotent, true);
  assert.equal(response.body.hash, '0xapproved');
  assert.equal(harness.executions.length, 0);
});

test('read-only decision attestation never infers user Reject from state=5 alone', async () => {
  const harness = makeHarness({
    state: 5,
    decryptError: new Error('attestation must not decrypt'),
    financeAdminError: new Error('attestation must not inspect finance admin'),
  });
  const response = await harness.service.attest({ runId: RUN_ID, requestId: REQUEST_ID });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    ok: true,
    requestId: Number(REQUEST_ID),
    chainState: 5,
    origin: 'unknown',
  });
  assert.equal(harness.executions.length, 0);
});

test('decision attestation exposes only matching persisted user or timeout origin', async (t) => {
  await t.test('matching user rejection receipt', async () => {
    const store = createMemoryDecisionStore();
    await store.recordIntent(REQUEST_ID, { runId: RUN_ID, action: 'reject', recordedAt: NOW - 2_000 });
    await store.recordUserReceipt(REQUEST_ID, {
      runId: RUN_ID,
      action: 'reject',
      hash: '0xuser-reject',
      state: 'safe-rejected',
      recordedAt: NOW - 1_000,
    });
    const response = await makeHarness({ state: 5, store }).service.attest({ runId: RUN_ID, requestId: REQUEST_ID });
    assert.deepEqual(response, {
      status: 200,
      body: {
        ok: true,
        requestId: Number(REQUEST_ID),
        chainState: 5,
        origin: 'user',
        action: 'reject',
        hash: '0xuser-reject',
        recordedAt: NOW - 1_000,
      },
    });
  });

  await t.test('watchdog timeout receipt', async () => {
    const store = createMemoryDecisionStore();
    await store.recordTimeoutReceipt(REQUEST_ID, {
      hash: '0xtimeout',
      state: 'safe-rejected',
      recordedAt: NOW,
    });
    const response = await makeHarness({ state: 5, store }).service.attest({ runId: RUN_ID, requestId: REQUEST_ID });
    assert.equal(response.status, 200);
    assert.equal(response.body.origin, 'timeout');
    assert.equal(response.body.action, undefined);
    assert.equal(response.body.hash, '0xtimeout');
  });

  await t.test('wrong run is rejected by memo identity before journal disclosure', async () => {
    const store = createMemoryDecisionStore();
    await store.recordIntent(REQUEST_ID, { runId: RUN_ID, action: 'reject', recordedAt: NOW - 2_000 });
    await store.recordUserReceipt(REQUEST_ID, {
      runId: RUN_ID,
      action: 'reject',
      hash: '0xprivate-to-run',
      state: 'safe-rejected',
      recordedAt: NOW - 1_000,
    });
    const response = await makeHarness({ state: 5, store }).service.attest({
      runId: 'run_87654321',
      requestId: REQUEST_ID,
    });
    assert.equal(response.status, 403);
    assert.equal(response.body.hash, undefined);
  });
});

test('an opposite action conflicts with a persisted broadcast before Nox decryption', async () => {
  const store = createMemoryDecisionStore();
  await store.recordIntent(REQUEST_ID, { runId: RUN_ID, action: 'approve', recordedAt: NOW - 2_000 });
  await store.recordBroadcast(REQUEST_ID, {
    runId: RUN_ID,
    action: 'approve',
    hash: '0xpending',
    broadcastAt: NOW - 1_000,
  });
  const harness = makeHarness({
    store,
    decryptError: new Error('Nox temporarily unavailable'),
  });

  const response = await settleDecision(harness.service, {
    runId: RUN_ID,
    requestId: REQUEST_ID,
    action: 'reject',
  });
  assert.equal(response.status, 409);
  assert.match(response.body.error, /approve decision in progress/);
  assert.equal(harness.executions.length, 0);
});

test('a processing decision job is not evicted by its decision-window retention timer', async () => {
  const entered = deferred();
  const release = deferred();
  const harness = makeHarness({
    decisionWindowMs: 10,
    execute: async () => {
      entered.resolve();
      await release.promise;
      return '0xslow';
    },
  });

  const accepted = await harness.service.handle({ runId: RUN_ID, requestId: REQUEST_ID, action: 'approve' });
  assert.equal(accepted.status, 202);
  await entered.promise;
  await new Promise((resolve) => setTimeout(resolve, 30));

  const retry = await harness.service.handle({ runId: RUN_ID, requestId: REQUEST_ID, action: 'approve' });
  assert.equal(retry.status, 202);
  assert.equal(retry.body.phase, 'broadcasting');
  assert.equal(harness.service.jobs.size, 1);
  assert.equal(harness.executions.length, 1);

  release.resolve();
  const completed = await settleDecision(harness.service, {
    runId: RUN_ID,
    requestId: REQUEST_ID,
    action: 'approve',
  });
  assert.equal(completed.status, 200);
  assert.equal(harness.executions.length, 1);
});

test('TEE processing time does not consume the human decision window', async () => {
  const harness = makeHarness({ ageMs: 10 * WINDOW_MS });
  const response = await settleDecision(harness.service, { runId: RUN_ID, requestId: REQUEST_ID, action: 'approve' });
  assert.equal(response.status, 200);
  assert.equal(response.body.state, 'safe-approved');
  assert.equal((await harness.store.get(REQUEST_ID)).awaitingSince, NOW);
  assert.deepEqual(harness.executions.map(({ action }) => action), ['approve']);
});

test('watchdog expiry starts at its first persisted state=3 observation', async () => {
  const harness = makeHarness({ ageMs: 10 * WINDOW_MS });
  const observed = await harness.service.expire({ requestId: REQUEST_ID, windowMs: WINDOW_MS });
  assert.equal(observed.skipped, 'not-expired');
  assert.equal(observed.awaitingSince, NOW);
  assert.equal(harness.executions.length, 0);

  harness.setNow(NOW + WINDOW_MS - 1);
  const stillOpen = await harness.service.expire({ requestId: REQUEST_ID, windowMs: WINDOW_MS });
  assert.equal(stillOpen.skipped, 'not-expired');
  assert.equal(stillOpen.awaitingSince, NOW);

  harness.setNow(NOW + WINDOW_MS);
  const expired = await harness.service.expire({ requestId: REQUEST_ID, windowMs: WINDOW_MS });
  assert.equal(expired.ok, true);
  assert.equal(expired.origin, 'timeout');
  assert.deepEqual(harness.executions.map(({ action }) => action), ['reject']);
});

test('watchdog never blindly rejects a persisted decision broadcast', async () => {
  const store = createMemoryDecisionStore();
  await store.observeAwaiting(REQUEST_ID, NOW - WINDOW_MS - 1_000);
  await store.recordIntent(REQUEST_ID, { runId: RUN_ID, action: 'approve', recordedAt: NOW - 3_000 });
  await store.recordBroadcast(REQUEST_ID, {
    runId: RUN_ID,
    action: 'approve',
    hash: '0xpending-approval',
    broadcastAt: NOW - 2_000,
  });
  const harness = makeHarness({ store });

  const expired = await harness.service.expire({ requestId: REQUEST_ID, windowMs: WINDOW_MS });
  assert.equal(expired.skipped, 'decision-broadcast-pending');
  assert.equal(expired.hash, '0xpending-approval');
  assert.equal(expired.action, 'approve');
  assert.equal(harness.executions.length, 0);
  assert.equal((await store.get(REQUEST_ID)).receipt, undefined);
});

test('restart recovery and watchdog expiry share the Safe critical section', async () => {
  const store = createMemoryDecisionStore();
  await store.observeAwaiting(REQUEST_ID, NOW - WINDOW_MS - 1_000);
  await store.recordIntent(REQUEST_ID, { runId: RUN_ID, action: 'approve', recordedAt: NOW - 3_000 });
  await store.recordBroadcast(REQUEST_ID, {
    runId: RUN_ID,
    action: 'approve',
    hash: '0xrecovering-approval',
    broadcastAt: NOW - 2_000,
  });
  const recoveryEntered = deferred();
  const releaseRecovery = deferred();
  let harness;
  harness = makeHarness({
    store,
    recover: async () => {
      recoveryEntered.resolve();
      await releaseRecovery.promise;
      harness.request[5] = 2;
    },
  });

  const accepted = await harness.service.handle({ runId: RUN_ID, requestId: REQUEST_ID, action: 'approve' });
  assert.equal(accepted.status, 202);
  await recoveryEntered.promise;

  let watchdogSettled = false;
  const watchdog = harness.service.expire({ requestId: REQUEST_ID, windowMs: WINDOW_MS })
    .then((value) => { watchdogSettled = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(watchdogSettled, false);

  releaseRecovery.resolve();
  const watchdogResult = await watchdog;
  const recovered = await settleDecision(harness.service, {
    runId: RUN_ID,
    requestId: REQUEST_ID,
    action: 'approve',
  });
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.recovered, true);
  assert.equal(watchdogResult.skipped, 'not-awaiting-approval');
  assert.equal(harness.executions.length, 0);
});

test('an expired user decision is cancelled and remains 410 on Reject retry', async () => {
  const harness = makeHarness();
  await harness.store.observeAwaiting(REQUEST_ID, NOW - WINDOW_MS - 1_000);
  const expired = await settleDecision(harness.service, { runId: RUN_ID, requestId: REQUEST_ID, action: 'approve' });
  assert.equal(expired.status, 410);
  assert.equal(expired.body.details.origin, 'timeout');
  assert.deepEqual(harness.executions.map(({ action }) => action), ['reject']);

  const retry = await settleDecision(harness.service, { runId: RUN_ID, requestId: REQUEST_ID, action: 'reject' });
  assert.equal(retry.status, 410);
  assert.equal(retry.body.details.origin, 'timeout');
  assert.equal(harness.executions.length, 1);

  harness.request[5] = 3; // stale RPC observation after the confirmed timeout
  const staleRetry = await settleDecision(harness.service, { runId: RUN_ID, requestId: REQUEST_ID, action: 'reject' });
  assert.equal(staleRetry.status, 410);
  assert.equal(staleRetry.body.details.origin, 'timeout');
  assert.equal(harness.executions.length, 1);

  const journal = await harness.store.get(REQUEST_ID);
  assert.equal(journal.intent, undefined);
  assert.equal(journal.receipt.origin, 'timeout');
});

test('external state=5 without a receipt is 409 regardless of request age', async () => {
  const harness = makeHarness({ state: 5, ageMs: 10 * WINDOW_MS });
  await harness.store.observeAwaiting(REQUEST_ID, NOW - 10 * WINDOW_MS);
  const response = await settleDecision(harness.service, { runId: RUN_ID, requestId: REQUEST_ID, action: 'reject' });
  assert.equal(response.status, 409);
  assert.match(response.body.error, /no matching user rejection receipt/);
  assert.equal(response.body.details, undefined);
  assert.equal(harness.executions.length, 0);
});

test('Safe serialization makes a user decision win before a queued timeout', async () => {
  const entered = deferred();
  const release = deferred();
  const harness = makeHarness({
    execute: async ({ action }) => {
      assert.equal(action, 'approve');
      entered.resolve();
      await release.promise;
      return '0xapproved';
    },
  });
  await harness.store.observeAwaiting(REQUEST_ID, NOW - WINDOW_MS + 1_000);

  const accepted = await harness.service.handle({ runId: RUN_ID, requestId: REQUEST_ID, action: 'approve' });
  assert.equal(accepted.status, 202);
  await entered.promise;
  // The action crossed the deadline only after it acquired the Safe lock.
  harness.setNow(NOW + 2_000);
  const timeout = harness.service.expire({ requestId: REQUEST_ID, windowMs: WINDOW_MS });

  release.resolve();
  const timeoutResult = await timeout;
  const decisionResult = await settleDecision(harness.service, { runId: RUN_ID, requestId: REQUEST_ID, action: 'approve' });
  assert.equal(decisionResult.status, 200);
  assert.equal(timeoutResult.skipped, 'not-awaiting-approval');
  assert.equal(harness.request[5], 2);
  assert.deepEqual(harness.executions.map(({ action }) => action), ['approve']);
});

test('Safe serialization makes a timeout win before a queued user decision', async () => {
  const entered = deferred();
  const release = deferred();
  const harness = makeHarness({
    execute: async ({ action }) => {
      assert.equal(action, 'reject');
      entered.resolve();
      await release.promise;
      return '0xtimeout';
    },
  });
  await harness.store.observeAwaiting(REQUEST_ID, NOW - WINDOW_MS - 1_000);

  const timeout = harness.service.expire({ requestId: REQUEST_ID, windowMs: WINDOW_MS });
  await entered.promise;
  const accepted = await harness.service.handle({ runId: RUN_ID, requestId: REQUEST_ID, action: 'reject' });
  assert.equal(accepted.status, 202);
  release.resolve();

  const timeoutResult = await timeout;
  const decisionResult = await settleDecision(harness.service, { runId: RUN_ID, requestId: REQUEST_ID, action: 'reject' });
  assert.equal(timeoutResult.ok, true);
  assert.equal(timeoutResult.origin, 'timeout');
  assert.equal(decisionResult.status, 410);
  assert.equal(decisionResult.body.details.origin, 'timeout');
  assert.equal(harness.request[5], 5);
  assert.deepEqual(harness.executions.map(({ action }) => action), ['reject']);
});

test('file decision journal preserves idempotency across service recreation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'veilguard-decisions-'));
  const journalPath = join(directory, 'decisions.json');
  try {
    const first = createFileDecisionStore(journalPath);
    await first.observeAwaiting(REQUEST_ID, NOW - 1_000);
    await first.recordIntent(REQUEST_ID, { runId: RUN_ID, action: 'reject', recordedAt: 1 });
    await first.recordUserReceipt(REQUEST_ID, {
      runId: RUN_ID,
      action: 'reject',
      hash: '0xreceipt',
      state: 'safe-rejected',
      recordedAt: 2,
    });

    const reloadedStore = createFileDecisionStore(journalPath);
    assert.deepEqual(await reloadedStore.get(REQUEST_ID), {
      awaitingSince: NOW - 1_000,
      intent: { runId: RUN_ID, action: 'reject', recordedAt: 1 },
      receipt: {
        runId: RUN_ID,
        action: 'reject',
        hash: '0xreceipt',
        state: 'safe-rejected',
        recordedAt: 2,
        origin: 'user',
      },
    });

    const restarted = makeHarness({ state: 5, store: reloadedStore });
    const response = await settleDecision(restarted.service, {
      runId: RUN_ID,
      requestId: REQUEST_ID,
      action: 'reject',
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.idempotent, true);
    assert.equal(response.body.hash, '0xreceipt');
    assert.equal(restarted.executions.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('persisted awaiting timestamp enforces the same window after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'veilguard-window-'));
  const journalPath = join(directory, 'decisions.json');
  try {
    await createFileDecisionStore(journalPath).observeAwaiting(REQUEST_ID, NOW - WINDOW_MS - 1_000);
    const restarted = makeHarness({
      ageMs: 1,
      store: createFileDecisionStore(journalPath),
    });
    const response = await settleDecision(restarted.service, {
      runId: RUN_ID,
      requestId: REQUEST_ID,
      action: 'approve',
    });
    assert.equal(response.status, 410);
    assert.equal(response.body.details.origin, 'timeout');
    assert.deepEqual(restarted.executions.map(({ action }) => action), ['reject']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
