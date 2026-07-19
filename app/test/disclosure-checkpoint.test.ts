import { expect, test } from 'vitest';
import {
  adminDisclosureCheckpointKey,
  completedAdminDisclosureGroups,
  createAdminDisclosureCheckpoint,
  isAdminDisclosureCheckpointComplete,
  loadAdminDisclosureCheckpoint,
  saveAdminDisclosureCheckpoint,
  updateAdminDisclosureGroup,
} from '../src/disclosure-checkpoint';

const account = '0x4444444444444444444444444444444444444444' as const;
const auditor = '0x5555555555555555555555555555555555555555' as const;
const tx = `0x${'a'.repeat(64)}` as `0x${string}`;
const manifest = `0x${'b'.repeat(64)}` as `0x${string}`;

const memoryStorage = () => {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
};

test('checkpoint is run/account bound and preserves each mandate group independently', () => {
  const storage = memoryStorage();
  let checkpoint = createAdminDisclosureCheckpoint({
    runKey: 'launch-checkpoint',
    account,
    auditor,
    groups: new Map([['2', ['13']], ['1', ['12', '11']]]),
    now: 1,
  });
  checkpoint = updateAdminDisclosureGroup(checkpoint, '1', {
    transactionHash: tx,
    packetId: 8,
    manifestHash: manifest,
  }, 2);
  expect(saveAdminDisclosureCheckpoint(checkpoint, storage)).toBe(true);

  const restored = loadAdminDisclosureCheckpoint('launch-checkpoint', account, storage)!;
  expect(restored.selectedRequestIds).toEqual(['11', '12', '13']);
  expect(restored.groups['1']).toEqual(expect.objectContaining({ packetId: 8, transactionHash: tx }));
  expect(restored.groups['2'].packetId).toBeUndefined();
  expect(completedAdminDisclosureGroups(restored)).toBe(1);
  expect(isAdminDisclosureCheckpointComplete(restored)).toBe(false);
  expect(loadAdminDisclosureCheckpoint('another-run', account, storage)).toBeNull();
  expect(storage.values.has(adminDisclosureCheckpointKey('launch-checkpoint', account))).toBe(true);
});

test('checkpoint becomes complete only after every mandate has a hash and packet ID', () => {
  let checkpoint = createAdminDisclosureCheckpoint({
    runKey: 'launch-complete',
    account,
    auditor,
    groups: { 1: ['11'], 2: ['13'] },
  });
  for (const mandateId of ['1', '2']) {
    checkpoint = updateAdminDisclosureGroup(checkpoint, mandateId, {
      transactionHash: mandateId === '1' ? tx : `0x${'c'.repeat(64)}`,
      packetId: mandateId === '1' ? 8 : 9,
      manifestHash: manifest,
    });
  }
  expect(completedAdminDisclosureGroups(checkpoint)).toBe(2);
  expect(isAdminDisclosureCheckpointComplete(checkpoint)).toBe(true);
});
