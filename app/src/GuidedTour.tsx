import { useCallback, useEffect, useRef, useState } from 'react';
import type { SpendRequest } from './App';
import type { DemoRole } from './demo';
import {
  isMissionComplete,
  loadDemoSession,
  type DemoMissionKey,
  type DemoSessionAction,
  type DemoSessionV2,
} from './demo-session';
import { loadMissions, type MissionKey } from './missions';
import {
  legacyTabToRoute,
  routeToLegacyTab,
  sameAppRoute,
  type AppRoute,
  type LegacyTabName,
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
    tab: 'Delegate', route: { page: 'payment-inbox' }, target: 'scenario-routine', mission: 'routine',
    body: 'Open the 25 cUSDC infrastructure invoice, review its request detail, then submit it. The TEE evaluates three private rules and the admissible payment executes.',
    waiting: 'Waiting for the executed request evidence…',
  },
  {
    title: 'ShieldOps · choose the consequence',
    tab: 'Delegate', route: { page: 'payment-inbox' }, target: 'scenario-approval', mission: 'approval',
    body: 'Open the 60 cUSDC emergency security request. Once the TEE reserves it in escrow, choose Approve or Reject. Your choice drives a real Safe 2-of-2 execution or refund.',
    hint: 'The constrained demo endpoint performs the selected committee action; the browser never receives a Safe owner key.',
    waiting: 'Waiting for your decision and its Safe receipt…',
  },
  {
    title: 'Atlas Contractor · inspect the block',
    tab: 'Delegate', route: { page: 'payment-inbox' }, target: 'scenario-violation', mission: 'violation',
    body: 'Submit the 600 cUSDC new-vendor invoice. After the TEE blocks it, decrypt the private reason as the Delegate and compare it with the public chain view.',
    hint: 'The isolated violation delegate absorbs the anti-probing cooldown without freezing the other requests.',
    waiting: 'Waiting for the block and private-reason disclosure…',
  },
  {
    title: 'Launch Day Review · create disclosure',
    tab: 'Admin', route: { page: 'disclosure-builder' }, role: 'delegate', target: 'disclosure-builder', gate: 'audit-packets-created',
    body: 'Select the three run-bound terminal requests, review the immutable v1 scope, then create the smallest real packet set. Requests from different mandates become separate on-chain packets inside one clearly labeled UI bundle.',
    hint: 'The v1 schema always includes auto-limit, budget-left and reserve-floor, plus amount and reason for every selected request.',
    waiting: 'Waiting for the run-bound packet IDs…',
  },
  {
    title: 'Launch Day Review · audit packet',
    tab: 'Auditor', route: { page: 'audit-packets' }, role: 'auditor', target: 'packets', mission: 'audit',
    body: 'Unlock the disclosed values, review or flag every included request, and verify the immutable manifest. The UI bundle may contain two clearly identified on-chain packets.',
    hint: 'The v1 packet schema always snapshots auto-limit, budget-left and reserve-floor, plus amount and reason for each selected request.',
    waiting: 'Waiting for packet review and integrity verification…',
  },
  {
    title: 'Demo complete · verify the evidence',
    tab: 'Verify', route: { page: 'verify', flowId: 'launch-day' },
    body: 'Trace the direct, committee, blocked and audit flows. Each visible claim links back to the Sepolia request, proof-gated finalization, Safe decision or packet transaction.',
    nextLabel: 'Explore freely',
  },
] as const;

type DrawerSurfaceProps = {
  step: number;
  paused: boolean;
  missionDone: boolean;
  checking: boolean;
  onBack: () => void;
  onNext: () => void;
  onReturn: () => void;
  onCheckEvidence: () => void;
  onClose: () => void;
};

