/** Compatibility facade around the run-bound DemoSessionV2 state machine. */
import {
  createDemoSession,
  createRunId,
  demoSessionReducer,
  guidedTourStepAction,
  isMissionComplete,
  loadDemoSession,
  saveDemoSession,
  type ApprovalDecision,
  type DemoMissionKey,
  type DemoSessionV2,
} from './demo-session';
import type { DemoRole } from './demo';
import type { AppRoute, RouteObjectSelection } from './routes';

export { getActiveDemoRunId } from './demo-session';

export type MissionKey = DemoMissionKey;
export type MissionState = Record<MissionKey, boolean>;

export type MissionCompletionEvidence = {
  /** On-chain request id. Omitting it keeps only the legacy UI flag. */
  requestId?: string | bigint | number;
  outcome?: 'executed' | 'cancelled' | 'blocked';
  decision?: ApprovalDecision;
  reasonDecrypted?: boolean;
  packetIds?: Array<string | bigint | number>;
  includedRequestIds?: Array<string | bigint | number>;
  reviewedRequestIds?: Array<string | bigint | number>;
  flaggedRequestIds?: Array<string | bigint | number>;
  packetUnlocked?: boolean;
  integrityVerified?: boolean;
  runId?: string;
};

const EMPTY: MissionState = { routine: false, approval: false, violation: false, audit: false };
const KEYS: MissionKey[] = ['routine', 'approval', 'violation', 'audit'];
const ids = (values: Array<string | bigint | number> | undefined) => values?.map(String) ?? [];

const emit = (session: DemoSessionV2) => {
  try {
    window.dispatchEvent(new CustomEvent('vg-missions', { detail: { runId: session.runId } }));
  } catch { /* SSR/tests */ }
};

export function getOrCreateDemoSession(): DemoSessionV2 {
  const existing = loadDemoSession();
  if (existing) return existing;
  const session = createDemoSession({ route: { page: 'payment-inbox' } });
  saveDemoSession(session);
  return session;
}

export function loadMissions(): MissionState {
  const session = loadDemoSession();
  if (!session) return { ...EMPTY };
  return Object.fromEntries(
    KEYS.map((key) => [key, isMissionComplete(session, key)]),
  ) as MissionState;
}

/**
 * Record mission evidence. Older callers may omit `evidence`; they still get a
 * compatibility completion flag, but `demoCompleted()` remains false until
 * concrete request/packet evidence is supplied.
 */
export function completeMission(k: MissionKey, evidence: MissionCompletionEvidence = {}): MissionState {
  let session = getOrCreateDemoSession();
  const runId = evidence.runId ?? session.runId;
  if (runId !== session.runId) return loadMissions();
  const requestId = evidence.requestId == null ? undefined : String(evidence.requestId);
  const at = Date.now();

  if (k === 'routine' && requestId && evidence.outcome !== 'cancelled' && evidence.outcome !== 'blocked') {
    session = demoSessionReducer(session, { type: 'ROUTINE_EXECUTED', runId, requestId, at });
  } else if (k === 'approval' && requestId) {
    const decision = evidence.decision ?? (evidence.outcome === 'cancelled' ? 'reject' : 'approve');
    session = demoSessionReducer(session, { type: 'APPROVAL_SETTLED', runId, requestId, decision, at });
  } else if (k === 'violation' && requestId) {
    session = demoSessionReducer(session, { type: 'VIOLATION_BLOCKED', runId, requestId, at });
    if (evidence.reasonDecrypted === true) {
      session = demoSessionReducer(session, { type: 'VIOLATION_REASON_DECRYPTED', runId, requestId, at });
    }
  } else if (k === 'audit' && evidence.packetIds?.length) {
    const packetIds = ids(evidence.packetIds);
    const includedRequestIds = ids(evidence.includedRequestIds);
    session = demoSessionReducer(session, {
      type: 'AUDIT_PACKETS_CREATED', runId, packetIds,
      ...(includedRequestIds.length ? { requestIds: includedRequestIds } : {}), at,
    });
    if (evidence.packetUnlocked) {
      session = demoSessionReducer(session, { type: 'AUDIT_UNLOCKED', runId, packetIds, at });
    }
    for (const id of ids(evidence.reviewedRequestIds)) {
      session = demoSessionReducer(session, { type: 'AUDIT_REQUEST_DISPOSITION', runId, requestId: id, disposition: 'reviewed', at });
    }
    for (const id of ids(evidence.flaggedRequestIds)) {
      session = demoSessionReducer(session, { type: 'AUDIT_REQUEST_DISPOSITION', runId, requestId: id, disposition: 'flagged', at });
    }
    if (evidence.integrityVerified != null) {
      session = demoSessionReducer(session, { type: 'AUDIT_INTEGRITY_VERIFIED', runId, verified: evidence.integrityVerified, at });
    }
  } else {
    session = demoSessionReducer(session, { type: 'LEGACY_COMPLETE', runId, mission: k, at });
  }

  saveDemoSession(session);
  emit(session);
  return Object.fromEntries(KEYS.map((key) => [key, isMissionComplete(session, key)])) as MissionState;
}

