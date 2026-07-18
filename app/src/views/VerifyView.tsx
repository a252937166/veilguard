import { useEffect, useMemo, useState } from 'react';
import { Workbench, WorkbenchDetail, WorkbenchList, WorkbenchTabs } from '../components/workbench';
import { ADDR, REQUEST_STATES, scan, scanTx, short, vendorName } from '../config';
import { useApp, type SpendRequest } from '../App';
import { deriveRequestDetailModel, type RequestDetailModel } from '../domain';
import { formatAppRoute, parseAppHash } from '../routes';
import { fetchRequestTxs, type RequestTxs } from '../txlog';
import { EVIDENCE } from './Evidence';

type ExplorerTab = 'Flow' | 'Public Data' | 'Proof' | 'Transactions';
type FlowSource = 'live' | 'frozen';
type StageStatus = 'complete' | 'current' | 'pending' | 'failed' | 'not-applicable';

type FlowStage = {
  title: string;
  detail: string;
  status: StageStatus;
};

type PublicFact = {
  label: string;
  value: string;
  mono?: boolean;
};

type FlowTransaction = {
  label: string;
  hash?: `0x${string}`;
  note: string;
};

type ExplorerFlow = {
  id: string;
  source: FlowSource;
  title: string;
  subtitle: string;
  outcome: string;
  outcomeClass: 'ok' | 'warn' | 'bad' | 'dim' | 'tee';
  stages: FlowStage[];
  publicFacts: PublicFact[];
  proofNotes: string[];
  transactions: FlowTransaction[];
};

function asHash(value?: string): `0x${string}` | undefined {
  return value?.startsWith('0x') ? value as `0x${string}` : undefined;
}

function liveOutcome(model: RequestDetailModel) {
  if (model.status === 'tee-evaluating' || model.status === 'decision-ready') return model.status === 'decision-ready'
    ? { label: 'PROOF PUBLISHING', className: 'tee' as const }
    : { label: 'TEE EVALUATING', className: 'tee' as const };
  if (model.status === 'safe-approved') return { label: 'SAFE APPROVED', className: 'ok' as const };
  if (model.status === 'direct-executed') return { label: 'EXECUTED', className: 'ok' as const };
  if (model.status === 'executed-unclassified') return { label: 'EXECUTED · PATH INDEXING', className: 'dim' as const };
  if (model.status === 'awaiting-approval') return { label: 'AWAITING SAFE', className: 'warn' as const };
  if (model.status === 'blocked') return { label: 'BLOCKED', className: 'bad' as const };
  if (model.status === 'safe-rejected') return { label: 'REJECTED · REFUNDED', className: 'bad' as const };
  if (model.status === 'expired') return { label: 'EXPIRED · REFUNDED', className: 'dim' as const };
  return { label: model.statusLabel.toUpperCase(), className: 'dim' as const };
}

