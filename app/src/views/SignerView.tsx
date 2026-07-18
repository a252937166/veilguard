import { encodeFunctionData, encodePacked, padHex } from 'viem';
import { ADDR, moduleAbi, safeAbi, short } from '../config';
import { makeWalletClient, publicClient } from '../nox';
import { useApp } from '../App';
import { Decrypt, MandatePill, RequestPill } from '../ui';

export function SignerView() {
  const { account, owners, mandates, requests, run, busy, paused } = useApp();
  const isOwner = owners.some((o) => o.toLowerCase() === account?.toLowerCase());

  if (!account) return <div className="notice">Connect a Safe owner wallet to review escalations.</div>;
  if (!isOwner)
    return <div className="notice">The connected account is not a Safe owner. Owners: {owners.map(short).join(', ')}</div>;

  /** Execute a module call *through the Safe* with the pre-validated owner signature. */
  const safeExec = (label: string, fn: string, args: unknown[]) =>
    run(label, async () => {
      const w = makeWalletClient(account);
      const sig = encodePacked(
        ['bytes32', 'bytes32', 'uint8'],
        [padHex(account, { size: 32 }), padHex('0x00', { size: 32 }), 1],
      );
      const hash = await w.writeContract({
        address: ADDR.Safe, abi: safeAbi, functionName: 'execTransaction',
        args: [ADDR.VeilGuardModule, 0n,
          encodeFunctionData({ abi: moduleAbi, functionName: fn, args }),
          0, 0n, 0n, 0n,
          '0x0000000000000000000000000000000000000000',
          '0x0000000000000000000000000000000000000000', sig],
        chain: w.chain, account: w.account!,
      });
      await publicClient.waitForTransactionReceipt({ hash });
    });

  const escalated = requests.filter((r) => r.state === 3);
  const drafts = mandates.filter((m) => m.state === 1);

  return (
    <>
      <div className="notice">
        You act <b>as the Safe</b>: every action below is a real Safe transaction
        (<span className="mono">execTransaction</span> with an owner signature). As a signer you may
        decrypt escalated amounts — the public still sees nothing.
      </div>

      <div className="card">
        <h3>Escalated requests — approval required</h3>
        <div className="tbl"><table>
          <thead><tr><th>ID</th><th>Delegate</th><th>Recipient</th><th>Amount (signers only)</th><th></th></tr></thead>
          <tbody>
            {escalated.map((r) => (
              <tr key={String(r.id)}>
                <td className="mono">#{String(r.id)}</td>
                <td className="mono">{short(r.delegate)}</td>
                <td className="mono">{short(r.recipient)}</td>
                <td><Decrypt handle={r.amount} /></td>
                <td className="row">
                  <button className="btn small primary" disabled={!!busy}
                    onClick={() => safeExec(`Execute escalated #${r.id}`, 'executeEscalated', [r.id])}>
                    ✓ Approve &amp; execute
                  </button>
                  <button className="btn small" disabled={!!busy}
                    onClick={() => safeExec(`Cancel escalated #${r.id}`, 'cancelEscalated', [r.id])}>
                    ✕ Reject (refund escrow)
                  </button>
                </td>
              </tr>
            ))}
            {!escalated.length && <tr><td colSpan={5} className="muted">Nothing awaiting approval.</td></tr>}
          </tbody>
        </table></div>
      </div>

      <div className="grid2">
        <div className="card">
          <h3>Draft policies awaiting activation</h3>
          <div className="tbl"><table>
            <thead><tr><th>ID</th><th>Delegate</th><th>Status</th><th>Auto-limit</th><th></th></tr></thead>
            <tbody>
              {drafts.map((m) => (
                <tr key={String(m.id)}>
                  <td className="mono">#{String(m.id)}</td>
                  <td className="mono">{short(m.delegate)}</td>
                  <td><MandatePill state={m.state} /></td>
                  <td><Decrypt handle={m.autoLimit} /></td>
                  <td>
                    <button className="btn small primary" disabled={!!busy}
                      onClick={() => {
                        const prev = mandates.find(
                          (x) => x.state === 2 && x.delegate.toLowerCase() === m.delegate.toLowerCase(),
                        );
                        safeExec(`Activate mandate #${m.id}`, 'activateMandate', [m.id, prev?.id ?? 0n]);
                      }}>
                      ✓ Activate (Safe)
                    </button>
                  </td>
                </tr>
              ))}
              {!drafts.length && <tr><td colSpan={5} className="muted">No drafts.</td></tr>}
            </tbody>
          </table></div>
        </div>

        <div className="card">
          <h3>Safe controls</h3>
          <div className="row">
            {paused
              ? <button className="btn primary" disabled={!!busy} onClick={() => safeExec('Resume (unpause)', 'unpauseAll', [])}>▶ Resume all mandates</button>
              : <span className="muted">System active. If the admin pauses, only the Safe can resume here.</span>}
          </div>
          <p className="muted" style={{ marginTop: 12, fontSize: 12.5 }}>
            Safe owners: {owners.map(short).join(' · ')} (threshold 1 on this testnet deployment —
            raise it in the Safe for production-style multi-party approval).
          </p>
        </div>
      </div>
    </>
  );
}
