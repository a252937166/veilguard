import { demoSessionReducer, type DemoMissionKey, type DemoSessionV2 } from './demo-session';
import {
  runBoundScenarioRequests,
  type DemoRequestIdentity,
  type DemoScenarioKey,
} from './demo-scenarios';

const REQUEST_MISSIONS = ['routine', 'approval', 'violation'] as const satisfies readonly DemoScenarioKey[];

const newest = <T extends DemoRequestIdentity>(requests: readonly T[]): T | undefined =>
  requests.reduce<T | undefined>((latest, request) => (
    !latest || BigInt(request.id) > BigInt(latest.id) ? request : latest
  ), undefined);

/**
 * Rebuilds safe-to-infer mission evidence from domain-separated on-chain
 * requests. This is deliberately conservative: a timeout cancellation never
 * becomes a user Reject, and a blocked request still needs an explicit reason
 * decrypt before the mission completes.
 */
export function reconcileRunBoundMissionEvidence<T extends DemoRequestIdentity>(
  session: DemoSessionV2,
  requests: readonly T[],
): DemoSessionV2 {
  let next = session;

  for (const mission of REQUEST_MISSIONS) {
    const candidates = runBoundScenarioRequests(next.runId, mission, requests);
    const boundId = next.missions[mission].requestId;
    // Retries create a new request under the same domain-separated run memo.
    // The newest authenticated candidate is therefore the current attempt,
    // even when an older cancelled request was already bound locally.
    const request = newest(candidates);
    if (!request) continue;

    const requestId = String(request.id);
    if (boundId !== requestId) {
      next = demoSessionReducer(next, {
        type: 'BIND_REQUEST', runId: next.runId, mission, requestId,
      });
    }

    if (mission === 'routine'
      && request.state === 2
      && next.missions.routine.outcome !== 'executed') {
      next = demoSessionReducer(next, {
        type: 'ROUTINE_EXECUTED', runId: next.runId, requestId,
      });
    }

    if (mission === 'approval' && next.missions.approval.decisionConfirmed === true) {
      const decision = next.missions.approval.decision;
      const settled = (decision === 'approve' && request.state === 2)
        || (decision === 'reject' && request.state === 5);
      if (decision && settled && !next.missions.approval.outcome) {
        next = demoSessionReducer(next, {
          type: 'APPROVAL_SETTLED', runId: next.runId, requestId, decision,
        });
      }
    }

    if (mission === 'violation'
      && request.state === 4
      && next.missions.violation.outcome !== 'blocked') {
      next = demoSessionReducer(next, {
        type: 'VIOLATION_BLOCKED', runId: next.runId, requestId,
      });
    }
  }

  return next;
}

export function missionForRequest(session: DemoSessionV2 | null, requestId: string): DemoMissionKey | null {
  if (!session) return null;
  return REQUEST_MISSIONS.find((mission) => session.missions[mission].requestId === requestId) ?? null;
}
