import { scanTx } from '../config';

export type PaymentPhase = 'preflight' | 'encrypting' | 'broadcasting' | 'confirming' | 'evaluating' | 'finalizing' | 'recovering';
export type PaymentFlow = { phase: PaymentPhase; label: string; startedAt: number; expect?: number; tx?: `0x${string}` };

export const PAYMENT_STEPS = ['Preflight', 'Encrypt', 'Submit', 'Private check', 'Publish result'] as const;
export const PAYMENT_PHASE_INDEX: Record<PaymentPhase, number> = {
  preflight: 0,
  encrypting: 1,
  broadcasting: 2,
  confirming: 2,
  evaluating: 3,
  // A delayed receipt means the transaction was submitted, but the browser has
  // not yet proved that a Request exists. Do not claim TEE work prematurely.
  recovering: 2,
  finalizing: 4,
};

export function PaymentProgress({ flow, isDemo }: { flow: PaymentFlow; isDemo: boolean }) {
  const elapsed = Math.floor((Date.now() - flow.startedAt) / 1000);
  const slow = flow.expect ? elapsed > flow.expect * 2 : false;
  const activeIndex = PAYMENT_PHASE_INDEX[flow.phase];
  return (
    <div className="operation-progress" role="status" aria-live="polite">
      <div className="operation-progress-head">
        <span className="spin" aria-hidden="true" />
        <b>{flow.label}</b>
        <span className="operation-elapsed mono">{elapsed}s elapsed{flow.expect ? ` · usually ${flow.expect}–${flow.expect * 2}s` : ''}</span>
        {flow.tx && <a className="alink mono" href={scanTx(flow.tx)} target="_blank" rel="noopener">view tx ↗</a>}
      </div>
      <div
        className="operation-track"
        role="progressbar"
        aria-label="Confidential payment processing stages"
        aria-valuemin={1}
        aria-valuemax={PAYMENT_STEPS.length}
        aria-valuenow={activeIndex + 1}
        aria-valuetext={`${PAYMENT_STEPS[activeIndex]} · ${flow.label}`}
      >
        {PAYMENT_STEPS.map((step, index) => (
          <span key={step} className={index < activeIndex ? 'done' : index === activeIndex ? 'active' : ''} />
        ))}
      </div>
      <div className="operation-step-labels" aria-hidden="true">
        {PAYMENT_STEPS.map((step, index) => <span key={step} className={index <= activeIndex ? 'reached' : ''}>{step}</span>)}
      </div>
      {!isDemo && flow.label.startsWith('①') && <div className="operation-note">Approve the message signature in your wallet to continue.</div>}
      {!isDemo && flow.label.startsWith('②') && <div className="operation-note">Confirm the transaction in your wallet to continue.</div>}
      {flow.phase === 'recovering' && <div className="operation-note">The transaction was broadcast. VeilGuard is recovering the request from its run-bound on-chain memo; do not submit it again.</div>}
      {slow && flow.phase !== 'recovering' && <div className="operation-note">Taking longer than usual. You may leave this page and resume safely; the run and transaction evidence are saved.</div>}
    </div>
  );
}
