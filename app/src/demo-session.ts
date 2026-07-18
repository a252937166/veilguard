import type { DemoRole } from './demo';
import { DEFAULT_APP_ROUTE, formatAppRoute, parseAppHash, type AppRoute, type RouteObjectSelection } from './routes';

export const DEMO_SESSION_VERSION = 2 as const;
export const DEMO_SESSION_KEY = 'vg_demo_session_v2';
export const LEGACY_MISSIONS_KEY = 'vg_missions';

export type DemoMissionKey = 'routine' | 'approval' | 'violation' | 'audit';
export type MissionStatus = 'locked' | 'ready' | 'active' | 'complete';
export type ApprovalDecision = 'approve' | 'reject';

export type MissionOutcome =
  | 'executed'
  | 'safe-approved'
  | 'safe-rejected'
  | 'blocked'
  | 'audit-reviewed';

/**
 * Progress is explicitly bound to one run. IDs are serialized decimal/hex
 * strings so sessionStorage never has to encode bigint values.
 */
export type MissionProgress = {
  runId: string;
  status: MissionStatus;
  requestId?: string;
  outcome?: MissionOutcome;
  decision?: ApprovalDecision;
  decisionConfirmed?: boolean;
  decisionTx?: string;
  reasonDecrypted?: boolean;
  packetIds: string[];
  includedRequestIds: string[];
  reviewedRequestIds: string[];
  flaggedRequestIds: string[];
  packetUnlocked?: boolean;
  integrityVerified?: boolean;
  /** Keeps old screens moving while strict demo completion still needs evidence. */
  compatibilityComplete?: boolean;
  updatedAt: number;
};

export type DemoSessionLifecycle = 'active' | 'paused' | 'completed';

export type DemoTourState = {
  active: boolean;
  step: number;
  paused: boolean;
  pauseReason?: 'navigation' | 'role-change' | 'manual' | 'restart-failed';
  expectedRoute?: AppRoute;
  expectedRole?: DemoRole;
};

export type DemoRestartState = {
  status: 'idle' | 'ready' | 'cleanup-required' | 'cleanup-confirmed' | 'failed';
  pendingApprovalRequestId?: string;
  error?: string;
};

export type DemoSessionV2 = {
  version: typeof DEMO_SESSION_VERSION;
  runId: string;
  lifecycle: DemoSessionLifecycle;
  currentMission: DemoMissionKey;
  role: DemoRole;
  route: AppRoute;
  selected: RouteObjectSelection;
  missions: Record<DemoMissionKey, MissionProgress>;
  tour: DemoTourState;
  restart: DemoRestartState;
  createdAt: number;
  updatedAt: number;
};

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const MISSION_ORDER: DemoMissionKey[] = ['routine', 'approval', 'violation', 'audit'];

const storageOrUndefined = (): StorageLike | undefined => {
  try { return typeof sessionStorage === 'undefined' ? undefined : sessionStorage; }
  catch { return undefined; }
};

const unique = (items: readonly string[]) => [...new Set(items.filter(Boolean))];

const emptyProgress = (
  runId: string,
  status: MissionStatus,
  now: number,
): MissionProgress => ({
  runId,
  status,
  packetIds: [],
  includedRequestIds: [],
  reviewedRequestIds: [],
  flaggedRequestIds: [],
  updatedAt: now,
});

export function createRunId(now = Date.now()): string {
  let random = '';
  try { random = globalThis.crypto?.randomUUID?.().slice(0, 8) ?? ''; } catch { /* old webviews */ }
  if (!random) random = Math.random().toString(36).slice(2, 10);
  return `launch-${now.toString(36)}-${random}`;
}