function DrawerSurface({
  step, paused, missionDone, checking, onBack, onNext, onReturn, onCheckEvidence, onClose,
}: DrawerSurfaceProps) {
  const s = MISSION_STEPS[step];
  const gated = !!(s.mission || s.gate) && !missionDone;
  return (
    <aside className="tour mission-drawer" aria-label="Launch Day demo mission">
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
        <div className="tour-step-of">Launch Day · {step + 1} / {MISSION_STEPS.length}</div>
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
            <button className="btn small ghost" disabled={step === 0} onClick={onBack}>← Back</button>
            {gated && (
              <span className="muted tour-wait" role="status">
                <span className="spin" aria-hidden="true" /> {s.waiting ?? 'Waiting for on-chain evidence…'}
              </span>
            )}
            {gated && (
              <button className="btn small ghost tour-recheck" disabled={checking} onClick={onCheckEvidence}>
                {checking ? <><span className="spin" aria-hidden="true" /> Checking chain…</> : 'Check chain state'}
              </button>
            )}
            {!gated && step < MISSION_STEPS.length - 1 && (
              <button className="btn small primary" onClick={onNext}>{s.nextLabel ?? 'Continue'}</button>
            )}
            {step === MISSION_STEPS.length - 1 && (
              <button className="btn small primary" onClick={onClose}>{s.nextLabel ?? 'Done'}</button>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

export type MissionDrawerProps = {
  session: DemoSessionV2;
  dispatch: (action: DemoSessionAction) => void;
  currentRoute: AppRoute;
  currentRole: DemoRole | null;
  /** Route + role must be applied as one navigation intent by the App shell. */
  onNavigate: (target: { route: AppRoute; role?: DemoRole }) => void;
  onRefresh: () => void;
  onClose: () => void;
};

/**
 * Run-bound mission drawer for the new router. It only advances on strict
 * request/packet evidence and pauses after the user leaves an arrived target.
 */
export function MissionDrawer({
  session, dispatch, currentRoute, currentRole, onNavigate, onRefresh, onClose,
}: MissionDrawerProps) {
  const step = Math.min(Math.max(session.tour.step, 0), MISSION_STEPS.length - 1);
  const s = MISSION_STEPS[step];
  const arrived = useRef(false);
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [checking, setChecking] = useState(false);
  const missionDone = s.mission
    ? isMissionComplete(session, s.mission, { strict: true })
    : s.gate === 'audit-packets-created'
      ? session.missions.audit.packetIds.length > 0
        && session.missions.audit.includedRequestIds.length === 3
      : true;

  const enterStep = useCallback((nextStep: number) => {
    const bounded = Math.min(Math.max(nextStep, 0), MISSION_STEPS.length - 1);
    const target = MISSION_STEPS[bounded];
    arrived.current = false;
    dispatch({
      type: 'TOUR_STEP', runId: session.runId, step: bounded,
      route: target.route, role: target.role,
    });
    onNavigate({ route: target.route, role: target.role });
  }, [dispatch, onNavigate, session.runId]);

  useEffect(() => {
    if (session.tour.paused) return;
    const routeMatches = sameAppRoute(currentRoute, s.route);
    const roleMatches = !s.role || currentRole === s.role;
    if (routeMatches && roleMatches) {
      arrived.current = true;
    } else if (arrived.current) {
      dispatch({
        type: 'PAUSE_TOUR', runId: session.runId,
        reason: routeMatches ? 'role-change' : 'navigation',
      });
    }
  }, [currentRole, currentRoute, dispatch, s.role, s.route, session.runId, session.tour.paused]);

  useEffect(() => {
    if ((!s.mission && !s.gate) || !missionDone || session.tour.paused || step >= MISSION_STEPS.length - 1) return;
    advanceTimer.current = setTimeout(() => enterStep(step + 1), 700);
    return () => { if (advanceTimer.current) clearTimeout(advanceTimer.current); };
  }, [enterStep, missionDone, s.gate, s.mission, session.tour.paused, step]);

  useEffect(() => () => {
    if (checkTimer.current) clearTimeout(checkTimer.current);
  }, []);

  const checkEvidence = () => {
    if (checking) return;
    setChecking(true);
    onRefresh();
    checkTimer.current = setTimeout(() => setChecking(false), 1_500);
  };

  const returnToMission = () => {
    dispatch({ type: 'RETURN_TO_MISSION', runId: session.runId });
    onNavigate({ route: s.route, role: s.role });
    arrived.current = false;
  };

  return (
    <DrawerSurface
      step={step}
      paused={session.tour.paused}
      missionDone={missionDone}
      checking={checking}
      onBack={() => enterStep(step - 1)}
      onNext={() => enterStep(step + 1)}
      onReturn={returnToMission}
      onCheckEvidence={checkEvidence}
      onClose={() => {
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
  const [missionTick, setMissionTick] = useState(0);
  const [paused, setPaused] = useState(false);
  const arrived = useRef(false);
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentSession = loadDemoSession();
  const missionDone = s.mission
    ? loadMissions()[s.mission as MissionKey]
    : s.gate === 'audit-packets-created'
      ? !!currentSession
        && currentSession.missions.audit.packetIds.length > 0
        && currentSession.missions.audit.includedRequestIds.length === 3
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
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
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

  useEffect(() => {
    if ((!s.mission && !s.gate) || !missionDone || paused || boundedStep >= MISSION_STEPS.length - 1) return;
    advanceTimer.current = setTimeout(() => setStep(boundedStep + 1), 700);
    return () => { if (advanceTimer.current) clearTimeout(advanceTimer.current); };
  }, [boundedStep, missionDone, missionTick, paused, s.gate, s.mission, setStep]);

  return (
    <DrawerSurface
      step={boundedStep}
      paused={paused}
      missionDone={missionDone}
      checking={false}
      onBack={() => setStep(Math.max(0, boundedStep - 1))}
      onNext={() => setStep(Math.min(MISSION_STEPS.length - 1, boundedStep + 1))}
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
