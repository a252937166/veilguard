import { expect, test } from 'vitest';
import { deriveRequestDetailModel, deriveRequestStatus, type SpendRequestLike } from '../src/domain.ts';

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

test('Cancelled always derives as rejected and refunded despite stale approval evidence', () => {
  const model = deriveRequestDetailModel(request(5), {
    transactions: { approval: '0xapproval', cancellation: '0xcancel' },
    events: { safeAction: 'approve', outcomePath: 'approval' },
    actor: { canUseDemoDecision: true },
  });
  expect(model.status).toBe('safe-rejected');
  expect(model.escrow).toBe('refunded');
  expect(model.capabilities.canApprove).toBe(false);
  expect(model.capabilities.canReject).toBe(false);
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
