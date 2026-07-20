import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDemoMemoHash, createSerialExecutor, recentRequestIds, sameAddressList } from '../lib/demo-security.mjs';

test('demo memo commitment matches the browser wire vector', () => {
  const hash = buildDemoMemoHash({
    chainId: 11155111n,
    module: '0x02e9b09f5929604b101244661835605b1ee67fea',
    runId: 'run_12345678',
    scenario: 'approval',
    mandateId: 42n,
    delegate: '0x17ee5ad7e4b40cadafad27c5f68f74d02c7fd532',
  });
  assert.equal(hash, '0x6b7dbd8b9ea9bec81dde40a35f62701fb8ec44825a8ccc19e0d2b2ad9cf9327c');
});

test('memo commitment is domain-separated by run and scenario', () => {
  const base = {
    chainId: 11155111n,
    module: '0x02e9b09f5929604b101244661835605b1ee67fea',
    runId: 'run_12345678',
    scenario: 'approval',
    mandateId: 42n,
    delegate: '0x17ee5ad7e4b40cadafad27c5f68f74d02c7fd532',
  };
  assert.notEqual(buildDemoMemoHash(base), buildDemoMemoHash({ ...base, runId: 'run_87654321' }));
  assert.notEqual(buildDemoMemoHash(base), buildDemoMemoHash({ ...base, scenario: 'routine' }));
});

test('serial executor protects order and recovers after rejection', async () => {
  const serialise = createSerialExecutor();
  const events = [];
  const first = serialise(async () => {
    events.push('first:start');
    await Promise.resolve();
    events.push('first:end');
    throw new Error('expected');
  });
  const second = serialise(async () => {
    events.push('second:start');
    events.push('second:end');
    return 2;
  });
  await assert.rejects(first, /expected/);
  assert.equal(await second, 2);
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start', 'second:end']);
});

test('recipient schema comparison is ordered and case-insensitive', () => {
  assert.equal(sameAddressList(['0xAa', '0xBb'], ['0xaa', '0xbb']), true);
  assert.equal(sameAddressList(['0xBb', '0xAa'], ['0xaa', '0xbb']), false);
  assert.equal(sameAddressList(['0xAa'], ['0xaa', '0xbb']), false);
});

test('readiness scans a bounded newest-first request window', () => {
  assert.deepEqual(recentRequestIds(47n), Array.from({ length: 29 }, (_, index) => 46n - BigInt(index)));
  assert.deepEqual(recentRequestIds(4n), [3n, 2n, 1n]);
  assert.deepEqual(recentRequestIds(1n), []);
});