function buildLiveFlow(request: SpendRequest, tx?: RequestTxs): ExplorerFlow {
  const transactions = {
    request: tx?.request,
    finalize: tx?.finalize,
    approval: tx?.approval,
    cancellation: tx?.cancellation,
  };
  const model = deriveRequestDetailModel(request, {
    transactions,
    events: { outcomePath: tx?.outcomePath, safeAction: tx?.safeAction },
  });
  const outcome = liveOutcome(model);
  const isPendingTee = model.status === 'tee-evaluating' || model.status === 'decision-ready';
  const needsSafe = model.outcomePath === 'approval';
  const pathUnclassified = model.status === 'executed-unclassified';
  const vendor = vendorName(request.recipient);
  const created = new Date(model.createdAt);
  const createdLabel = Number.isNaN(created.getTime()) ? 'Unavailable' : created.toLocaleString();

  return {
    id: `live-request-${request.id}`,
    source: 'live',
    title: vendor ? `${vendor} · Request #${request.id}` : `Payment request #${request.id}`,
    subtitle: `Mandate #${request.mandateId} · ${short(request.recipient)}`,
    outcome: outcome.label,
    outcomeClass: outcome.className,
    stages: model.timeline.map((stage) => ({ title: stage.label, detail: stage.detail, status: stage.state })),
    publicFacts: [
      { label: 'Network', value: 'Ethereum Sepolia' },
      { label: 'Request ID', value: `#${request.id}`, mono: true },
      { label: 'Mandate ID', value: `#${request.mandateId}`, mono: true },
      { label: 'Public state', value: REQUEST_STATES[request.state] ?? String(request.state) },
      { label: 'Derived status', value: model.statusLabel },
      { label: 'Escrow', value: model.escrow },
      { label: 'Recipient', value: request.recipient, mono: true },
      { label: 'Created', value: createdLabel },
      { label: 'Memo hash', value: request.memoHash, mono: true },
      { label: 'Encrypted amount handle', value: request.amount, mono: true },
      { label: 'Encrypted decision handle', value: request.decision, mono: true },
      { label: 'Encrypted reason handle', value: request.blockedReason, mono: true },
    ],
    proofNotes: [
      isPendingTee
        ? 'This live request has not reached a terminal proof-gated outcome yet.'
        : model.status === 'expired'
          ? 'The contract expiry path restored reserved value without accepting an unverified decision.'
          : 'The module accepts a confidential decision only through its proof-gated finalize path.',
      pathUnclassified
        ? 'The request is executed, but direct-versus-Safe path evidence has not been indexed. This view deliberately does not infer it from terminal state alone.'
        : needsSafe
        ? 'This request entered the Safe exception path. The execution or cancellation transaction is listed when the event index resolves it.'
        : 'No Safe exception transaction is required for this public outcome.',
      'Amounts, policy thresholds and blocked reasons are ciphertext handles in this public view; no plaintext is inferred here.',
    ],
    transactions: [
      { label: 'Request', hash: tx?.request, note: 'Submitted encrypted spend request' },
      { label: model.status === 'expired' ? 'Expiry / state transition' : 'Proof-gated finalize', hash: tx?.finalize, note: model.status === 'expired' ? 'May be unavailable until the expiry event index is supported' : 'Publishes the confidential outcome' },
      {
        label: 'Safe decision',
        hash: tx?.approval ?? tx?.cancellation,
        note: pathUnclassified ? 'Awaiting event evidence' : needsSafe ? '2-of-2 approval or cancellation execution' : 'Not required for this flow',
      },
    ],
  };
}

