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
  now = NOW,
  store = createMemoryDecisionStore(),
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
    executeUnlocked: async (id, action) => {
      executions.push({ id, action });
      const hash = execute
        ? await execute({ id, action, request })
        : `0x${action === 'approve' ? 'a' : 'b'}`;
      request[5] = action === 'approve' ? 2 : 5;
      return hash;
    },
    withSafeLock: createSerialExecutor(),
    store,
    decisionWindowMs: WINDOW_MS,
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
    assert.equal((await malformed.service.handle({ runId: 'short', requestId: REQUEST_ID, action: 'approve' })).status, 400);

    const mismatched = makeHarness();
    const response = await mismatched.service.handle({ runId: 'run_87654321', requestId: REQUEST_ID, action: 'approve' });
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
    const response = await harness.service.handle({ runId: RUN_ID, requestId: REQUEST_ID, action: 'approve' });
    assert.equal(response.status, 403);
    assert.equal(harness.executions.length, 0);
  });

  await t.test('rejects a recipient outside the ShieldOps scenario', async () => {
    const harness = makeHarness({ recipient: OTHER_RECIPIENT });
    const response = await harness.service.handle({ runId: RUN_ID, requestId: REQUEST_ID, action: 'approve' });
    assert.equal(response.status, 403);
    assert.match(response.body.error, /recipient/);
    assert.equal(harness.executions.length, 0);
  });

  await t.test('rejects a request owned by the isolated blocked-scenario delegate', async () => {
    const harness = makeHarness({ delegate: OTHER_DELEGATE });
    const response = await harness.service.handle({ runId: RUN_ID, requestId: REQUEST_ID, action: 'approve' });
    assert.equal(response.status, 403);
    assert.match(response.body.error, /not owned/);
    assert.equal(harness.executions.length, 0);
  });

  await t.test('rejects a decrypted amount outside the exact 60 cUSDC scenario', async () => {
    const harness = makeHarness({ decryptedAmount: AMOUNT + 1n });
    const response = await harness.service.handle({ runId: RUN_ID, requestId: REQUEST_ID, action: 'approve' });
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
      const response = await harness.service.handle({ runId: RUN_ID, requestId: REQUEST_ID, action: 'approve' });
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

  const first = harness.service.handle({ runId: RUN_ID, requestId: REQUEST_ID, action: 'approve' });
  await entered.promise;

  const retry = await harness.service.handle({ runId: RUN_ID, requestId: REQUEST_ID, action: 'approve' });
  assert.equal(retry.status, 202);
  assert.equal(retry.body.processing, true);

  const opposite = await harness.service.handle({ runId: RUN_ID, requestId: REQUEST_ID, action: 'reject' });
  assert.equal(opposite.status, 409);
  assert.match(opposite.body.error, /approve decision in progress/);

  release.resolve();
  const completed = await first;
  assert.equal(completed.status, 200);
  assert.equal(completed.body.idempotent, false);

  const idempotent = await harness.service.handle({ runId: RUN_ID, requestId: REQUEST_ID, action: 'approve' });
  assert.equal(idempotent.status, 200);
  assert.equal(idempotent.body.idempotent, true);

  const conflict = await harness.service.handle({ runId: RUN_ID, requestId: REQUEST_ID, action: 'reject' });
  assert.equal(conflict.status, 409);
  assert.equal(harness.executions.length, 1);
});

test('TEE processing time does not consume the human decision window', async () => {
  const harness = makeHarness({ ageMs: 10 * WINDOW_MS });
  const response = await harness.service.handle({ runId: RUN_ID, requestId: REQUEST_ID, action: 'approve' });
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

test('an expired user decision is cancelled and remains 410 on Reject retry', async () => {
  const harness = makeHarness();
  await harness.store.observeAwaiting(REQUEST_ID, NOW - WINDOW_MS - 1_000);
  const expired = await harness.service.handle({ runId: RUN_ID, requestId: REQUEST_ID, action: 'approve' });
  assert.equal(expired.status, 410);
  assert.equal(expired.body.details.origin, 'timeout');
  assert.deepEqual(harness.executions.map(({ action }) => action), ['reject']);

  const retry = await harness.service.handle({ runId: RUN_ID, requestId: REQUEST_ID, action: 'reject' });
  assert.equal(retry.status, 410);
  assert.equal(retry.body.details.origin, 'timeout');
  assert.equal(harness.executions.length, 1);

  harness.request[5] = 3; // stale RPC observation after the confirmed timeout
  const staleRetry = await harness.service.handle({ runId: RUN_ID, requestId: REQUEST_ID, action: 'reject' });
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
  const response = await harness.service.handle({ runId: RUN_ID, requestId: REQUEST_ID, action: 'reject' });
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

  const decision = harness.service.handle({ runId: RUN_ID, requestId: REQUEST_ID, action: 'approve' });
  await entered.promise;
  // The action crossed the deadline only after it acquired the Safe lock.
  harness.setNow(NOW + 2_000);
  const timeout = harness.service.expire({ requestId: REQUEST_ID, windowMs: WINDOW_MS });

  release.resolve();
  const [decisionResult, timeoutResult] = await Promise.all([decision, timeout]);
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
  const decision = harness.service.handle({ runId: RUN_ID, requestId: REQUEST_ID, action: 'reject' });
  release.resolve();

  const [timeoutResult, decisionResult] = await Promise.all([timeout, decision]);
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
    const response = await restarted.service.handle({
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
    const response = await restarted.service.handle({
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
