import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createTreasuryReadinessJournal } from '../lib/treasury-readiness.mjs';

const moduleAddress = '0x02e9b09f5929604b101244661835605b1ee67fea';
const safeAddress = '0x22ab88236b21d4a528251474b05f5045c6e71e99';
const delegate = '0x17ee5ad7e4b40cadafad27c5f68f74d02c7fd532';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'veilguard-treasury-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return {
    filePath: join(directory, 'readiness.json'),
    module: moduleAddress,
    safe: safeAddress,
  };
}

test('an unrecorded mandate is not treasury-ready', async (t) => {
  const options = await fixture(t);
  const journal = createTreasuryReadinessJournal(options);
  await journal.load();

  assert.equal(journal.isReady(delegate, 1n, 400_000_000n), false);
  assert.deepEqual(journal.status(), {
    recordedMandates: 0,
    lastFundedAt: null,
    evidence: 'fund-before-mandate-journal',
    liveBalanceObserved: false,
  });
});

test('readiness requires the exact funded mandate and minimum backing amount', async (t) => {
  const options = await fixture(t);
  const journal = createTreasuryReadinessJournal(options);
  await journal.load();
  await journal.record({
    delegate,
    mandateId: 7n,
    topupRaw: 400_000_000n,
    fundedAt: '2026-07-28T12:00:00.000Z',
  });

  assert.equal(journal.isReady(delegate, 7n, 400_000_000n), true);
  assert.equal(journal.isReady(delegate, 6n, 400_000_000n), false);
  assert.equal(journal.isReady(delegate, 7n, 400_000_001n), false);
  assert.equal(journal.status().liveBalanceObserved, false);

  const persisted = JSON.parse(await readFile(options.filePath, 'utf8'));
  assert.equal(persisted.entries[delegate].mandateId, '7');
  assert.equal(persisted.entries[delegate].topupRaw, '400000000');
});

test('readiness survives restart but fails closed for another Safe/module domain', async (t) => {
  const options = await fixture(t);
  const first = createTreasuryReadinessJournal(options);
  await first.load();
  await first.record({ delegate, mandateId: 9n, topupRaw: 500_000_000n });

  const reloaded = createTreasuryReadinessJournal(options);
  await reloaded.load();
  assert.equal(reloaded.isReady(delegate, 9n, 400_000_000n), true);

  const wrongDomain = createTreasuryReadinessJournal({
    ...options,
    module: '0x1111111111111111111111111111111111111111',
  });
  await assert.rejects(wrongDomain.load(), /does not match this module and Safe/);
});
