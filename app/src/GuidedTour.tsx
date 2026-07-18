import { useEffect, useState } from 'react';

export type TabName = 'Dashboard' | 'Delegate' | 'Admin' | 'Signer' | 'Auditor' | 'Get Funds';

export type Step = {
  title: string;
  body: string;
  tab: TabName;
  hint?: string;
};

export const STEPS: Step[] = [
  {
    title: 'A treasury nobody can read',
    tab: 'Dashboard',
    body: 'This is a live Safe treasury on Sepolia holding confidential cUSDC. Every mandate and request below is real on-chain state — yet the budgets, limits and amounts are all encrypted. Scroll the tables: you see who and when, never how much.',
    hint: 'You are looking at the public view — exactly what any chain observer gets.',
  },
  {
    title: 'A secret spending policy',
    tab: 'Admin',
    body: 'A finance admin proposed an encrypted mandate: a per-payment auto-limit, a total delegated budget and a minimum treasury reserve. On-chain they are just handles. Only authorised viewers can decrypt them — connect the admin wallet and the 🔓 buttons reveal the numbers; anyone else is refused by the on-chain ACL.',
    hint: 'The admin can only propose and pause. Activating a policy needs the Safe multisig.',
  },
  {
    title: 'A routine payment — WITHIN MANDATE',
    tab: 'Delegate',
    body: 'A delegate submits an encrypted amount. The Nox TEE checks it against the secret policy and returns a decision. Request #1 came back WITHIN MANDATE and paid out immediately — the amount stayed hidden the whole time. As the delegate you can decrypt your own amount; nobody else can.',
    hint: 'Encryption happens in your browser before the value ever leaves.',
  },
  {
    title: 'Too big — APPROVAL REQUIRED',
    tab: 'Signer',
    body: 'Request #4 was above the secret auto-limit, so the TEE returned APPROVAL REQUIRED and the funds were held in escrow until the Safe multisig signed. Signers — and only signers — can decrypt the escalated amount here before approving or rejecting.',
    hint: 'Approve / reject each go through a real Safe transaction.',
  },
  {
    title: 'Against the rules — BLOCKED',
    tab: 'Delegate',
    body: 'Request #5 would have broken the policy, so it came back BLOCKED — no funds moved and the budget was untouched. The delegate can decrypt a coarse reason (budget / balance / reserve) but never the exact limit, so the policy can not be probed out by trial and error. A blocked request also starts a cooldown.',
  },
  {
    title: 'Audit without exposure',
    tab: 'Auditor',
    body: 'The admin can hand an auditor a scoped, immutable snapshot of one policy version and a chosen set of requests. The auditor decrypts exactly those values — forever — but never gains access to live state, future versions, or the ability to compute on the handles.',
  },
  {
    title: 'Your turn',
    tab: 'Get Funds',
    body: 'Want to drive it yourself? Grab a little Sepolia ETH for gas from the faucets, claim demo TestUSDC in one click, then act as a delegate and submit your own request. Watch the TEE decide in real time.',
    hint: 'The demo role accounts are listed in the repo if you want to play every part.',
  },
];

export function GuidedTour({
  step, setStep, onGoToTab, onClose,
}: {
  step: number;
  setStep: (n: number) => void;
  onGoToTab: (t: TabName) => void;
  onClose: () => void;
}) {
  const s = STEPS[step];
  useEffect(() => { onGoToTab(s.tab); }, [step]);

  return (
    <div className="tour">
      <div className="tour-head">
        <div className="tour-progress">
          {STEPS.map((_, i) => (
            <span key={i} className={`tdot ${i === step ? 'on' : ''} ${i < step ? 'done' : ''}`} onClick={() => setStep(i)} />
          ))}
        </div>
        <div className="tour-step-of">Guided demo · step {step + 1} / {STEPS.length}</div>
        <button className="tour-x" onClick={onClose} title="Exit guided demo">✕</button>
      </div>
      <div className="tour-body">
        <div className="tour-tab">{s.tab}</div>
        <h3>{s.title}</h3>
        <p>{s.body}</p>
        {s.hint && <p className="tour-hint">💡 {s.hint}</p>}
      </div>
      <div className="tour-nav">
        <button className="btn small ghost" disabled={step === 0} onClick={() => setStep(step - 1)}>← Back</button>
        {step < STEPS.length - 1
          ? <button className="btn small primary" onClick={() => setStep(step + 1)}>Next →</button>
          : <button className="btn small primary" onClick={onClose}>Explore freely ✓</button>}
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
