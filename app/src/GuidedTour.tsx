import { useEffect, useRef, useState } from 'react';
import type { SpendRequest } from './App';
import type { DemoRole } from './demo';
import { demoAddress } from './demo';
import { loadMissions, type MissionKey } from './missions';

export type TabName = 'Dashboard' | 'Delegate' | 'Admin' | 'Signer' | 'Auditor' | 'Verify' | 'Get Funds';

/**
 * Task-driven guided demo. Each step DOES things (enters the demo role,
 * switches tabs, highlights the exact control) and auto-advances when the
 * on-chain state shows the user completed the action — not a page-flipping
 * manual.
 */
type Step = {
  title: string;
  body: string;
  hint?: string;
  tab: TabName;
  role?: DemoRole;          // demo role to auto-enter on this step
  target?: string;          // [data-tour=…] element to highlight & scroll to
  auto?: 'submitted' | 'settled';  // auto-advance on raw request progress
  mission?: MissionKey;     // auto-advance when this mission completes
  nextLabel?: string;
  waiting?: string;         // spinner label while waiting for `auto`/`mission`
};

const STEPS: Step[] = [
  {
    title: "You're the Delegate now",
    tab: 'Delegate', role: 'delegate',
    body: "We put you in the shoes of a real spender: a shared, pre-funded demo account that holds an encrypted mandate. You never see the policy — it decides for you. Your mission: collect all three outcomes.",
    hint: 'No wallet needed — the demo key signs locally. The policy, not key custody, is what contains you.',
    nextLabel: 'Start mission 1 →',
  },
  {
    title: 'Mission 1 · Routine payment',
    tab: 'Delegate', target: 'scenario-routine', mission: 'routine',
    body: 'Press ▶ Run scenario on the Routine payment card. The amount is encrypted in your browser, the TEE checks it against the secret policy, and a keeper publishes the result — it auto-executes.',
    waiting: 'run it — this step completes by itself…',
    nextLabel: 'Skip ahead',
  },
  {
    title: 'Mission 2 · Approval challenge',
    tab: 'Delegate', target: 'scenario-approval', mission: 'approval',
    body: 'Now run the Approval challenge. This payment is above the secret auto-limit, so funds go to escrow while the treasury committee reviews (~20s) and approves with a REAL Safe 2-of-2 — watch the stages tick.',
    hint: 'Owner keys never touch the browser — the committee signs server-side, on-chain, verifiably.',
    waiting: 'escrow → committee review → 2-of-2 execution…',
    nextLabel: 'Skip ahead',
  },
  {
    title: 'Mission 3 · Policy violation',
    tab: 'Delegate', target: 'scenario-violation', mission: 'violation',
    body: 'Run the Policy violation and try to overspend. The TEE blocks it — no funds move — and you finish the mission by pressing 🔓 Decrypt the private reason on the receipt. Only you can read it.',
    hint: 'This scenario runs on its own sandboxed delegate, so the block never freezes the other missions.',
    waiting: 'waiting for the block + your decrypt…',
    nextLabel: 'Skip ahead',
  },
  {
    title: "Final mission · You're the Auditor",
    tab: 'Auditor', role: 'auditor', target: 'packets',
    body: 'The finance admin granted this account an immutable disclosure snapshot. Press 🔓 Decrypt this packet — you read exactly those values, forever, and nothing else. Selective disclosure instead of all-or-nothing transparency.',
    mission: 'audit',
    waiting: 'waiting for your decrypt…',
    nextLabel: 'Skip ahead',
  },
  {
    title: 'Demo complete — believe none of it, verify',
    tab: 'Verify',
    body: 'Everything you just did is on Sepolia: request txs, proof-gated finalizations, real 2-of-2 governance executions. This page links every hash. Confidential numbers, publicly verifiable process.',
    nextLabel: 'Explore freely ✓',
  },
];

