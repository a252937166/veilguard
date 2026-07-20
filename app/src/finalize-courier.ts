import { FINALIZE_API } from './config';

export type FinalizeCourierResult = 'accepted' | 'response-delayed';

/**
 * Ask the proof courier to publish one exact request. A transport failure is
 * deliberately ambiguous: the server may already own the job, so callers must
 * follow the same request on-chain instead of reporting failure or resubmitting.
 */
export async function requestFinalize(
  requestId: bigint,
  fetchImpl: typeof fetch = fetch,
): Promise<FinalizeCourierResult> {
  try {
    const response = await fetchImpl(FINALIZE_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: Number(requestId) }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(data.error ?? 'finalize failed');
    }
    return 'accepted';
  } catch (error: any) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError' || error?.name === 'TypeError') {
      return 'response-delayed';
    }
    throw error;
  }
}
