import { useState, type ReactNode } from 'react';
import type { ChainRefreshResult, SpendRequest } from '../App';
import { scanTx, short, vendorName } from '../config';
import type { DemoScenario } from '../demo-scenarios';
import type { RequestDetailModel } from '../domain';
import type { RequestTxs } from '../txlog';
import { PrivacyLens } from '../components/PrivacyLens';
import { RequestPill } from '../ui';
import { SafeDecisionDock, type SafeDecisionFlow } from '../components/SafeDecisionProgress';

export type RequestDetailViewProps = {
  request: SpendRequest;
  model: RequestDetailModel;
  transactions?: RequestTxs;
  trustedStory?: DemoScenario;
  authorizedAmount: ReactNode;
  purpose: ReactNode;
  reason?: string | null;
  reasonBusy?: boolean;
  activeOperation?: ReactNode;
  decisionBusy?: 'approve' | 'reject' | null;
  decisionFlow?: SafeDecisionFlow | null;
  decisionError?: string | null;
  canDemoDecide?: boolean;
  guidedActionId?: string;
  auditPacketIds?: string[];
  onBack: () => void;
  onRefresh: () => Promise<ChainRefreshResult>;
  onDecryptReason?: () => void;
  onDecision?: (action: 'approve' | 'reject') => void;
};

