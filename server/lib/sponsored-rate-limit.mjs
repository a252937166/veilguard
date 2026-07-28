import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const DAY_MS = 24 * 60 * 60_000;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export class SponsoredRateLimitError extends Error {
  constructor(issue, message) {
    super(message);
    this.name = 'SponsoredRateLimitError';
    this.issue = issue;
    this.status = 429;
  }
}

function normalizedDomain(domain) {
  if (
    !domain
    || typeof domain.kind !== 'string'
    || !domain.kind.trim()
    || !Number.isInteger(Number(domain.chainId))
    || Number(domain.chainId) < 1
    || !/^0x[0-9a-fA-F]{40}$/.test(domain.module ?? '')
    || !/^0x[0-9a-fA-F]{40}$/.test(domain.safe ?? '')
  ) {
    throw new Error('sponsored rate-limit journal domain is invalid');
  }
  return {
    kind: domain.kind.trim(),
    chainId: String(domain.chainId),
    module: domain.module.toLowerCase(),
    safe: domain.safe.toLowerCase(),
  };
}

function sameDomain(left, right) {
  return left?.kind === right.kind
    && String(left?.chainId) === right.chainId
    && left?.module?.toLowerCase() === right.module
    && left?.safe?.toLowerCase() === right.safe;
}

function normalizeSubject(subject) {
  const normalized = String(subject ?? '').trim().toLowerCase();
  if (!/^[a-z0-9:._-]{1,128}$/.test(normalized)) {
    throw new Error('sponsored rate-limit subject is invalid');
  }
  return normalized;
}

/**
 * Persistent, domain-bound accounting for sponsored transaction attempts.
 *
 * Quota is consumed before any chain write. This deliberately counts a failed
 * downstream attempt: a crash or ambiguous broadcast must never reopen the gas
 * budget after restart. The journal is a single-writer process primitive; run
 * one provisioner per journal path.
 */
export function createSponsoredRateLimitJournal({
  filePath,
  domain,
  dailyCap,
  subjectWindowMs = 0,
  now = () => Date.now(),
} = {}) {
  if (!filePath) throw new Error('sponsored rate-limit journal path is required');
  const journalDomain = normalizedDomain(domain);
  if (!Number.isInteger(dailyCap) || dailyCap < 1) {
    throw new Error('sponsored daily cap must be a positive integer');
  }
  if (!Number.isFinite(subjectWindowMs) || subjectWindowMs < 0) {
    throw new Error('sponsored subject window must be non-negative');
  }

  let state;
  let writeCounter = 0;
  let healthy = true;

  const requireLoaded = () => {
    if (!state) throw new Error('sponsored rate-limit journal has not been loaded');
    return state;
  };
  const requireWritable = () => {
    requireLoaded();
    if (!healthy) throw new Error('sponsored rate-limit journal is not writable');
  };

  const activeEntries = (at = now()) => (
    requireLoaded().entries.filter((entry) => entry.at > at - DAY_MS)
  );

  const persist = async () => {
    await mkdir(dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.${++writeCounter}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, filePath);
      await chmod(filePath, 0o600);
    } catch (error) {
      healthy = false;
      throw error;
    }
  };

  return {
    async load() {
      try {
        const decoded = JSON.parse(await readFile(filePath, 'utf8'));
        const loadedAt = now();
        if (
          decoded?.version !== 1
          || !sameDomain(decoded?.domain, journalDomain)
          || !Array.isArray(decoded?.entries)
          || decoded.entries.some((entry) => (
            typeof entry?.subject !== 'string'
            || normalizeSubject(entry.subject) !== entry.subject
            || !Number.isSafeInteger(entry.at)
            || entry.at < 0
            || entry.at > loadedAt + MAX_CLOCK_SKEW_MS
          ))
        ) {
          throw new Error('sponsored rate-limit journal does not match this chain/module/Safe domain');
        }
        state = {
          version: 1,
          domain: journalDomain,
          entries: decoded.entries.filter((entry) => entry.at > loadedAt - DAY_MS),
        };
        await chmod(filePath, 0o600);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        state = { version: 1, domain: journalDomain, entries: [] };
        // Prove the configured path is writable before the service can expose a
        // sponsored write endpoint.
        await persist();
      }
      return this;
    },

    async consume(subject, at = now()) {
      requireWritable();
      const normalized = normalizeSubject(subject);
      if (!Number.isSafeInteger(at) || at < 0) throw new Error('sponsored rate-limit timestamp is invalid');
      const active = activeEntries(at);
      if (
        subjectWindowMs > 0
        && active.some((entry) => entry.subject === normalized && entry.at > at - subjectWindowMs)
      ) {
        throw new SponsoredRateLimitError(
          'subject-window',
          'already sponsored recently — wait for the per-address window before retrying',
        );
      }
      if (active.length >= dailyCap) {
        throw new SponsoredRateLimitError(
          'daily-cap',
          'daily sponsored transaction cap reached',
        );
      }

      state.entries = [...active, { subject: normalized, at }];
      await persist();
      return this.status(at);
    },

    status(at = now()) {
      const entries = activeEntries(at);
      return {
        persistent: true,
        healthy,
        dailyCount: entries.length,
        dailyCap,
        remainingToday: Math.max(0, dailyCap - entries.length),
        subjectWindowSeconds: Math.floor(subjectWindowMs / 1000),
        accounting: 'pre-write-attempts-rolling-24h',
      };
    },
  };
}