export function createDemoSession(options: {
  runId?: string;
  now?: number;
  route?: AppRoute;
  role?: DemoRole;
  tourActive?: boolean;
} = {}): DemoSessionV2 {
  const now = options.now ?? Date.now();
  const runId = options.runId ?? createRunId(now);
  return {
    version: DEMO_SESSION_VERSION,
    runId,
    lifecycle: 'active',
    currentMission: 'routine',
    role: options.role ?? 'delegate',
    route: options.route ?? DEFAULT_APP_ROUTE,
    selected: {},
    missions: {
      routine: emptyProgress(runId, 'ready', now),
      approval: emptyProgress(runId, 'locked', now),
      violation: emptyProgress(runId, 'locked', now),
      audit: emptyProgress(runId, 'locked', now),
    },
    tour: { active: options.tourActive ?? false, step: 0, paused: false },
    restart: { status: 'idle' },
    createdAt: now,
    updatedAt: now,
  };
}

const hasRequestEvidence = (progress: MissionProgress) =>
  !!progress.requestId && !progress.requestId.startsWith('legacy:');

export function isMissionComplete(
  session: DemoSessionV2,
  key: DemoMissionKey,
  options: { strict?: boolean } = {},
): boolean {
  const p = session.missions[key];
  if (!p || p.runId !== session.runId) return false;
  if (!options.strict && p.compatibilityComplete) return true;
  switch (key) {
    case 'routine':
      return hasRequestEvidence(p) && p.outcome === 'executed';
    case 'approval':
      return hasRequestEvidence(p)
        && p.decisionConfirmed === true
        && ((p.decision === 'approve' && p.outcome === 'safe-approved')
          || (p.decision === 'reject' && p.outcome === 'safe-rejected'));
    case 'violation':
      return hasRequestEvidence(p) && p.outcome === 'blocked' && p.reasonDecrypted === true;
    case 'audit': {
      const dispositions = new Set([...p.reviewedRequestIds, ...p.flaggedRequestIds]);
      return p.packetIds.length > 0
        && p.includedRequestIds.length > 0
        && p.includedRequestIds.every((id) => dispositions.has(id))
        && p.packetUnlocked === true
        && p.integrityVerified === true
        && p.outcome === 'audit-reviewed';
    }
  }
}

export function demoCompleted(session: DemoSessionV2): boolean {
  return MISSION_ORDER.every((key) => isMissionComplete(session, key, { strict: true }));
}

const nextIncompleteMission = (session: DemoSessionV2): DemoMissionKey =>
  MISSION_ORDER.find((key) => !isMissionComplete(session, key, { strict: true })) ?? 'audit';

function normalizeSession(input: DemoSessionV2, now = input.updatedAt): DemoSessionV2 {
  const missions = { ...input.missions };
  for (const [index, key] of MISSION_ORDER.entries()) {
    const current = missions[key];
    const complete = isMissionComplete({ ...input, missions }, key, { strict: true });
    const previousComplete = index === 0
      || isMissionComplete({ ...input, missions }, MISSION_ORDER[index - 1], { strict: true });
    const status: MissionStatus = complete
      ? 'complete'
      : current.status === 'active'
        ? 'active'
        : previousComplete ? 'ready' : 'locked';
    missions[key] = { ...current, status };
  }
  const normalized = { ...input, missions };
  const complete = demoCompleted(normalized);
  return {
    ...normalized,
    lifecycle: complete ? 'completed' : normalized.lifecycle === 'completed' ? 'active' : normalized.lifecycle,
    currentMission: complete ? 'audit' : nextIncompleteMission(normalized),
    updatedAt: now,
  };
}

