import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ADDR, scan, scanTx, short } from '../config';
import { makeWalletClient } from '../nox';
import { governance2of2, type GovFn } from '../safe-browser';
import { fetchRequestTxs, type RequestTxs } from '../txlog';
import { useApp } from '../App';
import { Decrypt, RequestPill } from '../ui';
import { completeMission, confirmApprovalDecision, getActiveDemoRunId } from '../missions';
import { formatAppRoute, parseAppHash } from '../routes';
import { loadDemoSession } from '../demo-session';
import { trustedDemoScenarioForRequest } from '../demo-scenarios';
import {
  pollDemoSafeDecision,
  SafeDecisionDock,
  type SafeDecisionAction,
  type SafeDecisionFlow,
  type SafeDecisionPhase,
} from '../components/SafeDecisionProgress';
import {
  fetchDemoDecisionAttestation,
  isAttestedUserReject,
  type DemoDecisionAttestation,
} from '../demo-decision-attestation';
import { signerDecisionHistory, signerRequestIdentity } from '../signer-evidence';

function ago(ts: bigint): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - Number(ts));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3_600)}h`;
}

export function SignerView() {
  const { account, owners, mandates, requests, paused, run, busy, refresh, toast, demoRole } = useApp();
  const location = useLocation();
  const navigate = useNavigate();
  const route = useMemo(() => parseAppHash(`#${location.pathname}`), [location.pathname]);
  const selectedId = route?.page === 'approval-detail' && /^\d+$/.test(route.requestId) ? BigInt(route.requestId) : null;
  const isDetailRoute = route?.page === 'approval-detail';
  const isOwner = owners.some((owner) => owner.toLowerCase() === account?.toLowerCase());
  const isDemoDelegate = demoRole === 'delegate';
  const isDemoMode = demoRole != null;
  const demoRunId = loadDemoSession()?.runId;
  const [decisionBusy, setDecisionBusy] = useState<'approve' | 'reject' | null>(null);
  const [decisionFlow, setDecisionFlow] = useState<SafeDecisionFlow | null>(null);
  const [selectedAttestation, setSelectedAttestation] = useState<DemoDecisionAttestation>();
  const decisionLock = useRef(false);
  const [txs, setTxs] = useState<Map<string, RequestTxs>>(new Map());

  const isCurrentDemoApproval = (request: (typeof requests)[number]) =>
    trustedDemoScenarioForRequest(demoRunId, request)?.key === 'approval';
  const queue = useMemo(() => requests
    .filter((request) => request.state === 3 && (!isDemoMode || isCurrentDemoApproval(request)))
    .sort((a, b) => Number(b.id - a.id)), [demoRunId, isDemoMode, requests]);
  const history = useMemo(() => signerDecisionHistory(requests, txs, {
    runId: demoRunId,
    isDemoMode,
  }), [demoRunId, isDemoMode, requests, txs]);
  const selected = selectedId == null ? undefined : queue.find((request) => request.id === selectedId) ?? history.find((request) => request.id === selectedId);
  const selectedIdentity = signerRequestIdentity(demoRunId, isDemoMode, selected);
  const drafts = mandates.filter((mandate) => mandate.state === 1);
  const selectedEvidence = selected ? txs.get(String(selected.id)) : undefined;
  const safeDecisionTx = selectedEvidence?.approval ?? selectedEvidence?.cancellation;
  const selectedIsAttestedReject = isAttestedUserReject(selectedAttestation);
  const safeAction = selectedIsAttestedReject ? 'reject' : selectedEvidence?.safeAction;
  const queueIsEmpty = queue.length === 0 && history.length === 0;

  useEffect(() => { fetchRequestTxs().then(setTxs).catch(() => {}); }, []);
  useEffect(() => {
    if (!demoRunId || !selected || selected.state !== 5 || !isCurrentDemoApproval(selected)) {
      setSelectedAttestation(undefined);
      return;
    }
    let stopped = false;
    setSelectedAttestation(undefined);
    void fetchDemoDecisionAttestation(demoRunId, selected.id).then((attestation) => {
      if (!stopped) setSelectedAttestation(attestation);
    });
    return () => { stopped = true; };
    // The trusted identity is fully determined by these primitive object fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demoRunId, selected?.id, selected?.state, selected?.memoHash]);

  const selectRequest = (requestId: bigint) => {
    navigate(formatAppRoute({ page: 'approval-detail', requestId: String(requestId) }).slice(1));
  };

  const backToApprovals = () => navigate(formatAppRoute({ page: 'approvals' }).slice(1));

  const updateOwnerFlow = (
    requestId: string,
    action: SafeDecisionAction,
    phase: SafeDecisionPhase,
    hash?: `0x${string}`,
  ) => setDecisionFlow((current) => ({
    requestId,
    action,
    phase,
    startedAt: current?.requestId === requestId && current.action === action ? current.startedAt : Date.now(),
    hash: hash ?? current?.hash,
  }));

  const gov = async (label: string, fn: GovFn, args: unknown[]) => {
    if (!account || !selected || decisionLock.current) return;
    decisionLock.current = true;
    const action: SafeDecisionAction = fn === 'cancelEscalated' ? 'reject' : 'approve';
    const requestId = String(selected.id);
    setDecisionBusy(action);
    updateOwnerFlow(requestId, action, 'validating');
    try {
      const result = await run({
        key: `safe-decision:${requestId}:${action}`,
        label,
        resources: [`safe:${ADDR.Safe.toLowerCase()}`, `request:${requestId}`],
        feedback: 'inline',
      }, async () => {
        const hash = await governance2of2(makeWalletClient(account), fn, args, (message) => {
          updateOwnerFlow(
            requestId,
            action,
            message.startsWith('Owner') ? 'signing' : 'confirming',
          );
        });
        updateOwnerFlow(requestId, action, 'settled', hash);
        toast(`Safe 2-of-2 confirmed ${label} · ${short(hash)}`);
        await refresh();
        fetchRequestTxs(true).then(setTxs).catch(() => {});
      });
      if (result.status !== 'succeeded') setDecisionFlow(null);
    } finally {
      setDecisionBusy(null);
      decisionLock.current = false;
    }
  };

  const demoDecision = async (action: 'approve' | 'reject') => {
    const runId = getActiveDemoRunId();
    if (!selected || decisionLock.current || trustedDemoScenarioForRequest(runId, selected)?.key !== 'approval') {
      toast('This request is not the current run-bound ShieldOps approval task.', true);
      return;
    }
    decisionLock.current = true;
    setDecisionBusy(action);
    setDecisionFlow(null);
    try {
      const result = await pollDemoSafeDecision({
        runId,
        requestId: String(selected.id),
        action,
        onProgress: setDecisionFlow,
      });
      confirmApprovalDecision(selected.id, action, { runId, transactionHash: result.hash });
      if (action === 'reject') {
        setSelectedAttestation({
          requestId: Number(selected.id),
          chainState: 5,
          origin: 'user',
          action: 'reject',
          hash: result.hash,
        });
      }
      completeMission('approval', {
        requestId: selected.id,
        outcome: action === 'reject' ? 'cancelled' : 'executed',
        decision: action,
        runId,
      });
      toast(action === 'approve' ? 'Safe approval confirmed on-chain.' : 'Safe rejection and escrow return confirmed on-chain.');
      await refresh();
      await fetchRequestTxs(true).then(setTxs).catch(() => {});
    } catch (error: any) {
      toast(`Decision not completed: ${error?.message ?? error}. Refresh and resume from this request.`, true);
    } finally { setDecisionBusy(null); decisionLock.current = false; }
  };

  return (
    <>
      <header className="workspace-heading">
        <div><span className="detail-kicker">Treasury controls</span><h1>Approval Workspace</h1><p>Inspect a reserved request, reveal only the amount you are authorised to view, then approve or return the funds.</p></div>
        <a className="btn ghost" href={scan(ADDR.Safe)} target="_blank" rel="noopener">Open Safe on Sepolia ↗</a>
      </header>

      <section className={`workbench approval-workbench ${queueIsEmpty ? 'workbench-empty' : ''} ${isDetailRoute ? 'workbench-route-detail' : 'workbench-route-list'}`}>
        <aside className="workbench-list" aria-label="Approval requests">
          <div className="object-list-head"><div><h2>Pending approvals</h2><p>{queue.length} awaiting decision</p></div><span className="object-count">{queue.length}</span></div>
          {[...queue, ...history].map((request) => {
            const identity = signerRequestIdentity(demoRunId, isDemoMode, request);
            return (
              <button type="button" key={String(request.id)} className={`object-list-item ${selectedId === request.id ? 'selected' : ''}`} aria-current={selectedId === request.id ? 'page' : undefined} onClick={() => selectRequest(request.id)}>
                <span className="object-avatar">{identity.trusted ? identity.vendor[0] : 'R'}</span>
                <span><b>{identity.trusted ? identity.vendor : `Request #${request.id}`}</b><small>Request #{String(request.id)} · {short(request.recipient)} · {ago(request.createdAt)} ago</small></span>
                <RequestPill state={request.state} />
              </button>
            );
          })}
          {queueIsEmpty && <div className="empty-state queue-empty-copy"><b>No approvals yet</b><span>{isDemoMode ? 'Submit the ShieldOps invoice from Payment Inbox.' : 'Reserved exceptions and indexed Safe decisions will appear here.'}</span></div>}
        </aside>

        <article className="workbench-detail">
          {selected ? (
            <>
              <button type="button" className="mobile-detail-back" onClick={backToApprovals}>
                <span aria-hidden="true">←</span> Pending approvals
              </button>
              <header className="workbench-detail-head">
                <div><span className="detail-kicker">Request #{String(selected.id)}</span><h2>{selectedIdentity.vendor}</h2><p>{selectedIdentity.purpose}</p></div>
                {selectedIsAttestedReject
                  ? <span className="pill bad">USER REJECTED · REFUNDED</span>
                  : <RequestPill state={selected.state} />}
              </header>
              <dl className="data-list">
                <div><dt>Requested by</dt><dd className="mono">{short(selected.delegate)}</dd></div>
                <div><dt>Recipient</dt><dd>{selectedIdentity.trusted ? selectedIdentity.vendor : 'Private identity unavailable'} <span className="mono muted">{short(selected.recipient)}</span></dd></div>
                <div><dt>Amount</dt><dd>{isOwner || isDemoDelegate ? <Decrypt handle={selected.amount} /> : <span className="enc">Authorised roles only</span>}</dd></div>
                <div><dt>Escrow</dt><dd>{selected.state === 3 ? 'Reserved · awaiting decision' : selected.state === 2 ? 'Released to recipient' : 'Returned to treasury'}</dd></div>
                {selected.state === 5 && <div><dt>Decision origin</dt><dd>{selectedIsAttestedReject
                  ? 'User selected Reject · authenticated by the run-bound server receipt'
                  : selectedAttestation?.origin === 'timeout'
                    ? 'Decision window timeout · no user Reject'
                    : 'Cancellation confirmed · no user Reject attestation'}</dd></div>}
                <div><dt>Policy thresholds</dt><dd><span className="enc">Protected</span></dd></div>
              </dl>

              <ol className="signature-timeline" aria-label="Safe signature timeline">
                <li className={selectedEvidence?.outcomePath === 'approval' || selected.state === 3 || selected.state === 5 ? 'done' : ''}>
                  <b>{selectedEvidence?.outcomePath === 'approval' || selected.state === 3 || selected.state === 5 ? 'Request escalated' : 'Execution path indexing'}</b>
                  <span>{new Date(Number(selected.createdAt) * 1000).toLocaleString()}</span>
                </li>
                <li className={safeDecisionTx ? 'done' : selected.state === 3 ? 'active' : ''}><b>Owner A signature</b><span>{safeDecisionTx ? 'Present in the confirmed Safe execution' : selected.state === 3 ? 'Awaiting a decision' : 'Not claimed without transaction evidence'}</span></li>
                <li className={safeDecisionTx ? 'done' : ''}><b>Owner B co-signature</b><span>{safeDecisionTx ? 'Present in the confirmed threshold execution' : selected.state === 3 ? 'Not requested yet' : 'Not claimed without transaction evidence'}</span></li>
                <li className={safeDecisionTx ? 'done' : selected.state === 3 ? 'active' : ''}><b>Safe transaction</b><span>{safeDecisionTx ? <a href={scanTx(safeDecisionTx)} target="_blank" rel="noopener">{safeAction === 'reject' ? 'View attested user rejection' : safeAction === 'approve' ? 'View approval' : selected.state === 5 ? 'View cancellation' : 'View decision'} ↗</a> : selected.state === 3 ? 'Pending' : 'Event index unavailable'}</span></li>
              </ol>

              {selected.state === 3 && (
                <SafeDecisionDock flow={decisionFlow}>
                  {isOwner ? (
                    <>
                      <button className="btn danger" disabled={!!busy || !!decisionBusy} aria-busy={decisionBusy === 'reject'} onClick={() => void gov(`reject request #${selected.id}`, 'cancelEscalated', [selected.id])}>{decisionBusy === 'reject' ? <><span className="spin" aria-hidden="true" /> Returning funds…</> : 'Reject & return funds'}</button>
                      <button className="btn primary" disabled={!!busy || !!decisionBusy} aria-busy={decisionBusy === 'approve'} onClick={() => void gov(`approve request #${selected.id}`, 'executeEscalated', [selected.id])}>{decisionBusy === 'approve' ? <><span className="spin" aria-hidden="true" /> Executing 2-of-2…</> : 'Approve payment'}</button>
                    </>
                  ) : isDemoDelegate ? (
                    <>
                      <button className="btn danger" disabled={!!decisionBusy} aria-busy={decisionBusy === 'reject'} onClick={() => void demoDecision('reject')}>{decisionBusy === 'reject' ? <><span className="spin" aria-hidden="true" /> Returning funds…</> : 'Reject & return funds'}</button>
                      <button className="btn primary" disabled={!!decisionBusy} aria-busy={decisionBusy === 'approve'} onClick={() => void demoDecision('approve')}>{decisionBusy === 'approve' ? <><span className="spin" aria-hidden="true" /> Executing 2-of-2…</> : 'Approve payment'}</button>
                    </>
                  ) : <span className="muted">Connect a current Safe owner or return to the guided Demo decision.</span>}
                </SafeDecisionDock>
              )}
              {isDemoDelegate && <div className="inline-alert">Your click selects a strictly validated demo action. It is not represented as your signature; both Safe owner keys remain server-side.</div>}
            </>
          ) : (
            <div className="workbench-empty-detail" role={isDetailRoute ? 'alert' : 'status'}>
              {isDetailRoute && (
                <button type="button" className="mobile-detail-back" onClick={backToApprovals}>
                  <span aria-hidden="true">←</span> Pending approvals
                </button>
              )}
              <header className="workbench-detail-head empty-detail-head">
                <div>
                  <span className="workbench-kicker">Committee workspace</span>
                  <h2>{isDetailRoute ? 'Approval request not found' : queueIsEmpty ? 'Queue ready for ShieldOps' : 'Select a request'}</h2>
                  <p>{isDetailRoute ? 'This request is not in the current pending or recent ShieldOps queue.' : queueIsEmpty ? 'The next reserved exception will appear here with its real Safe timeline.' : 'Pending and recent committee decisions appear here.'}</p>
                </div>
              </header>
              <div className="empty-detail-body">
                <b>{queueIsEmpty ? 'Create the approval task from Payment Inbox' : 'Choose a request from the queue'}</b>
                <span>{queueIsEmpty ? 'Submit the 60 cUSDC ShieldOps invoice; once the TEE reserves escrow, this workspace exposes Approve and Reject.' : 'The detail view keeps the escrow, disclosure and transaction evidence together.'}</span>
                {queueIsEmpty && <button type="button" className="btn primary" onClick={() => navigate(formatAppRoute({ page: 'payment-inbox' }).slice(1))}>Open Payment Inbox</button>}
              </div>
            </div>
          )}
        </article>
      </section>

      {isOwner && (
        <section className="surface-section governance-queue">
          <div className="section-heading"><div><h2>Governance queue</h2><p>Policy activation and emergency recovery use the same real Safe threshold.</p></div></div>
          <div className="governance-actions">
            {drafts.map((mandate) => <div key={String(mandate.id)}><span>Activate mandate #{String(mandate.id)} · {short(mandate.delegate)}</span><button className="btn" disabled={!!busy} onClick={() => gov(`activate mandate #${mandate.id}`, 'activateMandate', [mandate.id])}>Activate 2-of-2</button></div>)}
            {paused && <div><span>Module is paused</span><button className="btn primary" disabled={!!busy} onClick={() => gov('resume all mandates', 'unpauseAll', [])}>Resume 2-of-2</button></div>}
            {!drafts.length && !paused && <div className="empty-state"><b>No governance actions waiting</b><span>The module is active and no policy draft needs activation.</span></div>}
          </div>
        </section>
      )}
    </>
  );
}
