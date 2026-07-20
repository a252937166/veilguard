import { useCallback, useEffect, useRef, useState } from 'react';
import './components/safe-decision.css';
import type { ChainRefreshResult, SpendRequest } from './App';
import type { DemoRole } from './demo';
import {
  hasCompleteAuditPacketCoverage,
  guidedTourStepAction,
  isMissionComplete,
  loadDemoSession,
  type DemoMissionKey,
  type DemoSessionAction,
  type DemoSessionV2,
} from './demo-session';
import { loadMissions, type MissionKey } from './missions';
import { scenarioByKey, type DemoScenarioKey } from './demo-scenarios';
import { Icon } from './icons';
import {
  legacyTabToRoute,
  routeToLegacyTab,
  sameAppRoute,
  type AppRoute,
  type LegacyTabName,
  type RouteObjectSelection,
} from './routes';

export type TabName = LegacyTabName;

export type MissionStep = {
  title: string;
  body: string;
  hint?: string;
  tab: TabName;
  route: AppRoute;
  role?: DemoRole;
  target?: string;
  mission?: DemoMissionKey;
  gate?: 'audit-packets-created';
  nextLabel?: string;
  mobileActionLabel?: string;
  waiting?: string;
};

export const MISSION_STEPS: readonly MissionStep[] = [
  {
    title: 'Launch Day Treasury Shift',
    tab: 'Delegate', route: { page: 'payment-inbox' }, role: 'delegate',
    body: 'You are the treasury Delegate. Review three real encrypted payment requests and follow each one from private policy evaluation to a verifiable on-chain consequence.',
    hint: 'No wallet is needed. The public demo key can request payments, but it cannot see or change the confidential policy.',
    nextLabel: 'Open Payment Inbox',
  },
  {
    title: 'CloudNode · routine payment',
    tab: 'Delegate', route: { page: 'payment-inbox' }, role: 'delegate', target: 'scenario-routine', mission: 'routine',
    body: 'Open the 25 cUSDC infrastructure invoice, review its request detail, then submit it. The TEE evaluates three private rules and the admissible payment executes.',
    waiting: 'Waiting for the executed request evidence…',
    mobileActionLabel: 'Submit the CloudNode payment',
    nextLabel: 'Continue to ShieldOps',
  },
  {
    title: 'ShieldOps · choose the consequence',
    tab: 'Delegate', route: { page: 'payment-inbox' }, role: 'delegate', target: 'scenario-approval', mission: 'approval',
    body: 'Open the 60 cUSDC emergency security request. Once the TEE reserves it in escrow, choose Approve or Reject. Your choice drives a real Safe 2-of-2 execution or refund.',
    hint: 'The constrained demo endpoint performs the selected committee action; the browser never receives a Safe owner key.',
    waiting: 'Waiting for your decision and its Safe receipt…',
    mobileActionLabel: 'Choose Approve or Reject',
    nextLabel: 'Continue to Atlas Contractor',
  },
  {
    title: 'Atlas Contractor · inspect the block',
    tab: 'Delegate', route: { page: 'payment-inbox' }, role: 'delegate', target: 'scenario-violation', mission: 'violation',
    body: 'Submit the 600 cUSDC new-vendor invoice. After the TEE blocks it, decrypt the private reason as the Delegate and compare it with the public chain view.',
    hint: 'The isolated violation delegate absorbs the anti-probing cooldown without freezing the other requests.',
    waiting: 'Waiting for the block and private-reason disclosure…',
    mobileActionLabel: 'Submit and inspect the blocked request',
    nextLabel: 'Continue to disclosure',
  },
  {
    title: 'Launch Day Review · create disclosure',
    tab: 'Admin', route: { page: 'disclosure-builder' }, role: 'delegate', target: 'disclosure-builder', gate: 'audit-packets-created',
    body: 'Choose the run-bound terminal requests to disclose. You control the scope; the bounded demo service validates it and performs the on-chain grant as the Finance Admin. Requests from different mandates become separate packets inside one clearly labeled UI bundle.',
    hint: 'You are not acting with an Admin key. The v1 schema always includes auto-limit, budget-left and reserve-floor, plus amount and reason for every selected request.',
    waiting: 'Waiting until all three Launch Day requests are covered by real packet IDs…',
    mobileActionLabel: 'Choose the disclosure scope',
    nextLabel: 'Continue as Auditor',
  },
  {
    title: 'Launch Day Review · audit packet',
    tab: 'Auditor', route: { page: 'audit-packets' }, role: 'auditor', target: 'packets', mission: 'audit',
    body: 'Unlock the disclosed values, review or flag every included request, and verify each immutable manifest. The UI bundle contains however many mandate-scoped on-chain packets the selected requests require.',
    hint: 'The v1 packet schema always snapshots auto-limit, budget-left and reserve-floor, plus amount and reason for each selected request.',
    waiting: 'Waiting for packet review and integrity verification…',
    mobileActionLabel: 'Review the disclosed packet values',
    nextLabel: 'Continue to Verify',
  },
  {
    title: 'Demo complete · verify the evidence',
    tab: 'Verify', route: { page: 'verify', flowId: 'launch-day' },
    body: 'Trace the direct, committee, blocked and audit flows. Each visible claim links back to the Sepolia request, proof-gated finalization, Safe decision or packet transaction.',
    nextLabel: 'Explore freely',
  },
] as const;