export type DemoSessionAction =
  | { type: 'NAVIGATE'; runId: string; route: AppRoute; selected?: RouteObjectSelection; at?: number }
  | { type: 'SET_ROLE'; runId: string; role: DemoRole; at?: number }
  | { type: 'BEGIN_MISSION'; runId: string; mission: DemoMissionKey; at?: number }
  | { type: 'BIND_REQUEST'; runId: string; mission: Exclude<DemoMissionKey, 'audit'>; requestId: string; at?: number }
  | { type: 'ROUTINE_EXECUTED'; runId: string; requestId: string; at?: number }
  | { type: 'APPROVAL_DECISION_CONFIRMED'; runId: string; requestId: string; decision: ApprovalDecision; transactionHash?: string; at?: number }
  | { type: 'APPROVAL_SETTLED'; runId: string; requestId: string; decision: ApprovalDecision; at?: number }
  | { type: 'VIOLATION_BLOCKED'; runId: string; requestId: string; at?: number }
  | { type: 'VIOLATION_REASON_DECRYPTED'; runId: string; requestId: string; at?: number }
  | { type: 'AUDIT_SCOPE_SET'; runId: string; requestIds: string[]; at?: number }
  | { type: 'AUDIT_PACKETS_CREATED'; runId: string; packetIds: string[]; requestIds?: string[]; at?: number }
  | { type: 'AUDIT_UNLOCKED'; runId: string; packetIds?: string[]; at?: number }
  | { type: 'AUDIT_REQUEST_DISPOSITION'; runId: string; requestId: string; disposition: 'reviewed' | 'flagged'; at?: number }
  | { type: 'AUDIT_INTEGRITY_VERIFIED'; runId: string; verified: boolean; at?: number }
  | { type: 'LEGACY_COMPLETE'; runId: string; mission: DemoMissionKey; at?: number }
  | { type: 'TOUR_STEP'; runId: string; step: number; route: AppRoute; role?: DemoRole; at?: number }
  | { type: 'PAUSE_TOUR'; runId: string; reason: DemoTourState['pauseReason']; at?: number }
  | { type: 'RETURN_TO_MISSION'; runId: string; at?: number }
  | { type: 'CLOSE_TOUR'; runId: string; at?: number }
  | { type: 'PAUSE_SESSION'; runId: string; at?: number }
  | { type: 'RESUME_SESSION'; runId: string; at?: number }
  | { type: 'REQUEST_RESTART'; runId: string; pendingApprovalRequestId?: string; at?: number }
  | { type: 'RESTART_CLEANUP_SUCCEEDED'; runId: string; requestId: string; at?: number }
  | { type: 'RESTART_CLEANUP_FAILED'; runId: string; requestId: string; error: string; at?: number }
  | { type: 'CONFIRM_RESTART'; runId: string; newRunId?: string; at?: number };

const actionTime = (action: DemoSessionAction) => action.at ?? Date.now();

const updateMission = (
  state: DemoSessionV2,
  key: DemoMissionKey,
  patch: Partial<MissionProgress>,
  at: number,
): DemoSessionV2 => ({
  ...state,
  missions: {
    ...state.missions,
    [key]: { ...state.missions[key], ...patch, runId: state.runId, updatedAt: at },
  },
});

