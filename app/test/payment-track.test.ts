// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import {
  loadPaymentTrack,
  savePaymentTrack,
  unresolvedRunBroadcast,
} from '../src/payment-track';

afterEach(() => sessionStorage.clear());

test('an unbound broadcast remains a restart blocker until receipt recovery binds it', () => {
  const pending = {
    mission: 'routine' as const,
    amount: '25',
    tx: `0x${'a'.repeat(64)}` as `0x${string}`,
    delegate: '0x1111111111111111111111111111111111111111' as const,
    at: 1,
    runId: 'launch-pending',
  };
  savePaymentTrack(pending);

  expect(unresolvedRunBroadcast('launch-pending')).toEqual(pending);
  expect(unresolvedRunBroadcast('another-run')).toBeNull();
  expect(loadPaymentTrack()).toEqual(pending);

  savePaymentTrack({ ...pending, id: '41' });
  expect(unresolvedRunBroadcast('launch-pending')).toBeNull();
});
