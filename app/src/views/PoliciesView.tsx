import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Workbench, WorkbenchDetail, WorkbenchList, WorkbenchTabs } from '../components/workbench';
import { MANDATE_STATES, REQUEST_STATES, scan, short } from '../config';
import { formatAppRoute, parseAppHash } from '../routes';
import { useApp } from '../App';

type PolicyTab = 'Overview' | 'Requests' | 'Governance';

export function PoliciesView() {
  const { mandates, requests, paused } = useApp();
  const location = useLocation();
  const navigate = useNavigate();
  const route = useMemo(() => parseAppHash(`#${location.pathname}`), [location.pathname]);
  const selectedId = route?.page === 'policy-detail' && /^\d+$/.test(route.policyId) ? BigInt(route.policyId) : null;
  const isDetailRoute = route?.page === 'policy-detail';
  const [tab, setTab] = useState<PolicyTab>('Overview');
  const sorted = useMemo(() => mandates.slice().sort((a, b) => a.id > b.id ? -1 : 1), [mandates]);
  const policy = selectedId == null ? undefined : sorted.find((item) => item.id === selectedId);
  const related = useMemo(
    () => policy ? requests.filter((request) => request.mandateId === policy.id).sort((a, b) => a.id > b.id ? -1 : 1) : [],
    [policy, requests],
  );

  useEffect(() => { setTab('Overview'); }, [route?.page === 'policy-detail' ? route.policyId : null]);

  const selectPolicy = (id: bigint) => {
    navigate(formatAppRoute({ page: 'policy-detail', policyId: String(id) }).slice(1));
  };

  const backToPolicies = () => navigate(formatAppRoute({ page: 'policies' }).slice(1));

  if (!sorted.length) {
    return (
      <div className="card empty-state" role="status">
        <h2>No policy objects loaded</h2>
        <p className="muted">VeilGuard has not loaded a mandate from Sepolia yet. The page will populate from the module, not from placeholder records.</p>
      </div>
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
        <span className={`pill ${paused ? 'bad' : 'ok'}`}>{paused ? 'EMERGENCY PAUSE' : 'MODULE ACTIVE'}</span>
      </div>

      <Workbench className={`policy-workbench ${isDetailRoute ? 'workbench-route-detail' : 'workbench-route-list'}`}>
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
                    <div><dt>Valid from</dt><dd>{new Date(Number(policy.validFrom) * 1000).toLocaleString()}</dd></div>
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
                <div className="inline-alert neutral">Transaction hashes are shown only when an indexed module event supplies them; this view does not invent proposal or signature times.</div>
              </section>
            )}
            </div>
          </> : (
            <div className="workbench-empty-detail empty-state" role={isDetailRoute ? 'alert' : 'status'}>
              {isDetailRoute && (
                <button type="button" className="mobile-detail-back" onClick={backToPolicies}>
                  <span aria-hidden="true">←</span> Policy objects
                </button>
              )}
              <b>{isDetailRoute ? 'Policy not found' : 'Select a policy'}</b>
              <span>{isDetailRoute ? 'This mandate is not present in the current Sepolia registry.' : 'Choose an on-chain mandate to inspect its encrypted parameters, requests and governance history.'}</span>
            </div>
          )}
        </WorkbenchDetail>
      </Workbench>
    </>
  );
}