function buildFrozenFlows(): ExplorerFlow[] {
  const evidence = EVIDENCE as any;
  const requests = evidence.requests;
  const date = new Date(evidence.generatedAt).toISOString();
  const baseFacts: PublicFact[] = [
    { label: 'Network', value: `Ethereum ${evidence.network}` },
    { label: 'Evidence run', value: evidence.commit, mono: true },
    { label: 'Captured', value: date },
  ];
  return [
    {
      id: 'frozen-mandate',
      source: 'frozen',
      title: `Mandate #${evidence.mandate.id} activation`,
      subtitle: `Safe ${evidence.threshold}-of-${evidence.threshold} governance`,
      outcome: 'ACTIVE',
      outcomeClass: 'ok',
      stages: [
        { title: 'Encrypted mandate proposed', detail: 'Finance admin submitted the mandate configuration.', status: 'complete' },
        { title: 'Safe approvals collected', detail: `${evidence.mandate.activation.confirmations} distinct confirmations met threshold ${evidence.mandate.activation.threshold}.`, status: 'complete' },
        { title: 'Mandate activated', detail: 'The Safe executed activation against VeilGuardModule.', status: 'complete' },
      ],
      publicFacts: [...baseFacts, { label: 'Mandate ID', value: `#${evidence.mandate.id}`, mono: true }, { label: 'Safe transaction hash', value: evidence.mandate.activation.safeTxHash, mono: true }],
      proofNotes: ['This record is frozen at the evidence-run commit.', 'Activation required the recorded Safe threshold; the linked execution is an Ethereum transaction.'],
      transactions: [
        { label: 'Propose mandate', hash: asHash(evidence.mandate.proposeTx), note: 'Finance admin proposal' },
        { label: 'Activate via Safe', hash: asHash(evidence.mandate.activation.executeTxHash), note: `${evidence.mandate.activation.confirmations}/${evidence.mandate.activation.threshold} Safe execution` },
      ],
    },
    {
      id: 'frozen-direct',
      source: 'frozen',
      title: `Direct payment · Request #${requests.within.id}`,
      subtitle: `Mandate #${evidence.mandate.id} · proof-gated`,
      outcome: 'EXECUTED',
      outcomeClass: 'ok',
      stages: [
        { title: 'Encrypted request submitted', detail: 'The request transaction recorded the ciphertext-backed spend.', status: 'complete' },
        { title: 'TEE decision finalized', detail: `Recorded single-run latency: ${evidence.teeLatencySec.within}s.`, status: 'complete' },
        { title: 'Direct payment executed', detail: 'The confidential decision resolved within mandate; no Safe exception was required.', status: 'complete' },
      ],
      publicFacts: [...baseFacts, { label: 'Request ID', value: `#${requests.within.id}`, mono: true }, { label: 'Outcome', value: 'Executed' }, { label: 'TEE latency', value: `${evidence.teeLatencySec.within}s · single run` }],
      proofNotes: ['The finalize transaction is the proof-gated public transition.', 'TEE latency is a measurement from this one evidence run, not a percentile.'],
      transactions: [
        { label: 'Request', hash: asHash(requests.within.requestTx), note: 'Encrypted spend submitted' },
        { label: 'Finalize', hash: asHash(requests.within.finalizeTx), note: 'Proof-gated direct execution' },
      ],
    },
    {
      id: 'frozen-approved',
      source: 'frozen',
      title: `Escalated payment · Request #${requests.escalated.id}`,
      subtitle: `Mandate #${evidence.mandate.id} · Safe exception`,
      outcome: 'SAFE APPROVED',
      outcomeClass: 'warn',
      stages: [
        { title: 'Encrypted request submitted', detail: 'The request transaction recorded the confidential amount.', status: 'complete' },
        { title: 'TEE escalated to escrow', detail: `Recorded single-run latency: ${evidence.teeLatencySec.escalated}s.`, status: 'complete' },
        { title: 'Safe 2-of-2 approved', detail: `${requests.escalated.approval.confirmations}/${requests.escalated.approval.threshold} confirmations executed the exception.`, status: 'complete' },
        { title: 'Recipient paid', detail: 'Reserved confidential funds were released by the Safe-authorized module call.', status: 'complete' },
      ],
      publicFacts: [...baseFacts, { label: 'Request ID', value: `#${requests.escalated.id}`, mono: true }, { label: 'Outcome', value: 'Approved' }, { label: 'Safe transaction hash', value: requests.escalated.approval.safeTxHash, mono: true }],
      proofNotes: ['The request first reached AwaitingSafeApproval; the linked Safe execution completed it.', 'The recorded threshold requires two distinct owner confirmations.'],
      transactions: [
        { label: 'Request', hash: asHash(requests.escalated.requestTx), note: 'Encrypted spend submitted' },
        { label: 'Finalize', hash: asHash(requests.escalated.finalizeTx), note: 'TEE escalation published and escrow reserved' },
        { label: 'Safe approval', hash: asHash(requests.escalated.approval.executeTxHash), note: `${requests.escalated.approval.confirmations}/${requests.escalated.approval.threshold} execution` },
      ],
    },
    {
      id: 'frozen-blocked',
      source: 'frozen',
      title: `Blocked payment · Request #${requests.blocked.id}`,
      subtitle: `Mandate #${evidence.mandate.id} · no funds moved`,
      outcome: 'BLOCKED',
      outcomeClass: 'bad',
      stages: [
        { title: 'Encrypted request submitted', detail: 'The request transaction recorded the confidential amount.', status: 'complete' },
        { title: 'TEE decision finalized', detail: `Recorded single-run latency: ${evidence.teeLatencySec.blocked}s.`, status: 'complete' },
        { title: 'Blocked outcome recorded', detail: 'The module recorded a public blocked state while the reason remained encrypted.', status: 'complete' },
      ],
      publicFacts: [...baseFacts, { label: 'Request ID', value: `#${requests.blocked.id}`, mono: true }, { label: 'Outcome', value: 'Blocked' }, { label: 'TEE latency', value: `${evidence.teeLatencySec.blocked}s · single run` }],
      proofNotes: ['The public state proves the request was blocked, not the private reason.', 'No Safe approval transaction is expected for this path.'],
      transactions: [
        { label: 'Request', hash: asHash(requests.blocked.requestTx), note: 'Encrypted spend submitted' },
        { label: 'Finalize', hash: asHash(requests.blocked.finalizeTx), note: 'Proof-gated blocked outcome' },
      ],
    },
    {
      id: 'frozen-audit',
      source: 'frozen',
      title: `Audit packet #${evidence.packet.id}`,
      subtitle: `Requests #${evidence.packet.requestIds.join(', #')}`,
      outcome: 'DISCLOSED',
      outcomeClass: 'tee',
      stages: [
        { title: 'Terminal requests selected', detail: `${evidence.packet.requestIds.length} request IDs were bound to the packet.`, status: 'complete' },
        { title: 'Immutable snapshots created', detail: 'The v1 contract created fixed policy and per-request snapshot handles.', status: 'complete' },
        { title: 'Auditor grant recorded', detail: 'Packet creation and its exact on-chain scope are linked below.', status: 'complete' },
      ],
      publicFacts: [...baseFacts, { label: 'Packet ID', value: `#${evidence.packet.id}`, mono: true }, { label: 'Request IDs', value: evidence.packet.requestIds.map((id: number) => `#${id}`).join(', '), mono: true }, { label: 'Disclosure schema', value: 'VeilGuardModule v1 fixed scope' }],
      proofNotes: ['The packet is scoped disclosure, not a claim about every historical request.', 'Only the authorised auditor can decrypt the snapshot handles.'],
      transactions: [{ label: 'Create audit packet', hash: asHash(evidence.packet.createTx), note: 'Immutable snapshot grant' }],
    },
  ];
}

