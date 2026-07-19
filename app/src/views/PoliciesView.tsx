import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Workbench, WorkbenchDetail, WorkbenchList, WorkbenchTabs } from '../components/workbench';
import { MandateComposer } from '../components/MandateComposer';
import { ADDR, MANDATE_STATES, REQUEST_STATES, moduleAbi, scan, short } from '../config';
import { formatAppRoute, parseAppHash } from '../routes';
import { useApp } from '../App';
import { makeWalletClient, publicClient } from '../nox';
import { governance2of2, type GovFn } from '../safe-browser';
import { walletWrite } from '../walletTx';
import { derivePolicyCapabilities } from '../policy-capabilities';

type PolicyTab = 'Overview' | 'Requests' | 'Governance';

export const formatMandateStart = (validFrom: bigint) => validFrom === 0n
  ? 'Immediately on activation'
  : new Date(Number(validFrom) * 1000).toLocaleString();

export function PoliciesView() {
  const { account, financeAdmin, owners, mandates, requests, paused, run, busy, refresh, toast } = useApp();
  const location = useLocation();
  const navigate = useNavigate();
  const route = useMemo(() => parseAppHash(`#${location.pathname}`), [location.pathname]);
  const selectedId = (route?.page === 'policy-detail' || route?.page === 'policy-new-version') && /^\d+$/.test(route.policyId) ? BigInt(route.policyId) : null;
  const isDetailRoute = route?.page === 'policy-detail' || route?.page === 'policy-new-version';
  const [tab, setTab] = useState<PolicyTab>('Overview');
  const [actionStep, setActionStep] = useState<string | null>(null);
  const composer = route?.page === 'policy-new' ? 'new' : route?.page === 'policy-new-version' ? 'version' : null;
  const sorted = useMemo(() => mandates.slice().sort((a, b) => a.id > b.id ? -1 : 1), [mandates]);
  const policy = selectedId == null ? undefined : sorted.find((item) => item.id === selectedId);
  const related = useMemo(
    () => policy ? requests.filter((request) => request.mandateId === policy.id).sort((a, b) => a.id > b.id ? -1 : 1) : [],
    [policy, requests],
  );
  const isFinanceAdmin = !!account && !!financeAdmin && account.toLowerCase() === financeAdmin.toLowerCase();
  const isSafeOwner = !!account && owners.some((owner) => owner.toLowerCase() === account.toLowerCase());
  const hasPendingRequest = related.some((request) => request.state === 1 || request.state === 3);
  const activeDelegatePolicy = policy?.state === 1
    ? mandates.find((candidate) => candidate.id !== policy.id
      && candidate.state === 2
      && candidate.delegate.toLowerCase() === policy.delegate.toLowerCase())
    : undefined;
  const activationBlockingRequest = activeDelegatePolicy
    ? requests.find((request) => request.mandateId === activeDelegatePolicy.id && (request.state === 1 || request.state === 3))
    : undefined;
  const capabilities = derivePolicyCapabilities({
    isFinanceAdmin,
    isSafeOwner,
    policyState: policy?.state,
    paused,
    hasPendingRequest,
    hasActiveDelegatePendingRequest: !!activationBlockingRequest,
  });

  useEffect(() => { setTab('Overview'); }, [route?.page === 'policy-detail' || route?.page === 'policy-new-version' ? route.policyId : null]);

  const selectPolicy = (id: bigint) => {
    navigate(formatAppRoute({ page: 'policy-detail', policyId: String(id) }).slice(1));
  };

  const backToPolicies = () => navigate(formatAppRoute({ page: 'policies' }).slice(1));
  const openComposer = (mode: 'new' | 'version') => navigate(formatAppRoute(
    mode === 'version' && policy
      ? { page: 'policy-new-version', policyId: String(policy.id) }
      : { page: 'policy-new' },
  ).slice(1));
  const closeComposer = () => navigate(formatAppRoute(
    composer === 'version' && policy
      ? { page: 'policy-detail', policyId: String(policy.id) }
      : { page: 'policies' },
  ).slice(1));

  const governance = (label: string, fn: GovFn, args: unknown[]) => run(label, async () => {
    if (!account || !isSafeOwner) throw new Error('connect a current Safe owner');
    try {
      const hash = await governance2of2(makeWalletClient(account), fn, args, setActionStep);
      toast(`Safe 2-of-2 confirmed · ${short(hash)}`);
      await Promise.resolve(refresh());
    } finally {
      setActionStep(null);
    }
  });

  const pauseModule = () => run('Pause all mandates', async () => {
    if (!account || !isFinanceAdmin) throw new Error('connect the current Finance Admin');
    try {
      setActionStep('Review and sign the emergency pause…');
      const hash = await walletWrite({
        account,
        address: ADDR.VeilGuardModule,
        abi: moduleAbi,
        functionName: 'pauseAll',
        args: [],
        onHint: setActionStep,
      });
      setActionStep('Pause broadcast · waiting for confirmation…');
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error('pause transaction reverted');
      toast(`Emergency pause confirmed · ${short(hash)}`);
    } finally {
      setActionStep(null);
    }
  });

  if (!sorted.length) {
    return (
      <>
        {composer === 'new' && isFinanceAdmin && <MandateComposer onCancel={closeComposer} onComplete={() => { backToPolicies(); void refresh(); }} />}
        <div className="card empty-state" role="status">
          <h2>No policy objects loaded</h2>
          <p className="muted">VeilGuard has not loaded a mandate from Sepolia yet. The page will populate from the module, not from placeholder records.</p>
          <button type="button" className="btn primary" disabled={!isFinanceAdmin} onClick={() => openComposer('new')}>New confidential mandate</button>
          {!isFinanceAdmin && <span className="muted">Connect the authorised Finance Admin wallet to create one.</span>}
        </div>
      </>
    );
  }

  const tabs = [
    { id: 'Overview', label: 'Overview' },
    { id: 'Requests', label: 'Requests', count: related.length },
    { id: 'Governance', label: 'Governance' },
  ] as const;

  return (
    <>
      <div className="dash-head">
        <div>
          <p className="workspace-kicker">Policy registry</p>
          <h1 className="dash-title">Confidential mandates</h1>
          <p className="dash-sub">Inspect the public policy object and its encrypted parameters without pretending ciphertext handles are values.</p>
        </div>
        <div className="workbench-actions">
          <span className={`pill ${paused ? 'bad' : 'ok'}`}>{paused ? 'EMERGENCY PAUSE' : 'MODULE ACTIVE'}</span>
          <button type="button" className="btn primary" disabled={!capabilities.canPropose || !!busy} onClick={() => openComposer('new')}>New confidential mandate</button>
        </div>
      </div>

      {!isFinanceAdmin && <div className="inline-alert neutral policy-role-boundary"><b>Finance Admin action.</b> Connect the authorised wallet to propose encrypted policy drafts. Safe owners independently activate or retire them.</div>}
      {composer && capabilities.canPropose && (composer === 'new' || policy) && <MandateComposer key={`${composer}-${policy?.id ?? 'new'}`} source={composer === 'version' ? policy : undefined} onCancel={closeComposer} onComplete={() => { closeComposer(); void refresh(); }} />}
      {actionStep && <div className="operation-note policy-action-step" role="status" aria-live="polite"><span className="spin" aria-hidden="true" />{actionStep}</div>}

      <Workbench className={`policy-workbench ${!policy ? 'workbench-no-selection' : ''} ${isDetailRoute ? 'workbench-route-detail' : 'workbench-route-list'}`}>
        <WorkbenchList title="Policy objects" description={`${sorted.length} mandate${sorted.length === 1 ? '' : 's'} on Sepolia`}>
          <div className="object-list">
            {sorted.map((item) => (
              <button
                type="button"
                key={String(item.id)}
                className={`object-list-item ${selectedId === item.id ? 'active' : ''}`}
                aria-current={selectedId === item.id ? 'page' : undefined}
                onClick={() => selectPolicy(item.id)}
              >
                <span className="object-list-title">Mandate #{String(item.id)} · v{item.version}</span>
                <span className="object-list-meta">Delegate {short(item.delegate)}</span>
                <span className={`pill ${item.state === 2 ? 'ok' : item.state === 1 ? 'warn' : 'dim'}`}>{MANDATE_STATES[item.state] ?? `STATE ${item.state}`}</span>
              </button>
            ))}
          </div>
        </WorkbenchList>

        <WorkbenchDetail labelledBy={policy ? 'policy-detail-title' : undefined}>
          {policy ? <>
            <button type="button" className="mobile-detail-back" onClick={backToPolicies}>
              <span aria-hidden="true">←</span> Policy objects
            </button>
            <header className="workbench-detail-head">
              <div>
                <p className="workbench-kicker">On-chain policy object</p>
                <h2 id="policy-detail-title">Mandate #{String(policy.id)}</h2>
                <p>Version {policy.version} · Delegate <span className="mono">{short(policy.delegate)}</span></p>
              </div>
              <span className={`pill ${policy.state === 2 ? 'ok' : policy.state === 1 ? 'warn' : 'dim'}`}>{MANDATE_STATES[policy.state] ?? `STATE ${policy.state}`}</span>
            </header>

            <WorkbenchTabs tabs={tabs} active={tab} onChange={setTab} label="Policy detail sections" idPrefix="policy-detail" />
            <div id="policy-detail-panel" className="workbench-panel" role="tabpanel" aria-labelledby={`policy-detail-tab-${tab.toLowerCase()}`}>
            {tab === 'Overview' && (
              <div className="policy-overview">
                <section className="policy-section">
                  <div className="section-heading compact">
                    <div><h3>Encrypted policy parameters</h3><p>Public ciphertext handles; plaintext remains ACL-gated.</p></div>
                    <span className="pill tee">NOX CIPHERTEXT</span>
                  </div>
                  <dl className="policy-handle-list">
                    <div><dt>Auto-limit</dt><dd className="mono">{short(policy.autoLimit)}</dd></div>
                    <div><dt>Budget left</dt><dd className="mono">{short(policy.budgetLeft)}</dd></div>
                    <div><dt>Reserve floor</dt><dd className="mono">{short(policy.reserveFloor)}</dd></div>
                  </dl>
                </section>

                <section className="policy-section">
                  <h3>Delegation scope</h3>
                  <dl className="policy-facts">
                    <div><dt>Delegate</dt><dd><a className="mono" href={scan(policy.delegate)} target="_blank" rel="noopener noreferrer">{policy.delegate}</a></dd></div>
                    <div><dt>Valid from</dt><dd>{formatMandateStart(policy.validFrom)}</dd></div>
                    <div><dt>Valid until</dt><dd>{new Date(Number(policy.validUntil) * 1000).toLocaleString()}</dd></div>
                    <div><dt>Allowed recipients</dt><dd>{policy.recipients.length}</dd></div>
                  </dl>
                  <div className="recipient-list">
                    {policy.recipients.map((recipient) => <a key={recipient} href={scan(recipient)} target="_blank" rel="noopener noreferrer" className="mono">{recipient}</a>)}
                  </div>
                </section>

                <section className={`emergency-controls ${paused ? 'paused' : ''}`}>
                  <div><p className="workbench-kicker">Emergency controls</p><h3>{paused ? 'Module-wide pause is active' : 'No emergency pause is active'}</h3></div>
                  <p>{paused ? 'New requests are stopped at the contract boundary until Safe governance resumes the module.' : 'Emergency pause is a separate module control; it does not modify the encrypted thresholds shown above.'}</p>
                </section>
              </div>
            )}

            {tab === 'Requests' && (
              <section>
                <div className="section-heading compact"><div><h3>Requests governed by this mandate</h3><p>Current objects read from VeilGuardModule.</p></div></div>
                <div className="related-request-list">
                  {related.map((request) => (
                    <button type="button" key={String(request.id)} onClick={() => navigate(formatAppRoute({ page: 'payment-detail', requestId: String(request.id) }).slice(1))}>
                      <span><b>Request #{String(request.id)}</b><small className="mono">{short(request.recipient)}</small></span>
                      <span className={`pill ${request.state === 2 ? 'ok' : request.state === 3 ? 'warn' : request.state === 4 || request.state === 5 ? 'bad' : 'dim'}`}>{REQUEST_STATES[request.state] ?? request.state}</span>
                    </button>
                  ))}
                  {!related.length && <p className="muted">No request currently references this mandate.</p>}
                </div>
              </section>
            )}

            {tab === 'Governance' && (
              <section className="governance-history">
                <h3>Governance history</h3>
                <ol className="timeline-list">
                  <li className="complete"><b>Mandate proposed</b><span>Finance Admin committed encrypted parameters and recipient scope.</span></li>
                  <li className={policy.state >= 2 ? 'complete' : 'current'}><b>Safe decision</b><span>{policy.state >= 2 ? 'The public policy state confirms activation.' : 'Draft is waiting for a threshold Safe action.'}</span></li>
                  {policy.state === 3 && <li className="complete"><b>Mandate retired</b><span>The module now reports the object as retired.</span></li>}
                </ol>
                <div className="policy-capability-panel" aria-label="Policy capabilities">
                  <div className="section-heading compact"><div><h3>Available actions</h3><p>Every control is tied to its real on-chain authority.</p></div></div>
                  <div className="policy-capability-grid">
                    <div><b>Propose replacement</b><p>Finance Admin encrypts a new Draft; the active object is not edited.</p><button type="button" className="btn" disabled={!capabilities.canPropose || !!busy} onClick={() => openComposer('version')}>Propose new version</button>{!isFinanceAdmin && <small>Requires Finance Admin</small>}</div>
                    <div><b>Activate draft</b><p>Safe threshold action that makes a Draft active.</p><button type="button" className="btn" disabled={!capabilities.canActivate || !!busy} onClick={() => governance(`Activate mandate #${policy.id}`, 'activateMandate', [policy.id])}>Activate 2-of-2</button>{!isSafeOwner && <small>Requires current Safe owner</small>}{capabilities.activateBlockedReason && <small>{capabilities.activateBlockedReason}{activationBlockingRequest ? ` Request #${activationBlockingRequest.id} is still ${REQUEST_STATES[activationBlockingRequest.state] ?? 'in flight'}.` : ''}</small>}</div>
                    <div><b>Retire mandate</b><p>Safe threshold action; in-flight requests must be resolved first.</p><button type="button" className="btn danger" disabled={!capabilities.canRetire || !!busy} onClick={() => governance(`Retire mandate #${policy.id}`, 'retireMandate', [policy.id])}>Retire 2-of-2</button>{capabilities.retireBlockedReason && <small>{capabilities.retireBlockedReason}</small>}</div>
                    <div><b>{paused ? 'Resume module' : 'Emergency pause'}</b><p>{paused ? 'Only the Safe can widen access again.' : 'Finance Admin may tighten spending immediately.'}</p>{paused ? <button type="button" className="btn primary" disabled={!capabilities.canResume || !!busy} onClick={() => governance('Resume all mandates', 'unpauseAll', [])}>Resume 2-of-2</button> : <button type="button" className="btn danger" disabled={!capabilities.canPause || !!busy} onClick={pauseModule}>Pause module</button>}<small>{paused ? 'Requires current Safe owner' : 'Requires Finance Admin'}</small></div>
                    <div><b>Change Finance Admin</b><p>This changes a high-trust service identity and is not exposed through public auto co-signing.</p><button type="button" className="btn" disabled>Managed through Safe operations</button></div>
                  </div>
                </div>
                <div className="inline-alert neutral">Transaction hashes are shown only when an indexed module event supplies them; this view does not invent proposal or signature times.</div>
              </section>
            )}
            </div>
          </> : (
            <div className="workbench-empty-detail" role={isDetailRoute ? 'alert' : 'status'}>
              {isDetailRoute && (
                <button type="button" className="mobile-detail-back" onClick={backToPolicies}>
                  <span aria-hidden="true">←</span> Policy objects
                </button>
              )}
              <header className="workbench-detail-head empty-detail-head">
                <div>
                  <span className="workbench-kicker">Policy registry</span>
                  <h2>{isDetailRoute ? 'Policy not found' : 'Choose an on-chain mandate'}</h2>
                  <p>{isDetailRoute ? 'This mandate is not present in the current Sepolia registry.' : 'Inspect encrypted parameters, governed requests and real governance state in one object view.'}</p>
                </div>
              </header>
              <div className="empty-detail-body policy-empty-body">
                <dl className="policy-empty-stats">
                  <div><dt>Total objects</dt><dd>{sorted.length}</dd></div>
                  <div><dt>Active</dt><dd>{sorted.filter((item) => item.state === 2).length}</dd></div>
                  <div><dt>Draft or retired</dt><dd>{sorted.filter((item) => item.state !== 2).length}</dd></div>
                </dl>
                <button type="button" className="btn primary" onClick={() => selectPolicy(sorted[0].id)}>Open latest mandate</button>
              </div>
            </div>
          )}
        </WorkbenchDetail>
      </Workbench>
    </>
  );
}
