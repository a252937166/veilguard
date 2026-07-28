import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createSponsoredRateLimitJournal,
  SponsoredRateLimitError,
} from '../lib/sponsored-rate-limit.mjs';

const moduleAddress = '0x02e9b09f5929604b101244661835605b1ee67fea';
const safeAddress = '0x22ab88236b21d4a528251474b05f5045c6e71e99';
const addressA = '0x17ee5ad7e4b40cadafad27c5f68f74d02c7fd532';
const addressB = '0x1111111111111111111111111111111111111111';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'veilguard-rate-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return {
    filePath: join(directory, 'rate.json'),
    domain: {
      kind: 'provision',
      chainId: 11155111,
      module: moduleAddress,
      safe: safeAddress,
    },
    dailyCap: 2,
    subjectWindowMs: 3_600_000,
  };
}

test('per-address and rolling daily quotas survive restart in a mode-0600 journal', async (t) => {
  const options = await fixture(t);
  const base = Date.now();
  const first = createSponsoredRateLimitJournal(options);
  await first.load();
  await first.consume(addressA, base);

  assert.equal((await stat(options.filePath)).mode & 0o777, 0o600);
  const restarted = createSponsoredRateLimitJournal(options);
  await restarted.load();
  assert.deepEqual(restarted.status(base + 1), {
    persistent: true,
    healthy: true,
    dailyCount: 1,
    dailyCap: 2,
    remainingToday: 1,
    subjectWindowSeconds: 3600,
    accounting: 'pre-write-attempts-rolling-24h',
  });
  await assert.rejects(
    restarted.consume(addressA, base + 2),
    (error) => error instanceof SponsoredRateLimitError && error.issue === 'subject-window',
  );

  await restarted.consume(addressB, base + 3);
  await assert.rejects(
    restarted.consume('0x2222222222222222222222222222222222222222', base + 4),
    (error) => error instanceof SponsoredRateLimitError && error.issue === 'daily-cap',
  );
});

test('expired entries are pruned while newer attempts remain protected', async (t) => {
  const options = await fixture(t);
  const journal = createSponsoredRateLimitJournal(options);
  await journal.load();
  await journal.consume(addressA, 1_000);

  const afterDay = 1_000 + 24 * 60 * 60_000 + 1;
  await journal.consume(addressA, afterDay);
  assert.equal(journal.status(afterDay).dailyCount, 1);
});

test('wrong-domain and malformed journals fail closed', async (t) => {
  const options = await fixture(t);
  const journal = createSponsoredRateLimitJournal(options);
  await journal.load();
  await journal.consume(addressA, 10_000);

  const wrongDomain = createSponsoredRateLimitJournal({
    ...options,
    domain: { ...options.domain, safe: addressB },
  });
  await assert.rejects(wrongDomain.load(), /does not match this chain\/module\/Safe domain/);

  await writeFile(options.filePath, '{broken', { mode: 0o600 });
  const malformed = createSponsoredRateLimitJournal(options);
  await assert.rejects(malformed.load(), /Expected|Unexpected|JSON/);
  assert.match(await readFile(options.filePath, 'utf8'), /broken/);
});
