import { expect, test } from 'vitest';
import { deriveRequestDetailModel, deriveRequestStatus, resolveRequestContexts, type SpendRequestLike } from '../src/domain.ts';

const request = (state: number): SpendRequestLike => ({
  id: 42n,
  mandateId: 7n,
  delegate: '0x1111111111111111111111111111111111111111',
  recipient: '0x2222222222222222222222222222222222222222',
  memoHash: '0xabc',
  createdAt: 1_700_000_000n,
  state,
  amount: '0xamount',
  decision: '0xdecision',
  blockedReason: '0xreason',
});

test('Cancelled stays neutral and refunded despite stale approval or cancellation evidence', () => {
  const model = deriveRequestDetailModel(request(5), {
    transactions: { approval: '0xapproval', cancellation: '0xcancel' },
    events: { safeAction: 'reject', outcomePath: 'approval', decisionOrigin: 'unknown' },
    actor: { canUseDemoDecision: true },
  });
  expect(model.status).toBe('cancelled');
  expect(model.statusLabel).toBe('Cancelled and refunded');
  expect(model.statusTone).toBe('neutral');
  expect(model.escrow).toBe('refunded');
  expect(model.capabilities.canApprove).toBe(false);
  expect(model.capabilities.canReject).toBe(false);
  expect(model.timeline.find((stage) => stage.id === 'safe')?.detail).toMatch(/no user Reject is claimed/);
});

test('only a server-authenticated user receipt upgrades cancellation to safe-rejected', () => {
  const attested = deriveRequestDetailModel(request(5), {
    transactions: { cancellation: '0xcancel' },
    events: { safeAction: 'reject', outcomePath: 'approval', decisionOrigin: 'user' },
  });
  const timeout = deriveRequestDetailModel(request(5), {
    transactions: { cancellation: '0xtimeout' },
    events: { outcomePath: 'approval', decisionOrigin: 'timeout' },
  });
  expect(attested.status).toBe('safe-rejected');
  expect(attested.statusLabel).toBe('User rejected · refunded');
  expect(timeout.status).toBe('cancelled');
  expect(timeout.timeline.find((stage) => stage.id === 'safe')?.detail).toMatch(/timeout cancellation authenticated/);
});

test('executed requests distinguish direct and Safe-approved evidence', () => {
  expect(deriveRequestStatus(request(2))).toBe('executed-unclassified');
  expect(deriveRequestStatus(request(2), { events: { outcomePath: 'direct' } })).toBe('direct-executed');
  expect(deriveRequestStatus(request(2), { transactions: { approval: '0xsafe' } })).toBe('safe-approved');
});

test('public privacy lens never receives authorized amount, memo or reason', () => {
  const model = deriveRequestDetailModel(request(4), {
    actor: { isDelegate: true },
    authorized: { amount: '600 cUSDC', memo: 'New vendor invoice', reason: 'Budget exceeded' },
  });
  expect(model.privacy.authorized.amount).toBe('600 cUSDC');
  expect(model.privacy.authorized.reason).toBe('Budget exceeded');
  expect(model.privacy.public).toEqual({
    amount: 'Encrypted handle',
    recipient: request(4).recipient,
    memo: 'Memo hash only',
    policyResult: 'Terminal state only',
    reason: 'Not disclosed',
  });
});

test('demo decision capability only exists while escrow awaits a decision', () => {
  const pending = deriveRequestDetailModel(request(3), { actor: { canUseDemoDecision: true } });
  const settled = deriveRequestDetailModel(request(2), { actor: { canUseDemoDecision: true } });
  expect(pending.capabilities.canApprove).toBe(true);
  expect(pending.capabilities.canReject).toBe(true);
  expect(settled.capabilities.canApprove).toBe(false);
});

test('viewed request never replaces or falls back to the active operation request', () => {
  const active = request(1);
  const viewed = { ...request(2), id: 99n };
  expect(resolveRequestContexts([active, viewed], { activeId: 42n, viewedId: 99n })).toEqual({ active, viewed });
  expect(resolveRequestContexts([active, viewed], { activeId: 42n, viewedId: 100n })).toEqual({ active, viewed: undefined });
});

test('blocked protection is a completed stage and uses the danger presentation', () => {
  const model = deriveRequestDetailModel(request(4));
  expect(model.statusTone).toBe('danger');
  expect(model.timeline.find((stage) => stage.id === 'escrow')).toMatchObject({
    label: 'Treasury protected',
    state: 'complete',
  });
});
