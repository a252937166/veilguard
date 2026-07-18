import { useEffect, useRef, useState } from 'react';
import type { SpendRequest } from './App';
import type { DemoRole } from './demo';
import { demoAddress } from './demo';

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
  auto?: 'submitted' | 'settled';  // auto-advance condition
  nextLabel?: string;
  waiting?: string;         // spinner label while waiting for `auto`
};

const STEPS: Step[] = [
  {
    title: "You're the Delegate now",
    tab: 'Delegate', role: 'delegate',
    body: "We put you in the shoes of a real spender: a shared, pre-funded demo account that holds an encrypted mandate. You never see the policy — it decides for you. Let's send a confidential payment.",
    hint: 'No wallet needed — the demo key signs locally. The policy, not key custody, is what contains you.',
    nextLabel: "Let's pay someone →",
  },
  {
    title: 'Run the first scenario',
    tab: 'Delegate', target: 'scenario-routine',
    body: 'Press ▶ Run scenario on the Routine payment card. Your amount is encrypted in the browser before it leaves — the chain will only ever see a ciphertext handle.',
    auto: 'submitted',
    waiting: 'waiting for you to run it…',
    nextLabel: 'I ran it',
  },
  {
    title: 'The TEE is deciding',
    tab: 'Delegate',
    body: 'Your encrypted amount is being checked against the encrypted policy inside a Trusted Execution Environment — budget, balance and reserve rules, all on ciphertext. A keeper then publishes the signed decision proof on-chain. Nothing to do; the outcome appears by itself.',
    auto: 'settled',
    waiting: 'TEE computing → keeper publishing the proof…',
    nextLabel: 'Skip the wait',
  },
  {
    title: 'Outcome revealed — amount still secret',
    tab: 'Delegate', target: 'outcome',
    body: 'The chain learned exactly one of three words: EXECUTED, APPROVAL REQUIRED, or BLOCKED — never the number. 25 auto-executes; try 60 to watch the treasury committee approve a real 2-of-2, or 600 to get blocked with a private reason.',
    hint: 'Escalations are approved server-side by the real committee within ~1 min — owner keys are never in the browser.',
    nextLabel: 'Continue as the Auditor →',
  },
  {
    title: "Now you're the Auditor",
    tab: 'Auditor', role: 'auditor', target: 'packets',
    body: 'The finance admin granted this account an immutable disclosure snapshot: one policy version plus chosen requests. Open a packet and press Decrypt — you can read exactly those values, forever, and nothing else. Selective disclosure instead of all-or-nothing transparency.',
    nextLabel: 'Almost done →',
  },
  {
    title: 'Believe none of it — verify',
    tab: 'Verify',
    body: 'Everything you just did is on Sepolia: request txs, proof-gated finalizations, real 2-of-2 governance executions. This page links every hash. That is the point — confidential numbers, publicly verifiable process.',
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

  // auto-advance on real on-chain progress
  const demoDelegate = demoAddress('delegate').toLowerCase();
  useEffect(() => {
    if (!s.auto) return;
    const mine = requests.filter((r) => r.delegate.toLowerCase() === demoDelegate);
    if (s.auto === 'submitted') {
      if (mine.some((r) => r.id > baselineId.current)) { setWaited(true); setTimeout(() => setStep(step + 1), 600); }
    } else if (s.auto === 'settled') {
      const newest = mine.reduce<SpendRequest | null>((a, r) => (!a || r.id > a.id ? r : a), null);
      if (newest && newest.state !== 1) { setWaited(true); setTimeout(() => setStep(step + 1), 600); }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requests, step]);

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
        {s.auto && !waited && <span className="muted tour-wait"><span className="spin" /> {s.waiting}</span>}
        {step < STEPS.length - 1
          ? <button className={`btn small ${s.auto ? 'ghost' : 'primary'}`} onClick={() => setStep(step + 1)}>{s.nextLabel ?? 'Next →'}</button>
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