export function demoSessionReducer(state: DemoSessionV2, action: DemoSessionAction): DemoSessionV2 {
  // Delayed receipts from a previous run must never advance a new run.
  if (action.runId !== state.runId) return state;
  const at = actionTime(action);
  let next = state;

  switch (action.type) {
    case 'NAVIGATE':
      next = { ...state, route: action.route, selected: action.selected ?? state.selected };
      break;
    case 'SET_ROLE':
      next = { ...state, role: action.role };
      break;
    case 'BEGIN_MISSION':
      if (state.missions[action.mission].status === 'locked') return state;
      next = updateMission(state, action.mission, { status: 'active' }, at);
      break;
    case 'BIND_REQUEST':
      next = updateMission(state, action.mission, {
        requestId: action.requestId,
        status: 'active',
        ...(action.mission === 'routine' ? {
          outcome: undefined,
          compatibilityComplete: false,
        } : action.mission === 'approval' ? {
          decision: undefined,
          decisionConfirmed: false,
          decisionTx: undefined,
          outcome: undefined,
          compatibilityComplete: false,
        } : {
          outcome: undefined,
          reasonDecrypted: false,
          compatibilityComplete: false,
        }),
      }, at);
      break;
    case 'ROUTINE_EXECUTED':
      next = updateMission(state, 'routine', { requestId: action.requestId, outcome: 'executed' }, at);
      break;
    case 'APPROVAL_DECISION_CONFIRMED': {
      const approval = state.missions.approval;
      if (approval.requestId && approval.requestId !== action.requestId) return state;
      next = updateMission(state, 'approval', {
        requestId: action.requestId,
        decision: action.decision,
        decisionConfirmed: true,
        decisionTx: action.transactionHash,
        status: 'active',
      }, at);
      break;
    }
    case 'APPROVAL_SETTLED':
      if (state.missions.approval.requestId !== action.requestId
        || state.missions.approval.decisionConfirmed !== true
        || state.missions.approval.decision !== action.decision) return state;
      next = updateMission(state, 'approval', {
        requestId: action.requestId,
        outcome: action.decision === 'approve' ? 'safe-approved' : 'safe-rejected',
      }, at);
      break;
    case 'VIOLATION_BLOCKED':
      next = updateMission(state, 'violation', { requestId: action.requestId, outcome: 'blocked' }, at);
      break;
    case 'VIOLATION_REASON_DECRYPTED': {
      const violation = state.missions.violation;
      if (violation.requestId && violation.requestId !== action.requestId) return state;
      next = updateMission(state, 'violation', { requestId: action.requestId, reasonDecrypted: true }, at);
      break;
    }
    case 'AUDIT_SCOPE_SET': {
      const requestIds = unique(action.requestIds);
      const scopeChanged = requestIds.join(',') !== state.missions.audit.includedRequestIds.join(',');
      next = updateMission(state, 'audit', {
        includedRequestIds: requestIds,
        ...(scopeChanged ? {
          packetIds: [], reviewedRequestIds: [], flaggedRequestIds: [],
          packetUnlocked: false, integrityVerified: false, outcome: undefined,
        } : {}),
        status: state.missions.audit.status === 'locked' ? 'locked' : 'active',
      }, at);
      break;
    }
    case 'AUDIT_PACKETS_CREATED': {
      const packetIds = unique(action.packetIds);
      const packetSetChanged = packetIds.join(',') !== state.missions.audit.packetIds.join(',');
      next = updateMission(state, 'audit', {
        packetIds,
        includedRequestIds: action.requestIds
          ? unique(action.requestIds)
          : state.missions.audit.includedRequestIds,
        ...(packetSetChanged ? {
          reviewedRequestIds: [], flaggedRequestIds: [],
          packetUnlocked: false, integrityVerified: false, outcome: undefined,
        } : {}),
        status: 'active',
      }, at);
      break;
    }
    case 'AUDIT_UNLOCKED':
      next = updateMission(state, 'audit', {
        packetIds: action.packetIds ? unique(action.packetIds) : state.missions.audit.packetIds,
        packetUnlocked: true,
      }, at);
      break;
    case 'AUDIT_REQUEST_DISPOSITION': {
      const audit = state.missions.audit;
      const reviewed = new Set(audit.reviewedRequestIds);
      const flagged = new Set(audit.flaggedRequestIds);
      reviewed.delete(action.requestId);
      flagged.delete(action.requestId);
      (action.disposition === 'reviewed' ? reviewed : flagged).add(action.requestId);
      next = updateMission(state, 'audit', {
        reviewedRequestIds: [...reviewed],
        flaggedRequestIds: [...flagged],
      }, at);
      break;
    }
    case 'AUDIT_INTEGRITY_VERIFIED':
      next = updateMission(state, 'audit', {
        integrityVerified: action.verified,
        outcome: action.verified ? 'audit-reviewed' : undefined,
      }, at);
      break;
    case 'LEGACY_COMPLETE':
      next = updateMission(state, action.mission, { compatibilityComplete: true }, at);
      break;
    case 'TOUR_STEP':
      next = {
        ...state,
        route: action.route,
        role: action.role ?? state.role,
        tour: {
          active: true,
          step: Math.max(0, Math.floor(action.step)),
          paused: false,
          expectedRoute: action.route,
          expectedRole: action.role,
        },
      };
      break;
    case 'PAUSE_TOUR':
      next = { ...state, lifecycle: 'paused', tour: { ...state.tour, paused: true, pauseReason: action.reason } };
      break;
    case 'RETURN_TO_MISSION':
      next = {
        ...state,
        lifecycle: 'active',
        route: state.tour.expectedRoute ?? state.route,
        role: state.tour.expectedRole ?? state.role,
        tour: { ...state.tour, paused: false, pauseReason: undefined },
        restart: state.restart.status === 'failed' ? { status: 'idle' } : state.restart,
      };
      break;
    case 'CLOSE_TOUR':
      next = { ...state, tour: { ...state.tour, active: false, paused: false, pauseReason: undefined } };
      break;
    case 'PAUSE_SESSION':
      next = { ...state, lifecycle: 'paused' };
      break;
    case 'RESUME_SESSION':
      next = {
        ...state,
        lifecycle: demoCompleted(state) ? 'completed' : 'active',
        restart: { status: 'idle' },
        tour: { ...state.tour, paused: false, pauseReason: undefined },
      };
      break;
    case 'REQUEST_RESTART':
      next = {
        ...state,
        lifecycle: 'paused',
        restart: action.pendingApprovalRequestId
          ? { status: 'cleanup-required', pendingApprovalRequestId: action.pendingApprovalRequestId }
          : { status: 'ready' },
      };
      break;
    case 'RESTART_CLEANUP_SUCCEEDED':
      if (state.restart.status !== 'cleanup-required'
        || state.restart.pendingApprovalRequestId !== action.requestId) return state;
      next = { ...state, restart: { status: 'cleanup-confirmed', pendingApprovalRequestId: action.requestId } };
      break;
    case 'RESTART_CLEANUP_FAILED':
      if (state.restart.pendingApprovalRequestId !== action.requestId) return state;
      next = {
        ...state,
        lifecycle: 'paused',
        restart: { status: 'failed', pendingApprovalRequestId: action.requestId, error: action.error },
        tour: { ...state.tour, paused: true, pauseReason: 'restart-failed' },
      };
      break;
    case 'CONFIRM_RESTART':
      if (state.restart.status !== 'ready' && state.restart.status !== 'cleanup-confirmed') return state;
      return createDemoSession({
        runId: action.newRunId,
        now: at,
        role: 'delegate',
        route: { page: 'payment-inbox' },
        tourActive: state.tour.active,
      });
  }

  return normalizeSession({ ...next, updatedAt: at }, at);
}