export type GuidedFocusIntent = {
  step: number;
  route: AppRoute;
  role?: DemoRole;
  selected: RouteObjectSelection;
  targetId: string;
  instruction: string;
};

export type ActiveGuidedFocusIntent = GuidedFocusIntent & { id: number };

export type GuidedStepPreparation = GuidedFocusIntent & {
  label: string;
  detail: string;
  phase: 'ready' | 'waiting';
};

const PAYMENT_MISSIONS = new Set<DemoMissionKey>(['routine', 'approval', 'violation']);

/**
 * Resolve the next safe guided action from run-bound evidence. This never
 * submits, signs or decrypts: it only names the exact object and control that
 * the user must act on next.
 */
export function deriveGuidedStepPreparation(
  session: DemoSessionV2,
  requests: readonly SpendRequest[],
  step: number,
): GuidedStepPreparation | null {
  const bounded = Math.min(Math.max(step, 0), MISSION_STEPS.length - 1);
  const missionStep = MISSION_STEPS[bounded];

  if (missionStep.mission && PAYMENT_MISSIONS.has(missionStep.mission)) {
    const mission = missionStep.mission as DemoScenarioKey;
    const scenario = scenarioByKey(mission);
    const progress = session.missions[mission];
    const request = progress.requestId
      ? requests.find((candidate) => String(candidate.id) === progress.requestId)
      : undefined;
    const selected: RouteObjectSelection = {
      scenarioKey: mission,
      ...(progress.requestId ? { requestId: progress.requestId } : {}),
    };
    const base = {
      step: bounded,
      role: 'delegate' as const,
      selected,
      targetId: `mission-${mission}`,
    };

    if (!progress.requestId) {
      return {
        ...base,
        route: { page: 'payment-inbox' },
        phase: 'ready',
        label: `Open ${scenario.vendor} invoice`,
        instruction: `Click “Submit confidential payment”`,
        detail: `Selects ${scenario.vendor} · ${scenario.amount} cUSDC · ${scenario.purpose}, then points to the submit button.`,
      };
    }

    if (mission === 'approval' && request?.state === 3) {
      return {
        ...base,
        route: { page: 'payment-detail', requestId: progress.requestId },
        phase: 'ready',
        label: `Open decision for request #${progress.requestId}`,
        instruction: 'Choose “Approve payment” or “Reject & return funds”',
        detail: 'Opens the reserved ShieldOps request and points to the real Safe 2-of-2 decision controls.',
      };
    }

    if (mission === 'violation' && request?.state === 4 && !progress.reasonDecrypted) {
      return {
        ...base,
        route: { page: 'payment-detail', requestId: progress.requestId },
        phase: 'ready',
        label: `Open blocked request #${progress.requestId}`,
        instruction: 'Click “Decrypt the private reason”',
        detail: 'Opens the run-bound Atlas request and points to the authorised Delegate-only disclosure action.',
      };
    }

    if (mission === 'approval' && request?.state === 2) {
      return {
        ...base,
        route: { page: 'payment-inbox' },
        phase: 'ready',
        label: 'Recover decision evidence',
        instruction: 'Click “Recover decision evidence”',
        detail: `Selects ShieldOps request #${progress.requestId}; recovery reuses its authenticated server attestation and never resubmits payment.`,
      };
    }

    if (mission === 'approval' && request?.state === 5) {
      return {
        ...base,
        route: { page: 'payment-inbox' },
        phase: 'ready',
        label: `Open cancelled request #${progress.requestId}`,
        instruction: 'Use the invoice action after receipt origin is verified',
        detail: 'Selects the cancelled ShieldOps attempt. Its run-bound attestation decides whether the safe next action is Recover, Retry or Open; timeout and unknown receipts are never presented as a user Reject.',
      };
    }

    if (request?.state === 6) {
      return {
        ...base,
        route: { page: 'payment-inbox' },
        phase: 'ready',
        label: `Retry ${scenario.vendor} invoice`,
        instruction: `Click “Retry invoice”`,
        detail: `Selects the explicitly expired request #${progress.requestId}; the existing duplicate-submission guard remains active.`,
      };
    }

    return {
      ...base,
      route: { page: 'payment-detail', requestId: progress.requestId },
      phase: 'waiting',
      label: `Open current request #${progress.requestId}`,
      instruction: 'Use “Refresh evidence” to reconcile the latest chain state',
      detail: `Opens the exact run-bound ${scenario.vendor} request. No new payment or wallet action is created.`,
    };
  }

  if (missionStep.gate === 'audit-packets-created') {
    return {
      step: bounded,
      route: { page: 'disclosure-builder' },
      role: 'delegate',
      selected: {},
      targetId: 'mission-disclosure',
      instruction: 'Click “Review selected scope”',
      phase: 'ready',
      label: 'Open preselected disclosure scope',
      detail: 'Selects every uncovered, terminal request in this run and points to the irreversible-scope review.',
    };
  }

  if (missionStep.mission === 'audit') {
    const runPacketIds = session.missions.audit.packetIds;
    const packetId = session.selected.packetId && runPacketIds.includes(session.selected.packetId)
      ? session.selected.packetId
      : runPacketIds[0];
    return {
      step: bounded,
      route: packetId ? { page: 'audit-detail', packetId } : { page: 'audit-packets' },
      role: 'auditor',
      selected: packetId ? { packetId } : {},
      targetId: 'mission-audit',
      instruction: packetId ? 'Click “Unlock disclosed values”' : 'Refresh the packet index',
      phase: packetId ? 'ready' : 'waiting',
      label: packetId ? `Open run packet #${packetId}` : 'Open Audit Packet Review',
      detail: packetId
        ? 'Opens a packet bound to this Launch Day run and points to its next incomplete review control.'
        : 'The run has no verified packet ID yet; the packet list remains read-only until chain evidence arrives.',
    };
  }

  return null;
}

