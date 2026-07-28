import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const emptyState = (module, safe) => ({
  version: 1,
  module: module.toLowerCase(),
  safe: safe.toLowerCase(),
  entries: {},
});

/**
 * Records which mandate was activated only after an explicit treasury top-up.
 * This is intentionally not presented as a live confidential-balance oracle:
 * it is a funding invariant/checkpoint used to prevent the watchdog from
 * silently resetting policy budget without replenishing its backing assets.
 */
export function createTreasuryReadinessJournal({ filePath, module, safe } = {}) {
  if (!filePath) throw new Error('treasury readiness journal path is required');
  if (!module || !safe) throw new Error('treasury readiness journal domain is required');
  let state;
  let writeCounter = 0;

  const requireLoaded = () => {
    if (!state) throw new Error('treasury readiness journal has not been loaded');
    return state;
  };

  const persist = async () => {
    await mkdir(dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.${++writeCounter}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, filePath);
  };

  return {
    async load() {
      try {
        const decoded = JSON.parse(await readFile(filePath, 'utf8'));
        if (
          decoded?.version !== 1
          || decoded?.module?.toLowerCase() !== module.toLowerCase()
          || decoded?.safe?.toLowerCase() !== safe.toLowerCase()
          || !decoded.entries
          || typeof decoded.entries !== 'object'
          || Array.isArray(decoded.entries)
        ) {
          throw new Error('treasury readiness journal does not match this module and Safe');
        }
        state = decoded;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        state = emptyState(module, safe);
      }
      return this;
    },

    isReady(delegate, mandateId, minimumTopupRaw) {
      const entry = requireLoaded().entries[delegate.toLowerCase()];
      return !!entry
        && BigInt(entry.mandateId) === BigInt(mandateId)
        && BigInt(entry.topupRaw) >= BigInt(minimumTopupRaw);
    },

    async record({ delegate, mandateId, topupRaw, fundedAt = new Date().toISOString() }) {
      if (BigInt(mandateId) < 1n || BigInt(topupRaw) < 1n) {
        throw new Error('treasury readiness record must contain a mandate and positive top-up');
      }
      requireLoaded().entries[delegate.toLowerCase()] = {
        mandateId: String(mandateId),
        topupRaw: String(topupRaw),
        fundedAt,
      };
      await persist();
    },

    status() {
      const entries = Object.values(requireLoaded().entries);
      return {
        recordedMandates: entries.length,
        lastFundedAt: entries
          .map((entry) => entry.fundedAt)
          .filter(Boolean)
          .sort()
          .at(-1) ?? null,
        evidence: 'fund-before-mandate-journal',
        liveBalanceObserved: false,
      };
    },
  };
}