const validRoute = (value: unknown): AppRoute | undefined => {
  try {
    const hash = formatAppRoute(value as AppRoute);
    return hash ? parseAppHash(hash) ?? undefined : undefined;
  } catch {
    return undefined;
  }
};

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? unique(value.filter((item): item is string => typeof item === 'string')) : [];

function hydrateProgress(value: unknown, runId: string, fallbackStatus: MissionStatus, now: number): MissionProgress {
  const raw = value && typeof value === 'object' ? value as Partial<MissionProgress> : {};
  const status: MissionStatus = ['locked', 'ready', 'active', 'complete'].includes(raw.status ?? '')
    ? raw.status as MissionStatus
    : fallbackStatus;
  return {
    ...emptyProgress(runId, status, now),
    ...raw,
    runId,
    status,
    packetIds: stringList(raw.packetIds),
    includedRequestIds: stringList(raw.includedRequestIds),
    reviewedRequestIds: stringList(raw.reviewedRequestIds),
    flaggedRequestIds: stringList(raw.flaggedRequestIds),
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : now,
  };
}

function hydrateSession(value: unknown): DemoSessionV2 | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<DemoSessionV2>;
  if (raw.version !== DEMO_SESSION_VERSION || typeof raw.runId !== 'string' || !raw.runId) return null;
  const now = typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now();
  const fresh = createDemoSession({ runId: raw.runId, now });
  const route = validRoute(raw.route) ?? fresh.route;
  const role: DemoRole = raw.role === 'auditor' ? 'auditor' : 'delegate';
  const currentMission = MISSION_ORDER.includes(raw.currentMission as DemoMissionKey)
    ? raw.currentMission as DemoMissionKey
    : 'routine';
  const missions = {
    routine: hydrateProgress(raw.missions?.routine, raw.runId, 'ready', now),
    approval: hydrateProgress(raw.missions?.approval, raw.runId, 'locked', now),
    violation: hydrateProgress(raw.missions?.violation, raw.runId, 'locked', now),
    audit: hydrateProgress(raw.missions?.audit, raw.runId, 'locked', now),
  };
  const lifecycle: DemoSessionLifecycle = ['active', 'paused', 'completed'].includes(raw.lifecycle ?? '')
    ? raw.lifecycle as DemoSessionLifecycle
    : 'active';
  const selected = raw.selected && typeof raw.selected === 'object' ? raw.selected : {};
  const session: DemoSessionV2 = {
    ...fresh,
    ...raw,
    version: DEMO_SESSION_VERSION,
    runId: raw.runId,
    lifecycle,
    currentMission,
    role,
    route,
    selected,
    missions,
    tour: {
      active: !!raw.tour?.active,
      step: Number.isFinite(raw.tour?.step) ? Math.max(0, Math.floor(raw.tour!.step)) : 0,
      paused: !!raw.tour?.paused,
      pauseReason: raw.tour?.pauseReason,
      expectedRoute: validRoute(raw.tour?.expectedRoute),
      expectedRole: raw.tour?.expectedRole === 'delegate' || raw.tour?.expectedRole === 'auditor'
        ? raw.tour.expectedRole : undefined,
    },
    restart: raw.restart && ['idle', 'ready', 'cleanup-required', 'cleanup-confirmed', 'failed'].includes(raw.restart.status)
      ? raw.restart : { status: 'idle' },
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now,
    updatedAt: now,
  };
  return normalizeSession(session, now);
}