export function beginMission(k: MissionKey): DemoSessionV2 {
  const session = getOrCreateDemoSession();
  const next = demoSessionReducer(session, { type: 'BEGIN_MISSION', runId: session.runId, mission: k });
  saveDemoSession(next);
  emit(next);
  return next;
}

export function bindMissionRequest(
  mission: Exclude<MissionKey, 'audit'>,
  requestId: string | bigint | number,
  runId = getOrCreateDemoSession().runId,
  options: { replaceRetryableAttempt?: boolean } = {},
): DemoSessionV2 {
  const session = getOrCreateDemoSession();
  if (runId !== session.runId) return session;
  const next = demoSessionReducer(session, {
    type: 'BIND_REQUEST', runId, mission, requestId: String(requestId),
    ...(options.replaceRetryableAttempt ? { replaceRetryableAttempt: true } : {}),
  });
  saveDemoSession(next);
  emit(next);
  return next;
}

export function confirmApprovalDecision(
  requestId: string | bigint | number,
  decision: ApprovalDecision,
  options: { runId?: string; transactionHash?: string } = {},
): DemoSessionV2 {
  const session = getOrCreateDemoSession();
  const runId = options.runId ?? session.runId;
  if (runId !== session.runId) return session;
  const next = demoSessionReducer(session, {
    type: 'APPROVAL_DECISION_CONFIRMED',
    runId,
    requestId: String(requestId),
    decision,
    transactionHash: options.transactionHash,
  });
  saveDemoSession(next);
  emit(next);
  return next;
}

/**
 * Page-level mission CTAs use the same atomic route/role/selection reducer
 * intent as MissionDrawer. Persisting it before the shell applies role and
 * hash changes prevents the drawer from observing a transient mismatch and
 * incorrectly pausing the guided run.
 */
export function advanceGuidedMission(target: {
  step: number;
  route: AppRoute;
  role?: DemoRole;
  selected?: RouteObjectSelection;
}): DemoSessionV2 | null {
  const session = loadDemoSession();
  if (!session) return null;
  const next = demoSessionReducer(session, guidedTourStepAction(session, target));
  saveDemoSession(next);
  emit(next);
  return next;
}

export function resetMissions(options: { runId?: string } = {}): DemoSessionV2 {
  const next = createDemoSession({
    runId: options.runId ?? createRunId(),
    route: { page: 'payment-inbox' },
    tourActive: true,
  });
  saveDemoSession(next);
  emit(next);
  return next;
}

export const MISSIONS: { key: MissionKey; title: string; goal: string; outcome: string }[] = [
  {
    key: 'routine', title: 'CloudNode · routine payment',
    goal: 'Review and submit the 25 cUSDC infrastructure invoice; the private policy executes it.',
    outcome: 'Executed',
  },
  {
    key: 'approval', title: 'ShieldOps · committee decision',
    goal: 'Review the 60 cUSDC security request, then choose Approve or Reject for the real Safe 2-of-2.',
    outcome: 'Approved or refunded',
  },
  {
    key: 'violation', title: 'Atlas Contractor · policy block',
    goal: 'Submit the 600 cUSDC new-vendor invoice, then decrypt the private reason after it is blocked.',
    outcome: 'Blocked · reason viewed',
  },
];
