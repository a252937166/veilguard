import { expect, test, vi } from 'vitest';
import {
  fetchDemoDecisionAttestation,
  isAttestedUserDecision,
  isAttestedUserReject,
} from '../src/demo-decision-attestation';

test('reads a run-bound user rejection attestation without mutation', async () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
    ok: true,
    requestId: 42,
    chainState: 5,
    origin: 'user',
    action: 'reject',
    hash: `0x${'a'.repeat(64)}`,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
  const result = await fetchDemoDecisionAttestation('launch-current', 42, fetchImpl);

  expect(fetchImpl).toHaveBeenCalledWith('/api/demo-decision?runId=launch-current&requestId=42', expect.objectContaining({ method: 'GET' }));
  expect(isAttestedUserReject(result)).toBe(true);
  expect(isAttestedUserDecision(result, 'reject', 5)).toBe(true);
  expect(isAttestedUserDecision(result, 'approve', 2)).toBe(false);
});

test('recognises only a matching state-2 user approval', () => {
  expect(isAttestedUserDecision({
    requestId: 35,
    chainState: 2,
    origin: 'user',
    action: 'approve',
    hash: `0x${'b'.repeat(64)}`,
  }, 'approve', 2)).toBe(true);
  expect(isAttestedUserDecision({
    requestId: 35,
    chainState: 2,
    origin: 'timeout',
  }, 'approve', 2)).toBe(false);
  expect(isAttestedUserDecision({
    requestId: 35,
    chainState: 5,
    origin: 'user',
    action: 'approve',
  }, 'approve', 2)).toBe(false);
});

test('failed or malformed attestation remains conservatively unknown', async () => {
  const failed = vi.fn(async () => new Response('{}', { status: 403 })) as unknown as typeof fetch;
  const malformed = vi.fn(async () => new Response(JSON.stringify({ ok: true, requestId: 42, origin: 'user' }), { status: 200 })) as unknown as typeof fetch;
  expect(await fetchDemoDecisionAttestation('launch-current', 42, failed)).toEqual({ requestId: 42, origin: 'unknown' });
  expect(await fetchDemoDecisionAttestation('launch-current', 42, malformed)).toEqual({ requestId: 42, origin: 'unknown' });
  expect(isAttestedUserReject(await fetchDemoDecisionAttestation('launch-current', 42, malformed))).toBe(false);
});
