import { expect, test } from 'vitest';
import { ESCALATION_CANCELLATION_EVIDENCE } from '../src/txlog';

test('EscalationCancelled does not authenticate a user Reject', () => {
  expect(ESCALATION_CANCELLATION_EVIDENCE).toEqual({ outcomePath: 'approval' });
  expect(ESCALATION_CANCELLATION_EVIDENCE).not.toHaveProperty('safeAction');
});
