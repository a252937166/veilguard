/**
 * Single-flight job runner with a redeliverable success cache.
 *
 * The HTTP layer can acknowledge a long-running job with 202 immediately and
 * let clients poll the same key: while the job runs every take() reports
 * processing; after it settles, a success is redelivered from the cache for
 * ttlMs (so a lost response never re-runs or double-charges the work) and a
 * failure is delivered exactly once so the next take() may retry fresh.
 */
export function createSingleFlight({ ttlMs = 10 * 60_000, setTimer = setTimeout } = {}) {
  const jobs = new Map();
  const results = new Map();
  return {
    get inFlight() { return jobs.size; },
    take(key, run) {
      const done = results.get(key);
      if (done) {
        if (done.ok) return { result: done.result };
        results.delete(key);
        return { error: done.error };
      }
      if (jobs.has(key)) return { processing: true };
      const promise = Promise.resolve().then(run);
      jobs.set(key, promise);
      let entry;
      promise.then(
        (result) => { entry = { ok: true, result }; results.set(key, entry); },
        (error) => { entry = { ok: false, error }; results.set(key, entry); },
      ).finally(() => {
        jobs.delete(key);
        // The timer belongs to THIS settlement: a retry that settled later
        // owns its own timer and must not be evicted by this one.
        const timer = setTimer(() => {
          if (results.get(key) === entry) results.delete(key);
        }, ttlMs);
        timer?.unref?.();
      });
      return { processing: true };
    },
  };
}
