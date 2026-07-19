import type { ReactNode } from 'react';
import { scanTx } from '../config';
import './safe-decision.css';

export type SafeDecisionAction = 'approve' | 'reject';
export type SafeDecisionPhase = 'validating' | 'signing' | 'broadcasting' | 'confirming' | 'recovering' | 'settled';
export type SafeDecisionStatus = 'processing' | 'recoverable-error' | 'settled';

export type SafeDecisionFlow = {
  requestId: string;
  action: SafeDecisionAction;
  phase: SafeDecisionPhase;
  status?: SafeDecisionStatus;
  startedAt: number;
  hash?: `0x${string}`;
  error?: string;
};

type DecisionSnapshot = {
  ok?: boolean;
  processing?: boolean;
  requestId?: number;
  action?: SafeDecisionAction;
  phase?: SafeDecisionPhase;
  hash?: `0x${string}`;
  state?: 'safe-approved' | 'safe-rejected';
  error?: string;
  code?: string;
  details?: {
    phase?: SafeDecisionPhase;
    hash?: `0x${string}`;
    error?: string;
    code?: string;
  };
};

const PHASES = new Set<SafeDecisionPhase>([
  'validating', 'signing', 'broadcasting', 'confirming', 'recovering', 'settled',
]);

export const SAFE_DECISION_STEPS = [
  'Request validated',
  'Threshold signatures',
  'Safe transaction',
  'Settlement confirmed',
] as const;

export const SAFE_DECISION_PHASE_INDEX: Record<SafeDecisionPhase, number> = {
  validating: 0,
  signing: 1,
  broadcasting: 2,
  confirming: 2,
  recovering: 2,
  settled: 3,
};

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function pollDemoSafeDecision({
  runId,
  requestId,
  action,
  onProgress,
  fetchImpl = fetch,
  pollDelayMs = 1_500,
  maxPolls = 125,
}: {
  runId: string;
  requestId: string;
  action: SafeDecisionAction;
  onProgress: (flow: SafeDecisionFlow) => void;
  fetchImpl?: typeof fetch;
  pollDelayMs?: number;
  maxPolls?: number;
}): Promise<DecisionSnapshot> {
  const startedAt = Date.now();
  let current: SafeDecisionFlow = { requestId, action, phase: 'validating', status: 'processing', startedAt };
  onProgress(current);
  let transientFailures = 0;

  for (let attempt = 0; attempt < maxPolls; attempt++) {
    let response: Response;
    try {
      response = await fetchImpl('/api/demo-decision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId, requestId, action }),
        signal: AbortSignal.timeout(15_000),
      });
      transientFailures = 0;
    } catch (reason: any) {
      transientFailures += 1;
      const message = reason?.message ?? 'committee decision status is temporarily unavailable';
      current = { ...current, status: 'recoverable-error', error: message };
      onProgress(current);
      if (transientFailures >= 3) throw new Error(`${message}; resume from this request`);
      await sleep(pollDelayMs);
      current = { ...current, status: 'processing', error: undefined };
      onProgress(current);
      continue;
    }
    const snapshot = await response.json().catch(() => ({})) as DecisionSnapshot;
    const reportedPhase = snapshot.phase ?? snapshot.details?.phase;
    const reportedHash = snapshot.hash ?? snapshot.details?.hash;
    const phase = reportedPhase && PHASES.has(reportedPhase) ? reportedPhase : current.phase;
    const message = snapshot.error ?? snapshot.details?.error ?? snapshot.code ?? snapshot.details?.code ?? 'committee decision failed';
    current = {
      ...current,
      phase,
      status: response.ok ? 'processing' : 'recoverable-error',
      error: response.ok ? undefined : message,
      ...(reportedHash ? { hash: reportedHash } : {}),
    };
    onProgress(current);

    if (response.status === 202) {
      await sleep(pollDelayMs);
      continue;
    }
    if (!response.ok) throw new Error(message);
    if (!snapshot.ok || snapshot.state !== (action === 'approve' ? 'safe-approved' : 'safe-rejected')) {
      throw new Error('committee decision did not return a confirmed terminal receipt');
    }
    const settled = {
      ...current,
      phase: 'settled' as const,
      status: 'settled' as const,
      error: undefined,
      ...(snapshot.hash ? { hash: snapshot.hash } : {}),
    };
    onProgress(settled);
    return snapshot;
  }
  throw new Error('committee decision is still processing; resume from this request');
}

export function SafeDecisionProgress({ flow }: { flow: SafeDecisionFlow }) {
  const activeIndex = SAFE_DECISION_PHASE_INDEX[flow.phase];
  const settled = flow.status === 'settled' || (!flow.status && flow.phase === 'settled');
  const recoverableError = flow.status === 'recoverable-error';
  const actionLabel = flow.action === 'approve' ? 'Approving payment' : 'Returning escrow';
  const phaseLabel = recoverableError
    ? `${flow.error ?? 'Status check paused'} · retry or resume from this request`
    : flow.phase === 'recovering'
    ? 'Recovering the broadcast transaction receipt'
    : SAFE_DECISION_STEPS[activeIndex];

  return (
    <div className="safe-decision-progress" role="status" aria-live="polite">
      <div className="safe-decision-progress__head">
        {settled
          ? <span className="safe-decision-progress__check" aria-hidden="true">✓</span>
          : recoverableError
            ? <span className="safe-decision-progress__warning" aria-hidden="true">!</span>
            : <span className="spin" aria-hidden="true" />}
        <span><b>{actionLabel}</b><small>{phaseLabel}</small></span>
        {flow.hash && <a className="alink mono" href={scanTx(flow.hash)} target="_blank" rel="noopener">view tx ↗</a>}
      </div>
      <div
        className="safe-decision-progress__track"
        role="progressbar"
        aria-label="Safe decision processing stages"
        aria-valuemin={1}
        aria-valuemax={SAFE_DECISION_STEPS.length}
        aria-valuenow={activeIndex + 1}
        aria-valuetext={`${phaseLabel} · ${actionLabel}`}
      >
        {SAFE_DECISION_STEPS.map((step, index) => (
          <span key={step} className={index < activeIndex ? 'done' : index === activeIndex ? 'active' : ''} />
        ))}
      </div>
      <div className="safe-decision-progress__labels" aria-hidden="true">
        {SAFE_DECISION_STEPS.map((step, index) => <span key={step} className={index <= activeIndex ? 'reached' : ''}>{step}</span>)}
      </div>
    </div>
  );
}

export function SafeDecisionDock({
  flow,
  children,
  guidedActionId,
  guidedInstruction,
  guidedFollow,
}: {
  flow?: SafeDecisionFlow | null;
  children: ReactNode;
  guidedActionId?: string;
  guidedInstruction?: string;
  guidedFollow?: boolean;
}) {
  return (
    <section className="safe-decision-dock" aria-label="Safe decision actions">
      {flow && <SafeDecisionProgress flow={flow} />}
      <div
        className="safe-decision-dock__actions"
        role="group"
        aria-label="Approve or return the reserved payment"
        data-guided-action={guidedActionId}
        data-guided-instruction={guidedInstruction}
        data-guided-follow={guidedFollow ? 'true' : undefined}
      >{children}</div>
    </section>
  );
}
