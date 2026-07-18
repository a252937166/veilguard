import { useState } from 'react';
import { ADDR, scan, scanTx, short } from '../config';
import { makeWalletClient } from '../nox';
import { governance2of2, type GovFn } from '../safe-browser';
import { useApp } from '../App';
import { Decrypt } from '../ui';
import ev from '../demo-evidence.json';

function ago(ts: bigint): string {
  const s = Math.floor(Date.now() / 1000) - Number(ts);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

export function SignerView() {
  const { account, owners, mandates, requests, paused, run, busy, refresh, toast } = useApp();
  const isOwner = owners.some((o) => o.toLowerCase() === account?.toLowerCase());
  const [step, setStep] = useState<string | null>(null);

  const escalated = requests.filter((r) => r.state === 3);
  const drafts = mandates.filter((m) => m.state === 1);

  // real in-browser 2-of-2 (owner A signs here; owner B co-signs governance-only, server-side)
  const gov = (label: string, fn: GovFn, args: unknown[]) =>
    run(label, async () => {
      if (!account) throw new Error('connect a Safe owner');
      try {
        const hash = await governance2of2(makeWalletClient(account), fn, args, setStep);
        toast(`✓ ${label} — executed as a real 2-of-2 (tx ${short(hash)}).`);
        refresh();
      } finally { setStep(null); }
    });

  return (
    <>
      <div className="notice">
        {isOwner ? (
          <>You are a <b>Safe owner</b>. Activation and escalation approval each need <b>two owner
          signatures</b> — you sign as owner A, the governance co-signer provides owner B (bounded
          calls only). Every action is a real on-chain 2-of-2.</>
        ) : (
          <>The treasury committee is a <b>2-of-{owners.length || 2} Safe</b>. Its owner keys are
          deliberately <b>not public</b> — a signer key could reshape treasury policy. In this demo the
          committee reviews escalations <b>server-side</b> and approves them with a real 2-of-2 within
          about a minute; everything it does lands on-chain below, where you can verify it.</>
        )}
      </div>

      {step && <div className="flowbar"><span className="spin" /> <b>{step}</b></div>}

      <div className="card">
        <h3>Pending approvals <small>{isOwner ? 'approve or reject with a 2-of-2' : 'the committee reviews these — watch them resolve live'}</small></h3>
        {escalated.length ? (
          <div className="approve-list">
            {escalated.map((r) => (
              <div className="approve-card" key={String(r.id)}>
                <div className="ac-head">
                  <b>Request #{String(r.id)}</b>
                  <span className="pill warn">AWAITING APPROVAL</span>
                  <span className="ac-age">waiting {ago(r.createdAt)}</span>
                </div>
                <div className="ac-grid">
                  <div><span className="ac-label">Requested by</span><span className="mono">{short(r.delegate)}</span></div>
                  <div><span className="ac-label">Pay to</span><span className="mono">{short(r.recipient)}</span></div>
                  <div><span className="ac-label">Amount</span>{isOwner ? <Decrypt handle={r.amount} /> : <span className="enc">🔒 owner-gated</span>}</div>
                  <div><span className="ac-label">Funds</span><span className="ok-text">reserved in escrow</span></div>
                </div>
                <div className="ac-why muted">Why: above the mandate's confidential auto-limit — policy requires committee sign-off.</div>
                <div className="row" style={{ marginTop: 10 }}>
                  {isOwner ? (
                    <>
                      <button className="btn small" disabled={!!busy} onClick={() => gov(`Reject escalation #${r.id}`, 'cancelEscalated', [r.id])}>✕ Reject</button>
                      <button className="btn small primary" disabled={!!busy} onClick={() => gov(`Approve escalation #${r.id}`, 'executeEscalated', [r.id])}>✓ Approve payment (2-of-2)</button>
                    </>
                  ) : (
                    <span className="muted" style={{ fontSize: 12.5 }}><span className="spin" /> committee review in progress — approves automatically in ≤1 min</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">Nothing awaiting approval. Submit a payment above the auto-limit as the Delegate (try 60) to create one.</p>
        )}
      </div>

      {isOwner && (
        <div className="grid2">
          <div className="card">
            <h3>Draft policies — activate (2-of-2)</h3>
            <div className="tbl"><table>
              <thead><tr><th>ID</th><th>Delegate</th><th>Auto-limit</th><th></th></tr></thead>
              <tbody>
                {drafts.map((m) => (
                  <tr key={String(m.id)}>
                    <td className="mono">#{String(m.id)}</td>
                    <td className="mono">{short(m.delegate)}</td>
                    <td><Decrypt handle={m.autoLimit} /></td>
                    <td><button className="btn small primary" disabled={!!busy} onClick={() => gov(`Activate mandate #${m.id}`, 'activateMandate', [m.id])}>✓ Activate 2-of-2</button></td>
                  </tr>
                ))}
                {!drafts.length && <tr><td colSpan={4} className="muted">No drafts awaiting activation.</td></tr>}
              </tbody>
            </table></div>
          </div>

          <div className="card">
            <h3>Safe controls</h3>
            <div className="row">
              {paused
                ? <button className="btn primary" disabled={!!busy} onClick={() => gov('Resume all mandates', 'unpauseAll', [])}>▶ Resume (2-of-2)</button>
                : <span className="muted" style={{ fontSize: 13 }}>System active. If the admin pauses, resume it here with a 2-of-2.</span>}
            </div>
            <p className="muted" style={{ marginTop: 12, fontSize: 12.5 }}>
              Owners: {owners.map(short).join(' · ')} · threshold {ev.threshold}. Owner B co-signs only
              activate / approve / reject / retire / resume — never a raw transfer.
            </p>
          </div>
        </div>
      )}

      <div className="card">
        <h3>Committee actions on-chain <small>every approval is a verifiable 2-of-2 execTransaction</small></h3>
        <div className="tbl"><table>
          <thead><tr><th>Governance action</th><th>Executed (2-of-2)</th></tr></thead>
          <tbody>
            <tr><td>Activate mandate #{ev.mandate.id}</td><td><a className="mono alink" href={scanTx(ev.mandate.activation.executeTxHash)} target="_blank" rel="noopener">{short(ev.mandate.activation.executeTxHash)} ↗</a></td></tr>
            <tr><td>Approve escalation #{(ev.requests as any).escalated.id}</td><td><a className="mono alink" href={scanTx((ev.requests as any).escalated.approval.executeTxHash)} target="_blank" rel="noopener">{short((ev.requests as any).escalated.approval.executeTxHash)} ↗</a></td></tr>
          </tbody>
        </table></div>
        <p className="muted" style={{ marginTop: 10, fontSize: 12.5 }}>
          Safe <a className="mono alink" href={scan(ADDR.Safe)} target="_blank" rel="noopener">{short(ADDR.Safe)}</a> · each carries two confirmations — inspect them on-chain.
        </p>
      </div>
    </>
  );
}
