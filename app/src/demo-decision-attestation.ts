export type DemoDecisionOrigin = 'user' | 'timeout' | 'unknown';

export type DemoDecisionAttestation = {
  requestId: number;
  chainState?: number;
  origin: DemoDecisionOrigin;
  action?: 'approve' | 'reject';
  hash?: `0x${string}`;
  recordedAt?: number;
};

const unknown = (requestId: string | number | bigint): DemoDecisionAttestation => ({
  requestId: Number(requestId),
  origin: 'unknown',
});

export async function fetchDemoDecisionAttestation(
  runId: string,
  requestId: string | number | bigint,
  fetchImpl: typeof fetch = fetch,
): Promise<DemoDecisionAttestation> {
  if (!runId || !/^\d+$/.test(String(requestId))) return unknown(requestId);
  try {
    const query = new URLSearchParams({ runId, requestId: String(requestId) });
    const response = await fetchImpl(`/api/demo-decision?${query}`, {
      method: 'GET',
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return unknown(requestId);
    const body = await response.json();
    if (!body?.ok || Number(body.requestId) !== Number(requestId)
      || !['user', 'timeout', 'unknown'].includes(body.origin)) return unknown(requestId);
    const origin = body.origin as DemoDecisionOrigin;
    const action = origin === 'user' && (body.action === 'approve' || body.action === 'reject')
      ? body.action as 'approve' | 'reject'
      : undefined;
    if (origin === 'user' && !action) return unknown(requestId);
    return {
      requestId: Number(requestId),
      ...(Number.isInteger(body.chainState) ? { chainState: body.chainState } : {}),
      origin,
      ...(action ? { action } : {}),
      ...(typeof body.hash === 'string' && /^0x[0-9a-f]+$/i.test(body.hash) ? { hash: body.hash as `0x${string}` } : {}),
      ...(Number.isFinite(body.recordedAt) ? { recordedAt: body.recordedAt } : {}),
    };
  } catch {
    return unknown(requestId);
  }
}

export function isAttestedUserDecision(
  attestation: DemoDecisionAttestation | undefined,
  action: 'approve' | 'reject',
  chainState: 2 | 5,
): boolean {
  return attestation?.origin === 'user'
    && attestation.action === action
    && attestation.chainState === chainState;
}

export function isAttestedUserReject(attestation: DemoDecisionAttestation | undefined): boolean {
  return isAttestedUserDecision(attestation, 'reject', 5);
}
