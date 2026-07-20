export type DemoReadiness = {
  ready: boolean;
  reason?: string;
  cooldownLeft?: number;
};

const defaultSleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Read-only preflight may be safely retried because it never signs or submits a
 * transaction. The caller keeps the operation dock visible between attempts.
 */
export async function fetchDemoReadiness({
  delegate,
  fetchImpl = fetch,
  attempts = 2,
  timeoutMs = 15_000,
  retryDelayMs = 750,
  sleep = defaultSleep,
  onRetry,
}: {
  delegate: string;
  fetchImpl?: typeof fetch;
  attempts?: number;
  timeoutMs?: number;
  retryDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<unknown>;
  onRetry?: (attempt: number) => void;
}): Promise<DemoReadiness> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchImpl('/api/demo-ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delegate }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const data = await response.json().catch(() => ({})) as DemoReadiness & { error?: string };
      if (!response.ok) throw new Error(data.error ?? `readiness returned ${response.status}`);
      return data;
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      onRetry?.(attempt + 1);
      await sleep(retryDelayMs);
    }
  }
  throw lastError ?? new Error('demo readiness is unavailable');
}
