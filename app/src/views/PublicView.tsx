import { useEffect, useMemo, useState } from 'react';
import { ADDR, scan, short } from '../config';
import { DEMO_SCENARIOS } from '../demo-scenarios';
import { useApp, type SpendRequest } from '../App';
import { INITIAL_SYSTEM_READINESS, probeSystemReadiness } from '../system-readiness';
import { RequestPill } from '../ui';

function ago(ts: bigint): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - Number(ts));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function outcomeLabel(request?: SpendRequest) {
  if (!request) return 'Ready to review';
  return ['Unknown', request.decisionReady ? 'Proof ready' : 'TEE evaluating', 'Executed', 'Awaiting approval', 'Blocked', 'Cancelled · refunded', 'Expired'][request.state] ?? 'Unknown';
}

function requestTime(request?: SpendRequest) {
  if (!request) return 'Not submitted';
  const date = new Date(Number(request.createdAt) * 1_000);
  return Number.isNaN(date.getTime())
    ? 'Time unavailable'
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function PublicView() {
  const { mandates, requests, goTab, refresh } = useApp();
  const [readiness, setReadiness] = useState(INITIAL_SYSTEM_READINESS);

  useEffect(() => {
    let stopped = false;
    const probe = async () => {
      const handle = [...requests]
        .filter((request) => request.decision && !/^0x0+$/.test(request.decision))
        .sort((a, b) => Number(b.createdAt - a.createdAt))[0]?.decision;
      const result = await probeSystemReadiness(handle);
      if (!stopped) setReadiness(result);
    };
    probe();
    const timer = setInterval(probe, 30_000);
    return () => { stopped = true; clearInterval(timer); };
  }, [requests]);

  const storyRequests = useMemo(() => DEMO_SCENARIOS.map((scenario) => ({
    scenario,
    request: [...requests]
      .filter((request) => request.recipient.toLowerCase() === scenario.recipient.toLowerCase())
      .sort((a, b) => Number(b.id - a.id))[0],
  })), [requests]);

  const recent = useMemo(() => [...requests]
    .sort((a, b) => Number(b.createdAt - a.createdAt))
    .slice(0, 5), [requests]);

  const activeMandates = mandates.filter((mandate) => mandate.state === 2).length;
  const awaiting = requests.filter((request) => request.state === 1 || request.state === 3).length;
  const terminal = requests.filter((request) => [2, 4, 5, 6].includes(request.state)).length;
  return (
    <>
      <header className="workspace-heading">
        <div>
          <span className="detail-kicker">Live treasury · Ethereum Sepolia</span>
          <h1>Launch Day Treasury Shift</h1>
          <p>Three invoices, one confidential treasury workflow, and a complete trail from private policy evaluation to public proof.</p>
        </div>
        <button className="btn primary" onClick={() => goTab('Delegate')}>Open Payment Inbox</button>
      </header>

      <div className="proof-strip" aria-label="Live proof stack">
        <a href={scan(ADDR.Safe)} target="_blank" rel="noopener"><b>Safe 2-of-2</b><span>{short(ADDR.Safe)} ↗</span></a>
        <a href={scan(ADDR.VeilGuardModule)} target="_blank" rel="noopener"><b>VeilGuard Module</b><span>{short(ADDR.VeilGuardModule)} ↗</span></a>
        <span><b>iExec Nox TEE</b><span>proof-gated outcomes</span></span>
        <span><b>Scoped disclosure</b><span>immutable snapshot handles</span></span>
      </div>

      <section className="launch-board" aria-labelledby="launch-board-title">
        <div className="section-heading">
          <div><h2 id="launch-board-title">Today’s payment queue</h2><p>Vendor and purpose labels are clearly identified Demo input metadata. Live chain rows expose only ciphertext handles, timestamps and coarse outcomes.</p></div>
          <button className="btn ghost" onClick={refresh}>Refresh chain state</button>
        </div>
        <div className="launch-rows">
          {storyRequests.map(({ scenario, request }) => (
            <button className="launch-row" key={scenario.key} onClick={() => goTab('Delegate')}>
              <span className="launch-time">{requestTime(request)}</span>
              <span className="object-avatar">{scenario.vendor[0]}</span>
              <span className="launch-copy"><b>{scenario.vendor}</b><small>Demo metadata · {scenario.purpose}</small></span>
              <span className="launch-amount">{request ? 'Encrypted amount' : 'Awaiting submission'}</span>
              <span className="launch-state">{request ? <RequestPill state={request.state} decisionReady={request.decisionReady} /> : <span className="status-badge">{outcomeLabel()}</span>}</span>
            </button>
          ))}
        </div>
      </section>

      <div className="overview-split">
        <section className="surface-section">
          <div className="section-heading"><div><h2>Live operations</h2><p>Derived from current on-chain objects, not demo counters.</p></div></div>
          <dl className="status-summary">
            <div><dt>Active mandates</dt><dd>{activeMandates}</dd></div>
            <div><dt>Requests in flight</dt><dd>{awaiting}</dd></div>
            <div><dt>Terminal requests</dt><dd>{terminal}</dd></div>
          </dl>
          <div className="activity-list">
            {recent.map((request) => (
              <div className="activity-row" key={String(request.id)}>
                <span className="activity-marker" />
                <div><b>Request #{String(request.id)}</b><small>{short(request.delegate)} → {short(request.recipient)}</small></div>
                <RequestPill state={request.state} decisionReady={request.decisionReady} />
                <time>{ago(request.createdAt)}</time>
              </div>
            ))}
            {!recent.length && <div className="empty-state"><b>No requests yet</b><span>Open Payment Inbox to start the live flow.</span></div>}
          </div>
        </section>

        <section className="surface-section">
          <div className="section-heading"><div><h2>System readiness</h2><p>Health checks support the flow; they do not replace testing the real CTA.</p></div></div>
          <div className="system-list">
            {([
              ['Sepolia RPC', readiness.rpc],
              ['Proof keeper', readiness.keeper],
              ['Nox gateway', readiness.gateway],
              ['Safe threshold', readiness.safeThreshold],
              ['Safe module', readiness.module],
            ] as const).map(([label, check]) => (
              <div key={label}>
                <span><strong>{label}</strong><small>{check.detail}</small></span>
                <b className={check.ok === null ? 'muted' : check.ok ? 'ok-text' : 'warn-text'}>
                  {check.ok === null ? 'Pending' : check.ok ? 'Ready' : 'Degraded'}
                </b>
              </div>
            ))}
          </div>
          <div className="privacy-compact">
            <div><b>Encrypted</b><span>Amounts · limits · budget · reserve · blocked reason</span></div>
            <div><b>Public</b><span>Actors · timestamps · three-state outcome · transaction hashes</span></div>
          </div>
        </section>
      </div>
    </>
  );
}
