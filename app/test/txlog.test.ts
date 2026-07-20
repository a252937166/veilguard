import { expect, test } from 'vitest';
import { ESCALATION_CANCELLATION_EVIDENCE, requestLogQuery } from '../src/txlog';

test('EscalationCancelled does not authenticate a user Reject', () => {
  expect(ESCALATION_CANCELLATION_EVIDENCE).toEqual({ outcomePath: 'approval' });
  expect(ESCALATION_CANCELLATION_EVIDENCE).not.toHaveProperty('safeAction');
});

test('historical request evidence uses one OR-filtered query per block chunk', () => {
  const query = requestLogQuery(10n, 20n);
  expect(query.fromBlock).toBe(10n);
  expect(query.toBlock).toBe(20n);
  expect(query.events).toHaveLength(6);
  expect(query).not.toHaveProperty('event');
});