export function GuidedTour({
  step, setStep, onGoToTab, onClose, requests, demoRole, startDemo,
}: {
  step: number;
  setStep: (n: number) => void;
  onGoToTab: (t: TabName) => void;
  onClose: () => void;
  requests: SpendRequest[];
  demoRole: DemoRole | null;
  startDemo: (r: DemoRole) => void;
}) {
  const s = STEPS[step];
  const baselineId = useRef<bigint>(0n);
  const [waited, setWaited] = useState(false);

  // step entry: enter the right role, switch tab, snapshot baseline, highlight target
  useEffect(() => {
    if (s.role && demoRole !== s.role) startDemo(s.role);
    onGoToTab(s.tab);
    if (s.auto === 'submitted') {
      baselineId.current = requests.reduce((m, r) => (r.id > m ? r.id : m), 0n);
    }
    setWaited(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // highlight + scroll to the step's target control
  useEffect(() => {
    document.querySelectorAll('.tour-target').forEach((el) => el.classList.remove('tour-target'));
    if (!s.target) return;
    const t = setTimeout(() => {
      const el = document.querySelector(`[data-tour="${s.target}"]`);
      if (el) { el.classList.add('tour-target'); el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    }, 350);
    return () => { clearTimeout(t); document.querySelectorAll('.tour-target').forEach((el) => el.classList.remove('tour-target')); };
  }, [step, s.target]);

  // auto-advance on real on-chain progress OR mission completion
  const demoDelegate = demoAddress('delegate').toLowerCase();
  const [missionTick, setMissionTick] = useState(0);
  useEffect(() => {
    const on = () => setMissionTick((t) => t + 1);
    window.addEventListener('vg-missions', on);
    return () => window.removeEventListener('vg-missions', on);
  }, []);
  useEffect(() => {
    if (s.mission) {
      if (loadMissions()[s.mission]) { setWaited(true); setTimeout(() => setStep(step + 1), 900); }
      return;
    }
    if (!s.auto) return;
    const mine = requests.filter((r) => r.delegate.toLowerCase() === demoDelegate);
    if (s.auto === 'submitted') {
      if (mine.some((r) => r.id > baselineId.current)) { setWaited(true); setTimeout(() => setStep(step + 1), 600); }
    } else if (s.auto === 'settled') {
      const newest = mine.reduce<SpendRequest | null>((a, r) => (!a || r.id > a.id ? r : a), null);
      if (newest && newest.state !== 1) { setWaited(true); setTimeout(() => setStep(step + 1), 600); }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requests, step, missionTick]);

  return (
    <div className="tour">
      <div className="tour-head">
        <div className="tour-progress">
          {STEPS.map((_, i) => (
            <span key={i} className={`tdot ${i === step ? 'on' : ''} ${i < step ? 'done' : ''}`} onClick={() => setStep(i)} />
          ))}
        </div>
        <div className="tour-step-of">Interactive demo · step {step + 1} / {STEPS.length}</div>
        <button className="tour-x" onClick={onClose} title="Exit demo">✕</button>
      </div>
      <div className="tour-body">
        <h3>{s.title}</h3>
        <p>{s.body}</p>
        {s.hint && <p className="tour-hint">💡 {s.hint}</p>}
      </div>
      <div className="tour-nav">
        <button className="btn small ghost" disabled={step === 0} onClick={() => setStep(step - 1)}>← Back</button>
        {(s.auto || s.mission) && !waited && <span className="muted tour-wait"><span className="spin" /> {s.waiting}</span>}
        {step < STEPS.length - 1
          ? <button className={`btn small ${(s.auto || s.mission) ? 'ghost' : 'primary'}`} onClick={() => setStep(step + 1)}>{s.nextLabel ?? 'Next →'}</button>
          : <button className="btn small primary" onClick={onClose}>{s.nextLabel ?? 'Done ✓'}</button>}
      </div>
    </div>
  );
}

export function useTour() {
  const [active, setActive] = useState(false);
  const [step, setStep] = useState(0);
  const start = () => { setStep(0); setActive(true); };
  const close = () => setActive(false);
  return { active, step, setStep, start, close };
}
