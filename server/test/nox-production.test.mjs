import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NoxProductionError,
  resolveThenRetryNoxRead,
  waitUntilNoxSimulatable,
} from '../lib/nox-production.mjs';

const handle = `0x${'12'.repeat(32)}`;

const response = (resolved) => ({
  ok: true,
  json: async () => ({
    payload: { statuses: [{ handle, resolved }] },
  }),
});

test('public decrypt waits for resolution and then retries actual usability', async () => {
  const order = [];
  let statusAttempts = 0;
  let readAttempts = 0;
  let clock = 0;
  const result = await resolveThenRetryNoxRead({
    statusUrl: 'https://gateway.example/status',
    handles: [handle],
    label: 'keeper public decrypt',
    operation: async () => {
      order.push('read');
      readAttempts += 1;
      if (readAttempts < 3) throw new Error('downstream not ready');
      return { decryptionProof: '0x1234' };
    },
    resolution: {
      fetchImpl: async () => {
        order.push('status');
        statusAttempts += 1;
        return response(statusAttempts >= 2);
      },
      timeoutMs: 10,
      intervalMs: 1,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    },
    usability: {
      timeoutMs: 10,
      intervalMs: 1,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    },
  });

  assert.deepEqual(result, { decryptionProof: '0x1234' });
  assert.deepEqual(order, ['status', 'status', 'read', 'read', 'read']);
});

test('simulation retries only the supplied read-only preflight', async () => {
  let attempts = 0;
  let clock = 0;
  const gas = await waitUntilNoxSimulatable(
    'exact proposeMandate estimate',
    async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('input proof not propagated');
      return 123_456n;
    },
    {
      timeoutMs: 10,
      intervalMs: 1,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    },
  );
  assert.equal(gas, 123_456n);
  assert.equal(attempts, 3);
});

test('timeout errors redact handle-like values and never retain source causes', async () => {
  let clock = 0;
  await assert.rejects(
    waitUntilNoxSimulatable(
      `proposal ${handle}`,
      async () => { throw new Error(`sensitive ${handle}`); },
      {
        timeoutMs: 1,
        intervalMs: 1,
        now: () => clock,
        sleep: async (ms) => { clock += ms; },
      },
    ),
    (error) => {
      assert.ok(error instanceof NoxProductionError);
      assert.equal(error.code, 'NOX_PROPAGATION_TIMEOUT');
      assert.doesNotMatch(error.message, /12121212/);
      assert.equal('cause' in error, false);
      return true;
    },
  );
});
