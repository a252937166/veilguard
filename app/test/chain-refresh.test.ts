import { expect, test } from 'vitest';
import { chainSnapshotFingerprint, changedRequestIds, requestStateSnapshot } from '../src/chain-refresh';

test('chain refresh reports only real request evidence changes', () => {
  const previous = requestStateSnapshot([
    { id: 31n, state: 1, decisionReady: false },
    { id: 32n, state: 3 },
  ]);
  const current = requestStateSnapshot([
    { id: 31n, state: 2, decisionReady: true },
    { id: 33n, state: 1 },
  ]);
  expect(changedRequestIds(previous, current).sort()).toEqual(['31', '32', '33']);
});

test('chain snapshot fingerprint stays stable until public state changes', () => {
  const requests = requestStateSnapshot([{ id: 31n, state: 2 }]);
  const input = {
    mandates: [{ id: 9n, state: 2, version: 4 }],
    requests,
    owners: ['0xABC'],
    financeAdmin: '0xDEF',
    paused: false,
  };
  expect(chainSnapshotFingerprint(input)).toBe(chainSnapshotFingerprint({ ...input, owners: ['0xabc'] }));
  expect(chainSnapshotFingerprint(input)).toBe(chainSnapshotFingerprint({ ...input, financeAdmin: '0xdef' }));
  expect(chainSnapshotFingerprint(input)).not.toBe(chainSnapshotFingerprint({ ...input, financeAdmin: '0x123' }));
  expect(chainSnapshotFingerprint(input)).not.toBe(chainSnapshotFingerprint({ ...input, paused: true }));
});
