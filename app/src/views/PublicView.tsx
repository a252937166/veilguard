import { useMemo } from 'react';
import { ADDR, moduleAbi, scan, short } from '../config';
import { handleClientFor, makeWalletClient, publicClient } from '../nox';
import { useApp } from '../App';
import { MandatePill, RequestPill } from '../ui';
import { EvidenceMatrix } from './Evidence';

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
  const { mandates, requests, account, run, busy, refresh } = useApp();

  const stats = useMemo(() => {
    const active = mandates.filter((m) => m.state === 2).length;
    const executed = requests.filter((r) => r.state === 2).length;
    const escalated = requests.filter((r) => r.state === 3).length;
    const blocked = requests.filter((r) => r.state === 4).length;
    const pending = requests.filter((r) => r.state === 1).length;
    return { active, executed, escalated, blocked, pending, total: requests.length, mandates: mandates.length };
  }, [mandates, requests]);

  const finalize = (id: bigint, decisionHandle: `0x${string}`) =>
    run(`Finalize request #${id}`, async () => {
      if (!account) throw new Error('connect a wallet first');
      const client = await handleClientFor(account);
      const { decryptionProof } = await client.publicDecrypt(decisionHandle as any);
      const wallet = makeWalletClient(account);
      const hash = await wallet.writeContract({
        address: ADDR.VeilGuardModule, abi: moduleAbi, functionName: 'finalize',
        args: [id, decryptionProof], chain: wallet.chain, account: wallet.account!,
      });
      await publicClient.waitForTransactionReceipt({ hash });
    });

  return (
    <>
      <div className="stats">
        <div className="stat hero-stat">
          <span className="stat-icon">🔒</span>
          <div>
            <div className="stat-val">Confidential</div>
            <div className="stat-label">Treasury balance — {A(ADDR.Safe)}</div>
          </div>
        </div>
        <div className="stat"><div className="stat-val">{stats.active}</div><div className="stat-label">active mandate{stats.active !== 1 ? 's' : ''}</div></div>
        <div className="stat"><div className="stat-val">{stats.total}</div><div className="stat-label">spend requests</div></div>
        <div className="stat ok"><div className="stat-val">{stats.executed}</div><div className="stat-label">executed</div></div>
        <div className="stat warn"><div className="stat-val">{stats.escalated + requests.filter((r)=>r.state===5).length}</div><div className="stat-label">escalated</div></div>
        <div className="stat bad"><div className="stat-val">{stats.blocked}</div><div className="stat-label">blocked</div></div>
      </div>

      <div className="notice">
        This is the <b>public view</b> — everything a chain observer can learn: who requested, when, and the
        coarse outcome. <b>Never</b> amounts, limits, budgets or reserve levels. Those live on-chain only as
        encrypted handles and are decrypted per-role through the Nox gateway.
      </div>

      <EvidenceMatrix />

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

      <div className="card">
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
                    <button className="btn small primary" disabled={!!busy || !account} onClick={() => finalize(r.id, r.decision)}>Finalize</button>
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