function migrateLegacy(storage: StorageLike, now = Date.now()): DemoSessionV2 | null {
  let raw: unknown;
  try { raw = JSON.parse(storage.getItem(LEGACY_MISSIONS_KEY) ?? 'null'); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  let session = createDemoSession({ now });
  for (const key of MISSION_ORDER) {
    if ((raw as Record<string, unknown>)[key] === true) {
      session = demoSessionReducer(session, { type: 'LEGACY_COMPLETE', runId: session.runId, mission: key, at: now });
    }
  }
  return session;
}

export function loadDemoSession(storage: StorageLike | undefined = storageOrUndefined()): DemoSessionV2 | null {
  if (!storage) return null;
  try {
    const encoded = storage.getItem(DEMO_SESSION_KEY);
    if (encoded) return hydrateSession(JSON.parse(encoded));
  } catch { /* corrupt state falls through to legacy migration */ }
  const migrated = migrateLegacy(storage);
  // Persist once so repeated reads cannot manufacture a different run id while
  // an old `vg_missions` tab is being upgraded.
  if (migrated) {
    try { storage.setItem(DEMO_SESSION_KEY, JSON.stringify(migrated)); } catch { /* best effort */ }
  }
  return migrated;
}

/** Empty string means the browser has not started a demo run yet. */
export function getActiveDemoRunId(storage: StorageLike | undefined = storageOrUndefined()): string {
  return loadDemoSession(storage)?.runId ?? '';
}

export function saveDemoSession(
  session: DemoSessionV2,
  storage: StorageLike | undefined = storageOrUndefined(),
): boolean {
  if (!storage) return false;
  try { storage.setItem(DEMO_SESSION_KEY, JSON.stringify(session)); }
  catch { return false; }
  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('vg-demo-session', { detail: { runId: session.runId } }));
    }
  } catch { /* persistence succeeded; events are a progressive enhancement */ }
  return true;
}

export function clearDemoSession(storage: StorageLike | undefined = storageOrUndefined()): void {
  try {
    storage?.removeItem(DEMO_SESSION_KEY);
    storage?.removeItem(LEGACY_MISSIONS_KEY);
  } catch { /* best effort */ }
}

export function reduceAndSaveDemoSession(
  session: DemoSessionV2,
  action: DemoSessionAction,
  storage: StorageLike | undefined = storageOrUndefined(),
): DemoSessionV2 {
  const next = demoSessionReducer(session, action);
  if (next !== session) saveDemoSession(next, storage);
  return next;
}

export const DEMO_MISSION_ORDER = MISSION_ORDER as readonly DemoMissionKey[];
