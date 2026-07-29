import assert from 'node:assert/strict';
import test from 'node:test';
import { maybeTopUpDemoGas } from '../lib/demo-gas-topup.mjs';

const floor = 3n * 10n ** 15n;

test('disabled native-gas sponsorship never calls the Admin transfer', async () => {
  let transfers = 0;
  const result = await maybeTopUpDemoGas({
    balance: floor - 1n,
    floor,
    enabled: false,
    topup: async () => { transfers += 1; },
  });

  assert.deepEqual(result, { ready: false, toppedUp: false });
  assert.equal(transfers, 0);
});

test('enabled native-gas sponsorship tops up a low balance exactly once', async () => {
  let transfers = 0;
  const result = await maybeTopUpDemoGas({
    balance: 0n,
    floor,
    enabled: true,
    topup: async () => { transfers += 1; },
  });

  assert.deepEqual(result, { ready: true, toppedUp: true });
  assert.equal(transfers, 1);
});

test('a sufficient balance never schedules a transfer', async () => {
  let transfers = 0;
  const result = await maybeTopUpDemoGas({
    balance: floor,
    floor,
    enabled: true,
    topup: async () => { transfers += 1; },
  });

  assert.deepEqual(result, { ready: true, toppedUp: false });
  assert.equal(transfers, 0);
});

test('invalid gas readiness inputs fail before the transfer callback', async () => {
  let transfers = 0;
  await assert.rejects(
    maybeTopUpDemoGas({
      balance: -1n,
      floor,
      enabled: true,
      topup: async () => { transfers += 1; },
    }),
    /non-negative bigint/,
  );
  assert.equal(transfers, 0);
});
