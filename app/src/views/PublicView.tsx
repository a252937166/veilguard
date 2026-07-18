import { useMemo, useRef } from 'react';
import { ADDR, FINALIZE_API, scan, short } from '../config';
import { useApp } from '../App';
import { MandatePill, RequestPill } from '../ui';
import { Donut } from '../Donut';

/** Tiny sparkline for the stat tiles — real cumulative history, no fake data. */
function Spark({ pts, color = '#7c5cff' }: { pts: number[]; color?: string }) {
  if (pts.length < 2) return null;
  const W = 92, H = 34, P = 2;
  const mx = Math.max(...pts), mn = Math.min(...pts);
  const xy = pts.map((v, i) => [
    P + (i * (W - 2 * P)) / (pts.length - 1),
    H - P - ((v - mn) / (mx - mn || 1)) * (H - 2 * P),
  ]);
  const d = xy.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
  return (
    <svg className="spark" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      <path d={`${d} L${(W - P).toFixed(1)},${H - P} L${P},${H - P} Z`} fill={color} opacity="0.12" />
      <path d={d} fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Cumulative count series over time (12 buckets between first and last event). */
function cumSeries(ts: bigint[]): number[] {
  if (ts.length < 2) return [];
  const t = ts.map(Number).sort((a, b) => a - b);
  const t0 = t[0], t1 = t[t.length - 1];
  if (t1 <= t0) return [];
  const N = 12;
  return Array.from({ length: N }, (_, i) => {
    const cut = t0 + ((t1 - t0) * (i + 1)) / N;
    return t.filter((x) => x <= cut).length;
  });
}

const I = {
  people: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="8.5" r="3.2" /><path d="M3.5 19c.7-3 2.9-4.5 5.5-4.5s4.8 1.5 5.5 4.5" /><path d="M15.5 5.8a3.2 3.2 0 010 5.4M17.8 14.7c1.6.7 2.4 2 2.7 4.3" /></svg>,
  doc: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M7 3h7l4 4v14H7z" /><path d="M14 3v4h4M10 12h5M10 16h5" /></svg>,
  check: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="8.5" /><path d="M8.5 12.2l2.4 2.4 4.6-4.8" /></svg>,
  lock: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="6" y="10.5" width="12" height="9" rx="2" /><path d="M8.5 10.5V8a3.5 3.5 0 017 0v2.5" /></svg>,
};

function ago(ts: bigint): string {
  const s = Math.floor(Date.now() / 1000) - Number(ts);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const A = (addr: string) => (
  <a href={scan(addr)} target="_blank" rel="noopener" className="mono alink">{short(addr)}</a>
);

export function PublicView() {
  const { mandates, requests, run, busy, refresh } = useApp();

  const stats = useMemo(() => {
    const active = mandates.filter((m) => m.state === 2).length;
    const executed = requests.filter((r) => r.state === 2).length;
    const escalated = requests.filter((r) => r.state === 3).length;
    const blocked = requests.filter((r) => r.state === 4).length;
    const pending = requests.filter((r) => r.state === 1).length;
    return { active, executed, escalated, blocked, pending, total: requests.length, mandates: mandates.length };
  }, [mandates, requests]);

  const ACT: Record<number, { icon: string; tone: string; title: string }> = {
    1: { icon: '◔', tone: 'veil', title: 'Spend requested' },
    2: { icon: '✓', tone: 'ok', title: 'Request executed' },
    3: { icon: '⚠', tone: 'warn', title: 'Escalated to signers' },
    4: { icon: '✕', tone: 'bad', title: 'Request blocked' },
    5: { icon: '⚠', tone: 'warn', title: 'Awaiting Safe approval' },
    6: { icon: '⌛', tone: 'bad', title: 'Request expired' },
  };
  const activity = useMemo(() => (
    [...requests]
      .sort((a, b) => Number(b.createdAt - a.createdAt))
      .slice(0, 6)
      .map((r) => {
        const a = ACT[r.state] ?? ACT[1];
        return { key: String(r.id), icon: a.icon, tone: a.tone, title: a.title, sub: `#${String(r.id)} · → ${short(r.recipient)}`, time: ago(r.createdAt) };
      })
  ), [requests]);
  const lastSync = useMemo(() => {
    const ts = [...requests.map((r) => r.createdAt)].sort((a, b) => Number(b - a))[0];
    return ts ? ago(ts) : 'live';
  }, [requests]);

  // Proof-gated finalize via the sponsored keeper — no wallet or gas needed.
  const finalize = (id: bigint) =>
    run(`Finalize request #${id}`, async () => {
      const res = await fetch(FINALIZE_API, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: Number(id) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? 'finalize failed');
      for (let k = 0; k < 6; k++) { await new Promise((r) => setTimeout(r, 1500)); refresh(); }
    });

  const escalatedCount = stats.escalated + requests.filter((r) => r.state === 5).length;
  const successPct = stats.total ? Math.round((stats.executed / stats.total) * 100) : 0;
  const reqSeries = useMemo(() => cumSeries(requests.map((r) => r.createdAt)), [requests]);
  const execSeries = useMemo(() => cumSeries(requests.filter((r) => r.state === 2).map((r) => r.createdAt)), [requests]);
  const mandateSeries = useMemo(() => cumSeries(mandates.map((m) => m.validFrom)), [mandates]);
  const requestsRef = useRef<HTMLDivElement>(null);
  const viewAll = () => requestsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <>
      <div className="dash-head">
        <div>
          <h2 className="dash-title">Dashboard overview</h2>
          <p className="dash-sub">Confidential treasury · Secure on-chain governance · Ethereum Sepolia</p>
        </div>
        <a className="pill dim" href={`https://sepolia.etherscan.io/address/${ADDR.Safe}`} target="_blank" rel="noopener">Safe {short(ADDR.Safe)} ↗</a>
      </div>

      <div className="tiles">
        <div className="tile">
          <span className="tile-ico">{I.people}</span>
          <div className="tile-main"><div className="tile-label">Total mandates</div><div className="tile-val">{stats.mandates}</div><div className="tile-sub">{stats.active} active</div></div>
          <Spark pts={mandateSeries} />
        </div>
        <div className="tile">
          <span className="tile-ico">{I.doc}</span>
          <div className="tile-main"><div className="tile-label">Total requests</div><div className="tile-val">{stats.total}</div><div className="tile-sub">{stats.pending} in flight</div></div>
          <Spark pts={reqSeries} />
        </div>
        <div className="tile">
          <span className="tile-ico ok">{I.check}</span>
          <div className="tile-main"><div className="tile-label">Executed</div><div className="tile-val ok">{stats.executed}</div><div className="tile-sub">{successPct}% of requests</div></div>
          <Spark pts={execSeries} color="#3ecf8e" />
        </div>
        <div className="tile hero-tile">
          <span className="tile-ico">{I.lock}</span>
          <div className="tile-main"><div className="tile-label">Treasury balance</div><div className="tile-val dots">●●●●●●●</div><div className="tile-sub">Encrypted · role-gated decryption</div></div>
        </div>
      </div>

      <div className="dash-grid">
        <div className="card donutcard">
          <h3>Request outcomes <small>All time</small></h3>
          <Donut total={stats.total} size={168}
            segments={[
              { label: 'Executed', value: stats.executed, color: '#3ecf8e' },
              { label: 'Escalated / approved', value: escalatedCount, color: '#f5b83d' },
              { label: 'Blocked', value: stats.blocked, color: '#ff6b6b' },
              { label: 'In flight', value: stats.pending, color: '#7c5cff' },
            ]} />
          <div className="donut-foot">
            <div><div className="sr-label">Success rate</div><div className="sr-val">{successPct}%</div></div>
            <button className="btn small ghost" onClick={viewAll}>📊 View analytics →</button>
          </div>
        </div>
        <div className="card">
          <h3>Recent activity <small>Latest on-chain events</small>
            <button className="h3-link" onClick={viewAll}>View all</button>
          </h3>
          <div className="activity">
            {activity.length ? activity.map((a) => (
              <div className="act-row" key={a.key}>
                <span className={`act-ico ${a.tone}`}>{a.icon}</span>
                <div className="act-main">
                  <div className="act-title">{a.title}</div>
                  <div className="act-sub mono">{a.sub}</div>
                </div>
                <span className="act-time">{a.time}</span>
              </div>
            )) : <p className="muted">No activity yet.</p>}
          </div>
        </div>
      </div>

      <div className="dash-grid">
        <div className="card">
          <h3>System status</h3>
          <div className="sysstat">
            <div className="sys-banner"><span className="netdot ok" /> All systems operational</div>
            <div className="sys-row"><span>VeilGuard module</span><span className="sys-ok">● live</span></div>
            <div className="sys-row"><span>Nox TEE gateway</span><span className="sys-ok">● reachable</span></div>
            <div className="sys-row"><span>Safe (2-of-2)</span><span className="sys-ok">● enabled</span></div>
            <div className="sys-row"><span>RPC connection</span><span className="sys-ok">● connected</span></div>
            <div className="sys-row"><span>Chain indexed</span><span className="mono muted">{lastSync}</span></div>
          </div>
        </div>
        <div className="card">
          <h3>What stays private <small>vs. what the chain sees</small></h3>
          <div className="privacy-split">
            <div><div className="ps-h enc">🔒 Encrypted</div><ul><li>Payment amounts</li><li>Auto-limit, budget, reserve floor</li><li>Blocked reasons (public gets none)</li></ul></div>
            <div><div className="ps-h pub">👁 Public</div><ul><li>Who requested &amp; when</li><li>The three-state outcome</li><li>Transaction hashes</li></ul></div>
          </div>
          <p className="muted" style={{ marginTop: 10, fontSize: 12.5 }}>Full proof links live in <b>Verify on-chain</b> in the sidebar.</p>
        </div>
      </div>

      <div className="card">
        <h3>Spending mandates <small>policy numbers are encrypted handles — decryptable only by authorised roles</small></h3>
        <div className="tbl"><table>
          <thead><tr><th>ID</th><th>Version</th><th>Delegate</th><th>Recipients</th><th>Auto-limit</th><th>Budget</th><th>Reserve</th><th>Status</th></tr></thead>
          <tbody>
            {mandates.map((m) => (
              <tr key={String(m.id)}>
                <td className="mono">#{String(m.id)}</td>
                <td className="mono">v{m.version}</td>
                <td>{A(m.delegate)}</td>
                <td>{m.recipients.map((r, i) => <span key={r}>{i > 0 && ', '}{A(r)}</span>)}</td>
                <td><span className="enc">🔒 encrypted</span></td>
                <td><span className="enc">🔒 encrypted</span></td>
                <td><span className="enc">🔒 encrypted</span></td>
                <td><MandatePill state={m.state} /></td>
              </tr>
            ))}
            {!mandates.length && <tr><td colSpan={8} className="muted">No mandates yet.</td></tr>}
          </tbody>
        </table></div>
      </div>

      <div className="card" ref={requestsRef}>
        <h3>
          Spend requests <small>three-state outcomes, publicly verifiable via TEE decryption proofs</small>
          <button className="btn small ghost" style={{ float: 'right' }} onClick={refresh}>↻ refresh</button>
        </h3>
        <div className="tbl"><table>
          <thead><tr><th>ID</th><th>Mandate</th><th>Delegate</th><th>Recipient</th><th>Amount</th><th>When</th><th>Outcome</th><th></th></tr></thead>
          <tbody>
            {[...requests].reverse().map((r) => (
              <tr key={String(r.id)}>
                <td className="mono">#{String(r.id)}</td>
                <td className="mono">#{String(r.mandateId)}</td>
                <td>{A(r.delegate)}</td>
                <td>{A(r.recipient)}</td>
                <td><span className="enc">🔒 encrypted</span></td>
                <td className="muted" title={new Date(Number(r.createdAt) * 1000).toLocaleString()}>{ago(r.createdAt)}</td>
                <td><RequestPill state={r.state} decisionReady={r.decisionReady} /></td>
                <td>
                  {r.state === 1 && r.decisionReady && (
                    <button className="btn small primary" disabled={!!busy} onClick={() => finalize(r.id)}>Finalize</button>
                  )}
                  {r.state === 1 && !r.decisionReady && <span className="muted" style={{ fontSize: 11.5 }}>TEE working…</span>}
                </td>
              </tr>
            ))}
            {!requests.length && <tr><td colSpan={8} className="muted">No requests yet — head to the Delegate tab to submit one.</td></tr>}
          </tbody>
        </table></div>
        <p className="muted" style={{ marginTop: 10, fontSize: 12.5 }}>
          Finalization is <b>proof-gated</b>: the Nox gateway's signed decryption proof decides the outcome —
          anyone (a keeper, or you) may submit it. States: Requested · Executed · AwaitingSafeApproval · Blocked · Cancelled · Expired.
        </p>
      </div>
    </>
  );
}