function flowIdFromHash() {
  if (typeof window === 'undefined') return '';
  const route = parseAppHash(window.location.hash);
  return route?.page === 'verify' ? route.flowId ?? '' : '';
}

function sourceForFlowId(flowId: string): FlowSource {
  return flowId.startsWith('frozen-') ? 'frozen' : 'live';
}

/** A master-detail evidence explorer separating current chain state from the frozen submission run. */
export function VerifyView() {
  const { requests } = useApp();
  const [requestTxs, setRequestTxs] = useState<Map<string, RequestTxs>>(new Map());
  const [txLoading, setTxLoading] = useState(true);
  const [txError, setTxError] = useState(false);
  const [source, setSource] = useState<FlowSource>(() => sourceForFlowId(flowIdFromHash()));
  const [selectedId, setSelectedId] = useState<string>(flowIdFromHash);
  const [tab, setTab] = useState<ExplorerTab>('Flow');

  useEffect(() => {
    setTxLoading(true);
    fetchRequestTxs()
      .then((next) => { setRequestTxs(next); setTxError(false); })
      .catch(() => setTxError(true))
      .finally(() => setTxLoading(false));
  }, []);

  useEffect(() => {
    const onHashChange = () => {
      const flowId = flowIdFromHash();
      if (!flowId) return;
      setSelectedId(flowId);
      setSource(sourceForFlowId(flowId));
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const liveFlows = useMemo(
    () => requests.slice().sort((a, b) => a.id > b.id ? -1 : 1).map((request) => buildLiveFlow(request, requestTxs.get(String(request.id)))),
    [requests, requestTxs],
  );
  const frozenFlows = useMemo(() => buildFrozenFlows(), []);
  const flows = source === 'live' ? liveFlows : frozenFlows;
  const selected = flows.find((flow) => flow.id === selectedId) ?? flows[0];

  useEffect(() => {
    if (flows.length && !flows.some((flow) => flow.id === selectedId)) setSelectedId(flows[0].id);
  }, [flows, selectedId]);

  const selectFlow = (id: string) => {
    setSelectedId(id);
    setTab('Flow');
    window.location.hash = formatAppRoute({ page: 'verify', flowId: id });
  };

  const selectSource = (next: FlowSource) => {
    setSource(next);
    setSelectedId('');
    setTab('Flow');
    window.location.hash = formatAppRoute({ page: 'verify' });
  };

  const tabs = [
    { id: 'Flow', label: 'Flow' },
    { id: 'Public Data', label: 'Public data' },
    { id: 'Proof', label: 'Proof' },
    { id: 'Transactions', label: 'Transactions', count: selected?.transactions.filter((tx) => tx.hash).length },
  ] as const;

  return (
    <>
      <div className="dash-head verify-page-head">
        <div>
          <h1 className="dash-title">Confidential flow explorer</h1>
          <p className="dash-sub">Trace public state, proof boundaries and real Sepolia transactions without relying on UI claims.</p>
        </div>
        <div className="evidence-source-switch" role="group" aria-label="Evidence source">
          <button type="button" className={source === 'live' ? 'active' : ''} aria-pressed={source === 'live'} onClick={() => selectSource('live')}>Live chain state</button>
          <button type="button" className={source === 'frozen' ? 'active' : ''} aria-pressed={source === 'frozen'} onClick={() => selectSource('frozen')}>Frozen evidence run</button>
        </div>
      </div>

      <div className={`evidence-source-note ${source}`}>
        <span className={`pill ${source === 'live' ? 'ok' : 'tee'}`}>{source === 'live' ? 'LIVE' : 'FROZEN'}</span>
        {source === 'live' ? (
          <span>Current request objects are read from VeilGuardModule. Transaction links come from its Sepolia events{txLoading ? ' and are still indexing.' : txError ? '; the event index is currently unavailable.' : '.'}</span>
        ) : (
          <span>Submission evidence captured {new Date((EVIDENCE as any).generatedAt).toLocaleString()} at commit <span className="mono">{(EVIDENCE as any).commit}</span>. It does not change with the live app.</span>
        )}
      </div>

      {source === 'live' && !liveFlows.length && (
        <div className="card verify-empty" role="status">
          <h2>Waiting for live request state</h2>
          <p className="muted">No request objects have loaded from Sepolia. Switch to the frozen evidence run to inspect the submission proof set.</p>
          <button type="button" className="btn" onClick={() => selectSource('frozen')}>Open frozen evidence</button>
        </div>
      )}

      {selected && (
        <Workbench className="flow-explorer">
          <WorkbenchList
            title={source === 'live' ? 'Live flows' : 'Evidence flows'}
            description={source === 'live' ? `${liveFlows.length} on-chain request objects` : `${frozenFlows.length} records in the evidence run`}
          >
            <div className="object-list flow-object-list">
              {flows.map((flow) => (
                <button
                  type="button"
                  key={flow.id}
                  className={`object-list-item flow-object ${selected.id === flow.id ? 'active' : ''}`}
                  aria-current={selected.id === flow.id ? 'true' : undefined}
                  onClick={() => selectFlow(flow.id)}
                >
                  <span className="object-list-title">{flow.title}</span>
                  <span className="object-list-meta">{flow.subtitle}</span>
                  <span className={`pill ${flow.outcomeClass}`}>{flow.outcome}</span>
                </button>
              ))}
            </div>
          </WorkbenchList>

          <WorkbenchDetail labelledBy="flow-explorer-title">
            <header className="workbench-detail-head flow-detail-head">
              <div>
                <div className="workbench-kicker">{selected.source === 'live' ? 'Current Sepolia state' : `Evidence commit ${(EVIDENCE as any).commit}`}</div>
                <h2 id="flow-explorer-title">{selected.title}</h2>
                <p>{selected.subtitle}</p>
              </div>
              <span className={`pill ${selected.outcomeClass}`}>{selected.outcome}</span>
            </header>

            <WorkbenchTabs tabs={tabs} active={tab} onChange={setTab} label={`${selected.title} evidence sections`} idPrefix="flow-explorer" />
            <div id="flow-explorer-panel" className="workbench-panel" role="tabpanel" aria-labelledby={`flow-explorer-tab-${tab.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}>
              {tab === 'Flow' && <FlowTimeline stages={selected.stages} />}

              {tab === 'Public Data' && (
                <section className="flow-public-data" aria-labelledby="public-data-title">
                  <div className="section-head">
                    <div>
                      <h3 id="public-data-title">Publicly verifiable data</h3>
                      <p className="muted">Ciphertext handles are public identifiers, not plaintext values.</p>
                    </div>
                  </div>
                  <dl className="flow-facts">
                    {selected.publicFacts.map((fact) => (
                      <div key={fact.label}><dt>{fact.label}</dt><dd className={fact.mono ? 'mono' : ''}>{fact.value}</dd></div>
                    ))}
                  </dl>
                  <div className="privacy-boundary-note">
                    <b>Privacy boundary</b>
                    <span>This explorer never derives or displays confidential amounts, policy thresholds or block reasons from public data.</span>
                  </div>
                </section>
              )}

              {tab === 'Proof' && (
                <section className="flow-proof" aria-labelledby="proof-boundary-title">
                  <h3 id="proof-boundary-title">What this evidence proves</h3>
                  <ul className="proof-note-list">
                    {selected.proofNotes.map((note) => <li key={note}>{note}</li>)}
                  </ul>
                  <div className="proof-contracts">
                    <a href={scan(ADDR.VeilGuardModule)} target="_blank" rel="noopener noreferrer"><span>VeilGuardModule</span><code>{short(ADDR.VeilGuardModule)}</code></a>
                    <a href={scan(ADDR.Safe)} target="_blank" rel="noopener noreferrer"><span>Safe 2-of-2</span><code>{short(ADDR.Safe)}</code></a>
                    <a href={scan(ADDR.NoxCompute)} target="_blank" rel="noopener noreferrer"><span>NoxCompute</span><code>{short(ADDR.NoxCompute)}</code></a>
                  </div>
                </section>
              )}

              {tab === 'Transactions' && (
                <section className="flow-transactions" aria-labelledby="transactions-title">
                  <h3 id="transactions-title">Transaction trail</h3>
                  <div className="transaction-list">
                    {selected.transactions.map((transaction) => (
                      <div key={transaction.label} className="transaction-row">
                        <div><b>{transaction.label}</b><span>{transaction.note}</span></div>
                        {transaction.hash ? (
                          <a href={scanTx(transaction.hash)} target="_blank" rel="noopener noreferrer" className="mono alink">{short(transaction.hash)} · Etherscan</a>
                        ) : <span className="pill dim">NO LINK</span>}
                      </div>
                    ))}
                  </div>
                  {selected.transactions.every((transaction) => !transaction.hash) && <p className="muted">No transaction hashes are available for this record. The explorer does not invent placeholders.</p>}
                </section>
              )}
            </div>
          </WorkbenchDetail>
        </Workbench>
      )}

      <section className="verify-infrastructure" aria-labelledby="deployed-infrastructure-title">
        <div className="card verify-contracts">
          <h3 id="deployed-infrastructure-title">Deployed infrastructure <small>Ethereum Sepolia</small></h3>
          <div className="tbl"><table>
            <tbody>
              <ContractRow label="VeilGuardModule" address={ADDR.VeilGuardModule} />
              <ContractRow label="Safe v1.4.1 · 2-of-2" address={ADDR.Safe} />
              <ContractRow label="cUSDC · ERC-7984 wrapper" address={ADDR.ConfidentialUSDC} />
              <ContractRow label="TestUSDC · faucet ERC-20" address={ADDR.TestUSDC} />
              <ContractRow label="NoxCompute" address={ADDR.NoxCompute} />
            </tbody>
          </table></div>
        </div>

        <div className="card verify-provenance">
          <h3>Build provenance</h3>
          <dl className="flow-facts compact">
            <div><dt>UI build</dt><dd className="mono">{__UI_BUILD_SHA__}</dd></div>
            <div><dt>Evidence commit</dt><dd className="mono">{(EVIDENCE as any).commit}</dd></div>
            <div><dt>Evidence captured</dt><dd>{new Date((EVIDENCE as any).generatedAt).toISOString()}</dd></div>
            <div><dt>Source</dt><dd><a href="https://github.com/a252937166/veilguard" target="_blank" rel="noopener noreferrer">GitHub repository</a></dd></div>
          </dl>
          <p className="muted">The frozen run may predate this UI build; their commit identifiers are shown separately.</p>
        </div>
      </section>
    </>
  );
}

function FlowTimeline({ stages }: { stages: FlowStage[] }) {
  return (
    <section className="flow-timeline" aria-labelledby="flow-timeline-title">
      <div className="section-head">
        <div>
          <h3 id="flow-timeline-title">Evidence sequence</h3>
          <p className="muted">Each step reflects a real object state or an indexed transaction.</p>
        </div>
      </div>
      <ol>
        {stages.map((stage, index) => (
          <li key={`${stage.title}-${index}`} className={stage.status}>
            <span className="flow-stage-mark" aria-hidden="true">{stage.status === 'complete' ? '✓' : stage.status === 'current' ? '•' : '—'}</span>
            <div><b>{stage.title}</b><p>{stage.detail}</p></div>
            <span className={`pill ${stage.status === 'complete' ? 'ok' : stage.status === 'current' ? 'warn' : stage.status === 'failed' ? 'bad' : 'dim'}`}>
              {stage.status === 'not-applicable' ? 'NOT REQUIRED' : stage.status === 'failed' ? 'STOPPED' : stage.status.toUpperCase()}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ContractRow({ label, address }: { label: string; address: `0x${string}` }) {
  return (
    <tr>
      <td>{label}</td>
      <td><a href={scan(address)} target="_blank" rel="noopener noreferrer" className="mono alink">{address}</a></td>
    </tr>
  );
}
