import { useState } from 'react';
import { ADDR, moduleAbi, scan, scanTx, short } from '../config';
import { makeWalletClient, publicClient } from '../nox';
import { governance2of2, type GovFn } from '../safe-browser';
import { useApp } from '../App';
import { Decrypt } from '../ui';
import ev from '../demo-evidence.json';

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
        The treasury Safe is <b>2-of-{owners.length || 2}</b>. Activation and escalation approval each need
        <b> two owner signatures</b>. In this demo you sign as <b>owner A</b> and a server-side co-signer
        provides <b>owner B</b> — but only for bounded governance calls, so owner A alone can never drain or
        brick the Safe. Every action below is a real on-chain <span className="mono">execTransaction</span>.
        {!isOwner && !account && <> Use <b>⚡ Try a role → Signer</b> to operate the demo committee.</>}
      </div>

      {step && <div className="flowbar"><span className="spin" /> <b>{step}</b></div>}

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
        <h3>Escalated requests — approve or reject (2-of-2)</h3>
        <div className="tbl"><table>
          <thead><tr><th>ID</th><th>Delegate</th><th>Recipient</th><th>Amount</th><th></th></tr></thead>
          <tbody>
            {escalated.map((r) => (
              <tr key={String(r.id)}>
                <td className="mono">#{String(r.id)}</td>
                <td className="mono">{short(r.delegate)}</td>
                <td className="mono">{short(r.recipient)}</td>
                <td>{isOwner ? <Decrypt handle={r.amount} /> : <span className="muted">owner-gated</span>}</td>
                <td className="row">
                  {isOwner ? (
                    <>
                      <button className="btn small primary" disabled={!!busy} onClick={() => gov(`Approve escalation #${r.id}`, 'executeEscalated', [r.id])}>✓ Approve 2-of-2</button>
                      <button className="btn small" disabled={!!busy} onClick={() => gov(`Reject escalation #${r.id}`, 'cancelEscalated', [r.id])}>✕ Reject</button>
                    </>
                  ) : <span className="muted" style={{ fontSize: 12 }}>connect the Signer committee to act</span>}
                </td>
              </tr>
            ))}
            {!escalated.length && <tr><td colSpan={5} className="muted">Nothing awaiting approval. Submit a large payment as the Delegate to create one.</td></tr>}
          </tbody>
        </table></div>
      </div>

      <div className="card">
        <h3>Proof: 2-of-2 governance on-chain <small>frozen evidence</small></h3>
        <div className="tbl"><table>
          <thead><tr><th>Governance action</th><th>Executed (2-of-2)</th></tr></thead>
          <tbody>
            <tr><td>Activate mandate #{ev.mandate.id}</td><td><a className="mono alink" href={scanTx(ev.mandate.activation.executeTxHash)} target="_blank" rel="noopener">{short(ev.mandate.activation.executeTxHash)} ↗</a></td></tr>
            <tr><td>Approve escalation #{(ev.requests as any).escalated.id}</td><td><a className="mono alink" href={scanTx((ev.requests as any).escalated.approval.executeTxHash)} target="_blank" rel="noopener">{short((ev.requests as any).escalated.approval.executeTxHash)} ↗</a></td></tr>
          </tbody>
        </table></div>
        <p className="muted" style={{ marginTop: 10, fontSize: 12.5 }}>
          Safe <a className="mono alink" href={scan(ADDR.Safe)} target="_blank" rel="noopener">{short(ADDR.Safe)}</a> · each carries two confirmations.
        </p>
      </div>
    </>
  );
}
