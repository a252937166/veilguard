import { ADDR, scan, scanTx, short } from '../config';
import { useApp } from '../App';
import { Decrypt } from '../ui';
import ev from '../demo-evidence.json';

/**
 * Escalations require a REAL 2-of-2 Safe multisig: two distinct owner signatures.
 * A single connected owner cannot execute one alone (that is the whole point), so
 * this view is honest about it — an owner can decrypt the escalated amount and
 * see the proven on-chain 2-of-2 flow, rather than offering a button that would
 * revert without the second signature.
 */
export function SignerView() {
  const { account, owners, requests } = useApp();
  const isOwner = owners.some((o) => o.toLowerCase() === account?.toLowerCase());
  const escalated = requests.filter((r) => r.state === 3);

  return (
    <>
      <div className="notice">
        The treasury Safe is <b>2-of-{owners.length || 2}</b>: activating a policy or approving an escalation needs
        <b> two distinct owner signatures</b> — a single owner physically cannot act alone.
        {!account && <> Connect a Safe owner wallet to decrypt escalated amounts; the 2-of-2 proof below is public.</>}
        {account && !isOwner && <> The connected wallet is not an owner{owners.length ? <> (owners: {owners.map(short).join(', ')})</> : null}.</>}
      </div>

      <div className="card">
        <h3>Escalated requests — awaiting 2-of-{owners.length} approval</h3>
        <div className="tbl"><table>
          <thead><tr><th>ID</th><th>Delegate</th><th>Recipient</th><th>Amount (owners only)</th></tr></thead>
          <tbody>
            {escalated.map((r) => (
              <tr key={String(r.id)}>
                <td className="mono">#{String(r.id)}</td>
                <td className="mono">{short(r.delegate)}</td>
                <td className="mono">{short(r.recipient)}</td>
                <td>{isOwner ? <Decrypt handle={r.amount} /> : <span className="muted">owner-gated</span>}</td>
              </tr>
            ))}
            {!escalated.length && <tr><td colSpan={4} className="muted">Nothing awaiting approval right now.</td></tr>}
          </tbody>
        </table></div>
        <p className="muted" style={{ marginTop: 10, fontSize: 12.5 }}>
          Approval is driven by a real Safe transaction with two owner signatures
          (two owners each produce an EIP-712 signature → execute once threshold 2 is met). Because a genuine 2-of-2 needs
          two separate keys, the interactive demo does not custody the owner keys in your browser — instead the
          proven flow is recorded on-chain below.
        </p>
      </div>

      <div className="card">
        <h3>Proof: 2-of-2 governance worked on-chain</h3>
        <div className="tbl"><table>
          <thead><tr><th>Governance action</th><th>Owner A</th><th>Owner B</th><th>Executed (2-of-2)</th></tr></thead>
          <tbody>
            <tr>
              <td>Activate mandate #{ev.mandate.id}</td>
              <td className="pill ok" style={{ display: 'inline-block' }}>signed</td>
              <td><span className="pill ok">signed</span></td>
              <td><a className="mono alink" href={scanTx(ev.mandate.activation.executeTxHash)} target="_blank" rel="noopener">{short(ev.mandate.activation.executeTxHash)} ↗</a></td>
            </tr>
            <tr>
              <td>Approve escalation #{(ev.requests as any).escalated.id}</td>
              <td><span className="pill ok">signed</span></td>
              <td><span className="pill ok">signed</span></td>
              <td><a className="mono alink" href={scanTx((ev.requests as any).escalated.approval.executeTxHash)} target="_blank" rel="noopener">{short((ev.requests as any).escalated.approval.executeTxHash)} ↗</a></td>
            </tr>
          </tbody>
        </table></div>
        <p className="muted" style={{ marginTop: 10, fontSize: 12.5 }}>
          Safe: <a className="mono alink" href={scan(ADDR.Safe)} target="_blank" rel="noopener">{short(ADDR.Safe)}</a> ·
          threshold {ev.threshold} · each action carries two confirmations. Verify on Etherscan or in the
          on Etherscan (two confirmations on each governance transaction). Note: signatures here are produced by the demo automation, not collected from separate humans via the Safe Transaction Service.
        </p>
      </div>
    </>
  );
}