export function RequestDetailView({
  request,
  model,
  transactions,
  trustedStory,
  authorizedAmount,
  purpose,
  reason,
  reasonBusy,
  activeOperation,
  decisionBusy,
  decisionFlow,
  decisionError,
  canDemoDecide,
  guidedActionId,
  auditPacketIds = [],
  onBack,
  onRefresh,
  onDecryptReason,
  onDecision,
}: RequestDetailViewProps) {
  const [refreshing, setRefreshing] = useState(false);
  const [refreshResult, setRefreshResult] = useState<ChainRefreshResult | null>(null);
  const recipientName = trustedStory?.vendor ?? vendorName(request.recipient) ?? short(request.recipient);
  const outcome = request.state === 2 ? 'EXECUTED'
    : request.state === 3 ? 'AWAITING APPROVAL'
      : request.state === 4 ? 'BLOCKED'
        : request.state === 5 ? 'CANCELLED'
          : request.state === 6 ? 'EXPIRED' : 'IN PROGRESS';

  return (
    <div className="request-detail-route">
      <header className="workspace-heading request-detail-heading">
        <div>
          <button type="button" className="mobile-detail-back" onClick={onBack}>← Payment Inbox</button>
          <span className="detail-kicker">On-chain payment request</span>
          <h1>Request #{model.id}</h1>
          <p>{recipientName} · Mandate #{model.mandateId}</p>
        </div>
        <RequestPill state={request.state} decisionReady={request.decisionReady} />
      </header>

      {activeOperation}

      <div className="request-detail-grid">
        <section className="surface-section" aria-labelledby="request-summary-title">
          <div className="section-heading">
            <div><h2 id="request-summary-title">Request summary</h2><p>Object identity and current settlement state from Sepolia.</p></div>
            <span className={`status-badge pill ${model.statusTone === 'success' ? 'ok' : model.statusTone === 'warning' ? 'warn' : model.statusTone === 'danger' ? 'bad' : model.statusTone === 'progress' ? 'tee' : 'dim'}`}>{model.statusLabel}</span>
          </div>
          <dl className="data-list">
            <div><dt>Recipient</dt><dd>{recipientName}<span className="mono muted">{short(request.recipient)}</span></dd></div>
            <div><dt>Amount</dt><dd>{authorizedAmount}</dd></div>
            <div><dt>Purpose</dt><dd>{purpose}</dd></div>
            <div><dt>Escrow</dt><dd>{model.escrow.replaceAll('-', ' ')}</dd></div>
            <div><dt>Public outcome</dt><dd>{outcome}</dd></div>
            <div><dt>Memo hash</dt><dd className="mono">{short(request.memoHash)}</dd></div>
            <div><dt>Audit inclusion</dt><dd>{auditPacketIds.length ? `Current run bundle · ${auditPacketIds.map((id) => `Packet #${id}`).join(' · ')}` : 'Not included in the current run packet set'}</dd></div>
          </dl>
          {trustedStory && <p className="trust-note">Demo story metadata verified against this run's memo, scenario, mandate, delegate and recipient.</p>}
        </section>

        <section className="surface-section" aria-labelledby="request-timeline-title">
          <div className="section-heading"><div><h2 id="request-timeline-title">Request timeline</h2><p>Public stages and transaction evidence for this object only.</p></div></div>
          <ol className="signature-timeline request-timeline">
            {model.timeline.map((stage) => (
              <li key={stage.id} className={stage.state === 'complete' ? 'done' : stage.state === 'current' ? 'active' : stage.state === 'failed' ? 'failed' : ''}>
                <b>{stage.label}</b>
                <span>{stage.detail}{stage.transactionHash && <> · <a href={scanTx(stage.transactionHash)} target="_blank" rel="noopener">view transaction ↗</a></>}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>

      {request.state === 3 && canDemoDecide && onDecision && (
        <section
          className="surface-section committee-decision"
          aria-labelledby="request-decision-title"
        >
          <div className="section-heading"><div><h2 id="request-decision-title">Demo committee decision</h2><p>Your choice triggers the bounded, real Safe 2-of-2 path; it is not represented as your signature.</p></div></div>
          <SafeDecisionDock
            flow={decisionFlow}
            guidedActionId={guidedActionId}
            guidedInstruction="Choose “Approve payment” or “Reject & return funds”"
          >
            <button className="btn danger" disabled={!!decisionBusy} aria-busy={decisionBusy === 'reject'} onClick={() => onDecision('reject')}>
              {decisionBusy === 'reject' ? <><span className="spin" /> Returning funds…</> : 'Reject & return funds'}
            </button>
            <button className="btn primary" disabled={!!decisionBusy} aria-busy={decisionBusy === 'approve'} onClick={() => onDecision('approve')}>
              {decisionBusy === 'approve' ? <><span className="spin" /> Executing 2-of-2…</> : 'Approve payment'}
            </button>
          </SafeDecisionDock>
          {decisionError && <div className="inline-alert bad" role="alert">{decisionError} · Refresh or retry; escrow remains recoverable.</div>}
        </section>
      )}

      {request.state === 4 && !reason && onDecryptReason && (
        <button
          className="btn primary"
          data-guided-action={guidedActionId}
          data-guided-instruction="Click “Decrypt the private reason”"
          disabled={reasonBusy}
          onClick={onDecryptReason}
        >
          {reasonBusy ? <><span className="spin" /> Decrypting…</> : 'Decrypt the private reason'}
        </button>
      )}

      {model.terminal && (
        <PrivacyLens
          authorized={[
            { label: 'Amount', value: authorizedAmount },
            { label: 'Recipient', value: recipientName },
            { label: 'Purpose', value: purpose },
            { label: 'Outcome', value: model.statusLabel },
            ...(request.state === 4 ? [{ label: 'Reason', value: reason ?? 'Encrypted · decrypt to inspect' }] : []),
          ]}
          publicView={[
            { label: 'Amount', value: <span className="enc">Encrypted handle</span> },
            { label: 'Recipient', value: <span className="mono">{short(request.recipient)}</span> },
            { label: 'Memo', value: <span className="mono">{short(request.memoHash)}</span> },
            { label: 'Outcome', value: outcome },
            { label: 'Policy values', value: <span className="enc">Protected</span> },
          ]}
        />
      )}

      <section className="surface-section" aria-labelledby="request-transactions-title">
        <div className="section-heading"><div><h2 id="request-transactions-title">Transactions</h2><p>Evidence links are indexed from contract events, never synthesized.</p></div><button
          type="button"
          className="btn small ghost"
          data-guided-action={guidedActionId && !(request.state === 3 && canDemoDecide && onDecision) && !(request.state === 4 && !reason && onDecryptReason) ? guidedActionId : undefined}
          data-guided-instruction="Use “Refresh evidence” to reconcile the latest chain state"
          disabled={refreshing}
          onClick={async () => {
          if (refreshing) return;
          setRefreshing(true);
          try { setRefreshResult(await onRefresh()); }
          finally { setRefreshing(false); }
        }}>{refreshing ? <><span className="spin" /> Checking chain…</> : 'Refresh evidence'}</button></div>
        {refreshResult && (
          <div className={`inline-alert ${refreshResult.status === 'failed' ? 'bad' : ''}`} role={refreshResult.status === 'failed' ? 'alert' : 'status'}>
            {refreshResult.status === 'changed' ? 'New on-chain evidence found'
              : refreshResult.status === 'unchanged' ? 'No new on-chain evidence'
                : `Chain check failed · ${'message' in refreshResult ? refreshResult.message : 'Unknown chain reader error'}`}
            {' · checked '}{new Date(refreshResult.checkedAt).toLocaleTimeString()}
          </div>
        )}
        <dl className="data-list transaction-list">
          {([
            ['Request', transactions?.request],
            ['Finalize', transactions?.finalize],
            ['Safe approval', transactions?.approval],
            ['Safe cancellation', transactions?.cancellation],
          ] as const).map(([label, hash]) => (
            <div key={label}><dt>{label}</dt><dd>{hash ? <a className="mono" href={scanTx(hash)} target="_blank" rel="noopener">{short(hash)} ↗</a> : <span className="muted">Not indexed</span>}</dd></div>
          ))}
        </dl>
      </section>
    </div>
  );
}
