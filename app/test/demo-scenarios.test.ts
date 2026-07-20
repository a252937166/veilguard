import { expect, test } from 'vitest';
import { DEMO_RECIPIENTS, demoMemoHash, runBoundScenarioRequests, trustedDemoScenarioForRequest } from '../src/demo-scenarios';

const delegate = '0x1111111111111111111111111111111111111111' as const;

test('run recovery only finds requests bound to the same run and scenario recipient', () => {
  const mandateId = 7n;
  const request = {
    id: 42n,
    mandateId,
    delegate,
    recipient: DEMO_RECIPIENTS.shieldOps,
    memoHash: demoMemoHash('launch-current', 'approval', mandateId, delegate),
    state: 3,
  };
  const wrongRun = { ...request, id: 43n, memoHash: demoMemoHash('launch-old', 'approval', mandateId, delegate) };
  const wrongRecipient = { ...request, id: 44n, recipient: DEMO_RECIPIENTS.cloudNode };

  expect(runBoundScenarioRequests('launch-current', 'approval', [request, wrongRun, wrongRecipient]).map(({ id }) => id))
    .toEqual([42n]);
});

test('trusted story metadata requires the full run-bound request identity', () => {
  const runId = 'launch-current';
  const mandateId = 7n;
  const request = {
    id: 42n,
    mandateId,
    delegate,
    recipient: DEMO_RECIPIENTS.cloudNode,
    memoHash: demoMemoHash(runId, 'routine', mandateId, delegate),
    state: 2,
  };

  expect(trustedDemoScenarioForRequest(runId, request)?.key).toBe('routine');
  expect(trustedDemoScenarioForRequest('launch-other', request)).toBeUndefined();
  expect(trustedDemoScenarioForRequest(runId, { ...request, mandateId: 8n })).toBeUndefined();
  expect(trustedDemoScenarioForRequest(runId, { ...request, delegate: '0x2222222222222222222222222222222222222222' })).toBeUndefined();
  expect(trustedDemoScenarioForRequest(runId, { ...request, recipient: DEMO_RECIPIENTS.shieldOps })).toBeUndefined();
});

test('same-recipient Free Play request never inherits fixed invoice amount or purpose', () => {
  const request = {
    id: 90n,
    mandateId: 7n,
    delegate,
    recipient: DEMO_RECIPIENTS.cloudNode,
    memoHash: `0x${'a'.repeat(64)}` as const,
    state: 2,
  };
  expect(trustedDemoScenarioForRequest('launch-current', request)).toBeUndefined();
});
