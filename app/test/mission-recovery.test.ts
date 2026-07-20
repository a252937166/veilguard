import { expect, test } from 'vitest';
import { createDemoSession, demoSessionReducer, isMissionComplete } from '../src/demo-session';
import { DEMO_RECIPIENTS, demoMemoHash } from '../src/demo-scenarios';
import { reconcileRunBoundMissionEvidence } from '../src/mission-recovery';

const delegate = '0x1111111111111111111111111111111111111111' as const;

function request(runId: string, scenario: 'routine' | 'approval' | 'violation', state: number, id = 42n) {
  const recipient = scenario === 'routine' ? DEMO_RECIPIENTS.cloudNode
    : scenario === 'approval' ? DEMO_RECIPIENTS.shieldOps : DEMO_RECIPIENTS.atlas;
  return {
    id,
    mandateId: 7n,
    delegate,
    recipient,
    memoHash: demoMemoHash(runId, scenario, 7n, delegate),
    state,
  };
}

test('terminal routine evidence repairs a missing local completion after refresh', () => {
  const session = createDemoSession({ runId: 'launch-recovery', now: 1 });
  const next = reconcileRunBoundMissionEvidence(session, [request(session.runId, 'routine', 2)]);
  expect(next.missions.routine.requestId).toBe('42');
  expect(isMissionComplete(next, 'routine', { strict: true })).toBe(true);
});

test('a different run can never repair the active mission', () => {
  const session = createDemoSession({ runId: 'launch-current', now: 1 });
  const next = reconcileRunBoundMissionEvidence(session, [request('launch-old', 'routine', 2)]);
  expect(next).toBe(session);
  expect(isMissionComplete(next, 'routine', { strict: true })).toBe(false);
});

test('timeout cancellation is not reconciled as a user reject', () => {
  let session = createDemoSession({ runId: 'launch-timeout', now: 1 });
  session = demoSessionReducer(session, {
    type: 'BIND_REQUEST', runId: session.runId, mission: 'approval', requestId: '42', at: 2,
  });
  const next = reconcileRunBoundMissionEvidence(session, [request(session.runId, 'approval', 5)]);
  expect(next.missions.approval.outcome).toBeUndefined();
  expect(isMissionComplete(next, 'approval', { strict: true })).toBe(false);
});

test('a cancelled approval is not rebound from a scan without explicit timeout recovery', () => {
  let session = createDemoSession({ runId: 'launch-retry', now: 1 });
  session = demoSessionReducer(session, {
    type: 'BIND_REQUEST', runId: session.runId, mission: 'approval', requestId: '42', at: 2,
  });

  const next = reconcileRunBoundMissionEvidence(session, [
    request(session.runId, 'approval', 5, 42n),
    request(session.runId, 'approval', 1, 43n),
  ]);

  expect(next.missions.approval.requestId).toBe('42');
  expect(next.missions.approval.decision).toBeUndefined();
  expect(next.missions.approval.outcome).toBeUndefined();
  expect(isMissionComplete(next, 'approval', { strict: true })).toBe(false);
});

test('an explicitly expired incomplete attempt may recover its newer retry', () => {
  let session = createDemoSession({ runId: 'launch-expired', now: 1 });
  session = demoSessionReducer(session, {
    type: 'BIND_REQUEST', runId: session.runId, mission: 'routine', requestId: '42', at: 2,
  });

  const next = reconcileRunBoundMissionEvidence(session, [
    request(session.runId, 'routine', 6, 42n),
    request(session.runId, 'routine', 1, 43n),
  ]);

  expect(next.missions.routine.requestId).toBe('43');
  expect(next.missions.routine.outcome).toBeUndefined();
});

test('a completed mission never rebinds to a newer same-run request', () => {
  let session = createDemoSession({ runId: 'launch-frozen', now: 1 });
  session = demoSessionReducer(session, {
    type: 'ROUTINE_EXECUTED', runId: session.runId, requestId: '42', at: 2,
  });

  const next = reconcileRunBoundMissionEvidence(session, [
    request(session.runId, 'routine', 2, 42n),
    request(session.runId, 'routine', 2, 43n),
  ]);

  expect(next.missions.routine.requestId).toBe('42');
  expect(isMissionComplete(next, 'routine', { strict: true })).toBe(true);
});