export function isMissionRouteCompatible(
  step: MissionStep,
  route: AppRoute,
  session: DemoSessionV2,
): boolean {
  if (sameAppRoute(route, session.tour.expectedRoute ?? step.route)) return true;
  if (step.mission && PAYMENT_MISSIONS.has(step.mission)) {
    return route.page === 'payment-inbox'
      || (route.page === 'payment-detail'
        && session.missions[step.mission].requestId === route.requestId);
  }
  if (step.gate === 'audit-packets-created') return route.page === 'disclosure-builder';
  if (step.mission === 'audit') {
    return route.page === 'audit-packets'
      || (route.page === 'audit-detail' && session.missions.audit.packetIds.includes(route.packetId));
  }
  return sameAppRoute(route, step.route);
}

type DrawerSurfaceProps = {
  step: number;
  paused: boolean;
  missionDone: boolean;
  checking: boolean;
  checkResult: ChainRefreshResult | null;
  preparation: GuidedStepPreparation | null;
  guideStatus: 'idle' | 'locating' | 'found' | 'missing';
  onBack: () => void;
  onNext: () => void;
  onPrepare: () => void;
  onReturn: () => void;
  onCheckEvidence: () => void;
  onClose: () => void;
};

function DrawerSurface({
  step, paused, missionDone, checking, checkResult, preparation, guideStatus,
  onBack, onNext, onPrepare, onReturn, onCheckEvidence, onClose,
}: DrawerSurfaceProps) {
  const s = MISSION_STEPS[step];
  const gated = !!(s.mission || s.gate) && !missionDone;
  const actionStep = !!(s.mission || s.gate);
  const [expanded, setExpanded] = useState(true);
  useEffect(() => setExpanded(true), [step]);
  useEffect(() => {
    if (guideStatus === 'missing') setExpanded(true);
    else if (guideStatus === 'found' && actionStep && !paused) setExpanded(false);
  }, [actionStep, guideStatus, paused]);
  const compactTitle = missionDone
    ? `${s.title} complete`
    : s.mobileActionLabel ?? s.title;
  const checkedAt = checkResult
    ? new Date(checkResult.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '';
  const checkMessage = checkResult?.status === 'changed'
    ? `New on-chain evidence found${checkResult.changedRequestIds.length ? ` for request${checkResult.changedRequestIds.length === 1 ? '' : 's'} ${checkResult.changedRequestIds.map((id) => `#${id}`).join(', ')}` : ''} · checked ${checkedAt}`
    : checkResult?.status === 'unchanged'
      ? `No new evidence yet · checked ${checkedAt}`
      : checkResult?.status === 'failed'
        ? `Chain check failed: ${checkResult.message} · checked ${checkedAt}`
        : '';
  return (
    <aside className={`tour mission-drawer ${actionStep && !paused && !expanded ? 'is-action-compact' : ''} ${s.mission === 'approval' ? 'is-decision-step' : ''}`} aria-label="Launch Day demo mission">
      <div className="mission-compact-rail">
        <span className="mission-compact-count">Mission {step + 1}/{MISSION_STEPS.length}</span>
        <b title={compactTitle}>{missionDone ? '✓ ' : ''}{compactTitle}</b>
        {missionDone && step < MISSION_STEPS.length - 1 && (
          <button type="button" className="btn small primary mission-compact-continue" onClick={onNext}>Continue</button>
        )}
        <button
          type="button"
          className="icon-button mission-compact-toggle"
          aria-expanded={expanded}
          aria-controls="mission-drawer-content"
          aria-label="Expand mission details"
          onClick={() => setExpanded(true)}
        >⌃</button>
      </div>
      <div id="mission-drawer-content" className="mission-drawer-content">
      <div className="tour-head">
        <div
          className="tour-progress"
          role="progressbar"
          aria-label="Launch Day mission progress"
          aria-valuemin={1}
          aria-valuemax={MISSION_STEPS.length}
          aria-valuenow={step + 1}
          aria-valuetext={`Step ${step + 1} of ${MISSION_STEPS.length}`}
        >
          {MISSION_STEPS.map((item, i) => (
            <span
              key={item.title}
              className={`tdot ${i === step ? 'on' : ''} ${i < step ? 'done' : ''}`}
              aria-hidden="true"
            />
          ))}
        </div>
        <div className="tour-step-of">{step + 1} / {MISSION_STEPS.length}</div>
        {actionStep && !paused && (
          <button
            type="button"
            className="tour-collapse"
            aria-expanded={expanded}
            aria-controls="mission-drawer-content"
            onClick={() => setExpanded(false)}
          >Collapse</button>
        )}
        <button className="tour-x" onClick={onClose} title="Close mission drawer" aria-label="Close mission drawer">×</button>
      </div>

      <div className="tour-body" aria-live="polite">
        {paused ? (
          <>
            <h3>Mission paused</h3>
            <p>You left the route or role required by this step. Your on-chain progress is safe and remains bound to this demo run.</p>
            <p className="tour-hint">Return to the current mission to continue from the same request.</p>
          </>
        ) : (
          <>
            <h3>{s.title}</h3>
            <p>{s.body}</p>
            {s.hint && <p className="tour-hint">{s.hint}</p>}
          </>
        )}
      </div>

      <div className="tour-nav">
        {paused ? (
          <button className="btn small primary" onClick={onReturn}>Return to current mission</button>
        ) : (
          <>
            {gated && (
              <div className={`tour-next-action ${preparation?.phase ?? 'waiting'}`} role="status">
                <span className="tour-next-icon" aria-hidden="true">
                  {preparation?.phase === 'ready' ? <Icon name="tour" size={16} /> : <span className="spin" />}
                </span>
                <span>
                  <b>{preparation?.phase === 'ready' ? 'Ready · your action is needed' : 'Waiting for chain evidence'}</b>
                  <small>{preparation?.detail ?? s.waiting ?? 'Waiting for on-chain evidence…'}</small>
                </span>
              </div>
            )}
            {gated && preparation && (
              <button className="btn small primary tour-prepare" onClick={() => { setExpanded(false); onPrepare(); }}>
                <Icon name="tour" size={15} /> {preparation.label}
              </button>
            )}
            {gated && guideStatus !== 'idle' && (
              <span className={`tour-guide-result ${guideStatus === 'missing' ? 'bad' : ''}`} role={guideStatus === 'missing' ? 'alert' : 'status'}>
                {guideStatus === 'locating' && 'Opening the object and locating its next control…'}
                {guideStatus === 'found' && 'Next action highlighted · keyboard focus moved to the real control.'}
                {guideStatus === 'missing' && 'The action is still loading. Use the button above to try locating it again.'}
              </span>
            )}
            {gated && (
              <button className="btn small ghost tour-recheck" hidden={preparation?.phase !== 'waiting'} disabled={checking} onClick={onCheckEvidence}>
                {checking ? <><span className="spin" aria-hidden="true" /> Checking chain…</> : checkResult?.status === 'failed' ? 'Retry chain check' : 'Check chain state'}
              </button>
            )}
            {gated && checkMessage && (
              <span className={`tour-check-result ${checkResult?.status === 'failed' ? 'bad' : ''}`} role={checkResult?.status === 'failed' ? 'alert' : 'status'}>
                {checkMessage}
              </span>
            )}
            {!gated && actionStep && missionDone && (
              <span className="status-badge ok" role="status">Evidence confirmed</span>
            )}
            <button className="btn small ghost" disabled={step === 0} onClick={onBack}>← Back</button>
            {!gated && step < MISSION_STEPS.length - 1 && (
              <button className="btn small primary" onClick={onNext}>{s.nextLabel ?? 'Continue'}</button>
            )}
            {step === MISSION_STEPS.length - 1 && (
              <button className="btn small primary" onClick={onClose}>{s.nextLabel ?? 'Done'}</button>
            )}
          </>
        )}
      </div>
      </div>
    </aside>
  );
}

export type MissionDrawerProps = {
  session: DemoSessionV2;
  dispatch: (action: DemoSessionAction) => void;
  currentRoute: AppRoute;
  currentRole: DemoRole | null;
  requests: SpendRequest[];
  /** Route + role must be applied as one navigation intent by the App shell. */
  onNavigate: (target: { route: AppRoute; role?: DemoRole }) => void;
  onRefresh: () => Promise<ChainRefreshResult>;
  onGuide: (intent: GuidedFocusIntent | null) => void;
  guideStatus?: 'idle' | 'locating' | 'found' | 'missing';
  onClose: () => void;
};

/**
 * Run-bound mission drawer for the new router. It only advances on strict
 * request/packet evidence and pauses after the user leaves an arrived target.
 */
export function MissionDrawer({
  session, dispatch, currentRoute, currentRole, requests, onNavigate, onRefresh,
  onGuide, guideStatus = 'idle', onClose,
}: MissionDrawerProps) {
  const step = Math.min(Math.max(session.tour.step, 0), MISSION_STEPS.length - 1);
  const s = MISSION_STEPS[step];
  const arrived = useRef(false);
  const arrivedStep = useRef(step);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<ChainRefreshResult | null>(null);
  const preparation = deriveGuidedStepPreparation(session, requests, step);
  const missionDone = s.mission
    ? isMissionComplete(session, s.mission, { strict: true })
    : s.gate === 'audit-packets-created'
      ? hasCompleteAuditPacketCoverage(session)
      : true;

  const enterStep = useCallback((nextStep: number, guide = false) => {
    const bounded = Math.min(Math.max(nextStep, 0), MISSION_STEPS.length - 1);
    const target = MISSION_STEPS[bounded];
    const prepared = deriveGuidedStepPreparation(session, requests, bounded);
    const route = prepared?.route ?? target.route;
    const role = prepared?.role ?? target.role;
    arrived.current = false;
    dispatch(guidedTourStepAction(session, {
      step: bounded,
      route,
      role,
      selected: prepared?.selected,
    }));
    onGuide(guide && prepared ? prepared : null);
    onNavigate({ route, role });
  }, [dispatch, onGuide, onNavigate, requests, session]);

  useEffect(() => {
    // A page-level CTA advances the run by committing the next step and then
    // navigating. Those two updates (session step + router route + shell role)
    // can land on different frames, so the drawer briefly sees a mixed state
    // that belongs to no single step. Two guards keep that travel from reading
    // as the user abandoning the tour:
    //  1. when the step pointer itself moves, the previous step's "arrived"
    //     latch is stale — reset it so a not-yet-landed route/role can't pause;
    //  2. while the current route is still a valid target for ANY mission step,
    //     the run is in transit between steps, not leaving the guided flow.
    if (arrivedStep.current !== step) {
      arrivedStep.current = step;
      arrived.current = false;
    }
    if (session.tour.paused) return;
    const routeMatches = isMissionRouteCompatible(s, currentRoute, session);
    const roleMatches = !s.role || currentRole === s.role;
    if (routeMatches && roleMatches) {
      arrived.current = true;
    } else if (arrived.current) {
      const inTransit = MISSION_STEPS.some((missionStep) =>
        isMissionRouteCompatible(missionStep, currentRoute, session));
      if (!inTransit) {
        dispatch({
          type: 'PAUSE_TOUR', runId: session.runId,
          reason: routeMatches ? 'role-change' : 'navigation',
        });
      }
    }
  }, [currentRole, currentRoute, dispatch, s, session, step]);

  useEffect(() => setCheckResult(null), [step]);

  useEffect(() => {
    if (missionDone) onGuide(null);
  }, [missionDone, onGuide]);

  const checkEvidence = async () => {
    if (checking) return;
    setChecking(true);
    try {
      setCheckResult(await onRefresh());
    } catch (reason: any) {
      setCheckResult({
        status: 'failed', checkedAt: Date.now(),
        message: reason?.message ?? String(reason), changedRequestIds: [],
      });
    } finally {
      setChecking(false);
    }
  };

  const returnToMission = () => {
    dispatch({ type: 'RETURN_TO_MISSION', runId: session.runId });
    if (preparation) {
      dispatch(guidedTourStepAction(session, {
        step,
        route: preparation.route,
        role: preparation.role,
        selected: preparation.selected,
      }));
      onGuide(preparation);
      onNavigate({ route: preparation.route, role: preparation.role });
    } else {
      onGuide(null);
      onNavigate({ route: s.route, role: s.role });
    }
    arrived.current = false;
  };

  const prepareCurrent = () => {
    if (!preparation) return;
    dispatch(guidedTourStepAction(session, {
      step,
      route: preparation.route,
      role: preparation.role,
      selected: preparation.selected,
    }));
    onGuide(preparation);
    onNavigate({ route: preparation.route, role: preparation.role });
    arrived.current = false;
  };

  return (
    <DrawerSurface
      step={step}
      paused={session.tour.paused}
      missionDone={missionDone}
      checking={checking}
      checkResult={checkResult}
      preparation={preparation}
      guideStatus={guideStatus}
      onBack={() => enterStep(step - 1)}
      onNext={() => enterStep(step + 1, true)}
      onPrepare={prepareCurrent}
      onReturn={returnToMission}
      onCheckEvidence={checkEvidence}
      onClose={() => {
        onGuide(null);
        dispatch({ type: 'CLOSE_TOUR', runId: session.runId });
        onClose();
      }}
    />
  );
}

/** Props retained while App.tsx moves from local tabs to typed hash routes. */
export type GuidedTourProps = {
  step: number;
  setStep: (n: number) => void;
  onGoToTab: (t: TabName) => void;
  onClose: () => void;
  requests: SpendRequest[];
  demoRole: DemoRole | null;
  startDemo: (r: DemoRole) => void;
  currentTab?: TabName;
  onNavigate?: (target: { tab: TabName; role?: DemoRole }) => void;
};

/**
 * Compatibility adapter for the current tab shell. It has the same no-skip
 * contract as MissionDrawer; adding `currentTab` enables leave-to-pause.
 */
export function GuidedTour({
  step, setStep, onGoToTab, onClose, demoRole, startDemo, currentTab, onNavigate,
}: GuidedTourProps) {
  const boundedStep = Math.min(Math.max(step, 0), MISSION_STEPS.length - 1);
  const s = MISSION_STEPS[boundedStep];
  const [, setMissionTick] = useState(0);
  const [paused, setPaused] = useState(false);
  const arrived = useRef(false);
  const currentSession = loadDemoSession();
  const missionDone = s.mission
    ? loadMissions()[s.mission as MissionKey]
    : s.gate === 'audit-packets-created'
      ? !!currentSession
        && hasCompleteAuditPacketCoverage(currentSession)
      : true;

  const navigate = useCallback((target: MissionStep) => {
    if (onNavigate) onNavigate({ tab: target.tab, role: target.role });
    else {
      if (target.role && demoRole !== target.role) startDemo(target.role);
      onGoToTab(target.tab);
    }
  }, [demoRole, onGoToTab, onNavigate, startDemo]);

  useEffect(() => {
    arrived.current = false;
    setPaused(false);
    navigate(s);
    // App's existing role/tab setters are intentionally adapted at this edge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundedStep]);

  useEffect(() => {
    document.querySelectorAll('.tour-target').forEach((el) => el.classList.remove('tour-target'));
    if (paused || !s.target) return;
    const timer = setTimeout(() => {
      const element = document.querySelector(`[data-tour="${s.target}"]`);
      if (element) {
        element.classList.add('tour-target');
        element.scrollIntoView({
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
          block: 'center',
        });
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      document.querySelectorAll('.tour-target').forEach((el) => el.classList.remove('tour-target'));
    };
  }, [boundedStep, paused, s.target]);

  useEffect(() => {
    const listener = () => setMissionTick((value) => value + 1);
    window.addEventListener('vg-missions', listener);
    window.addEventListener('vg-demo-session', listener);
    return () => {
      window.removeEventListener('vg-missions', listener);
      window.removeEventListener('vg-demo-session', listener);
    };
  }, []);

  useEffect(() => {
    if (!currentTab) return;
    const matches = currentTab === s.tab && (!s.role || demoRole === s.role);
    if (matches) arrived.current = true;
    else if (arrived.current) setPaused(true);
  }, [currentTab, demoRole, s.role, s.tab]);

  return (
    <DrawerSurface
      step={boundedStep}
      paused={paused}
      missionDone={missionDone}
      checking={false}
      checkResult={null}
      preparation={null}
      guideStatus="idle"
      onBack={() => setStep(Math.max(0, boundedStep - 1))}
      onNext={() => setStep(Math.min(MISSION_STEPS.length - 1, boundedStep + 1))}
      onPrepare={() => navigate(s)}
      onReturn={() => { setPaused(false); arrived.current = false; navigate(s); }}
      onCheckEvidence={() => window.dispatchEvent(new CustomEvent('vg-refresh-requested'))}
      onClose={onClose}
    />
  );
}

export function useTour() {
  const [active, setActive] = useState(false);
  const [step, setStep] = useState(0);
  const start = useCallback(() => { setStep(0); setActive(true); }, []);
  const close = useCallback(() => setActive(false), []);
  return { active, step, setStep, start, close };
}

/** Route helpers colocated for callers migrating the compatibility adapter. */
export const tourTabForRoute = (route: AppRoute): TabName => routeToLegacyTab(route);
export const tourRouteForTab = (tab: TabName): AppRoute => legacyTabToRoute(tab);
