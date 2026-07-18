import { useMemo } from 'react';
import { ADDR, moduleAbi, scan, short } from '../config';
import { handleClientFor, makeWalletClient, publicClient } from '../nox';
import { useApp } from '../App';
import { MandatePill, RequestPill } from '../ui';
import { EvidenceMatrix } from './Evidence';
import { Donut } from '../Donut';

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

  const escalatedCount = stats.escalated + requests.filter((r) => r.state === 5).length;
  return (
    <>
      <div className="dash-head">
        <div>
          <h2 className="dash-title">Dashboard overview</h2>
          <p className="dash-sub">Live public state of the confidential treasury · Ethereum Sepolia</p>
        </div>
        <a className="pill dim" href={`https://sepolia.etherscan.io/address/${ADDR.Safe}`} target="_blank" rel="noopener">Safe {short(ADDR.Safe)} ↗</a>
      </div>

      <div className="tiles">
        <div className="tile"><div className="tile-label">Total mandates</div><div className="tile-val">{stats.mandates}</div><div className="tile-sub">{stats.active} active</div></div>
        <div className="tile"><div className="tile-label">Total requests</div><div className="tile-val">{stats.total}</div><div className="tile-sub">{stats.pending} in flight</div></div>
        <div className="tile"><div className="tile-label">Executed</div><div className="tile-val ok">{stats.executed}</div><div className="tile-sub">confidential payouts</div></div>
        <div className="tile hero-tile"><div className="tile-label">Treasury balance</div><div className="tile-val enc-big">🔒 Encrypted</div><div className="tile-sub">decryptable by role only</div></div>
      </div>

      <div className="grid2">
        <div className="card">
          <h3>Request outcomes <small>public three-state breakdown</small></h3>
          <Donut total={stats.total}
            segments={[
              { label: 'Executed', value: stats.executed, color: '#3ecf8e' },
              { label: 'Escalated / approved', value: escalatedCount, color: '#f5b83d' },
              { label: 'Blocked', value: stats.blocked, color: '#ff6b6b' },
              { label: 'In flight', value: stats.pending, color: '#7c5cff' },
            ]} />
        </div>
        <div className="card">
          <h3>What stays private <small>vs. what the chain sees</small></h3>
          <div className="privacy-split">
            <div><div className="ps-h enc">🔒 Encrypted</div><ul><li>Payment amounts</li><li>Auto-limit, budget, reserve floor</li><li>Blocked reasons (public gets none)</li></ul></div>
            <div><div className="ps-h pub">👁 Public</div><ul><li>Who requested &amp; when</li><li>The three-state outcome</li><li>Transaction hashes</li></ul></div>
          </div>
        </div>
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
