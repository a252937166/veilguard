import { expect, test } from 'vitest';
import { DEMO_RECIPIENTS, demoMemoHash, runBoundScenarioRequests } from '../src/demo-scenarios';

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
