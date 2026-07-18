import { useState } from 'react';
import { ADDR, ROLES, isAddress, moduleAbi, parseUsdc } from '../config';
import { handleClientFor, makeWalletClient, publicClient } from '../nox';
import { useApp } from '../App';
import { Decrypt, MandatePill } from '../ui';

export function AdminView() {
  const { account, mandates, requests, run, busy, paused } = useApp();
  const [delegate, setDelegate] = useState<string>(ROLES.delegate);
  const [recipients, setRecipients] = useState<string>(ROLES.deployer);
  const [autoLimit, setAutoLimit] = useState('40');
  const [budget, setBudget] = useState('100');
  const [floor, setFloor] = useState('500');
  const [days, setDays] = useState('30');
  const [auditor, setAuditor] = useState<string>(ROLES.auditor);
  const [auditMandate, setAuditMandate] = useState('1');
  const [auditReqs, setAuditReqs] = useState('');

  const isAdmin = account?.toLowerCase() === ROLES.financeAdmin.toLowerCase();
  if (!account) return <div className="notice">Connect the finance-admin wallet to manage policies.</div>;
  if (!isAdmin)
    return <div className="notice">The connected account is not the finance admin (<span className="mono">{ROLES.financeAdmin}</span>). Views are role-gated by on-chain ACLs — decryption would be refused anyway.</div>;

  const wallet = () => makeWalletClient(account);

  const propose = () =>
    run('Propose encrypted mandate', async () => {
      if (!isAddress(delegate)) throw new Error('delegate is not a valid address');
      const recips = recipients.split(',').map((s) => s.trim()).filter(Boolean);
      if (!recips.length) throw new Error('add at least one recipient');
      if (recips.some((r) => !isAddress(r))) throw new Error('a recipient is not a valid address');
      if (new Set(recips.map((r) => r.toLowerCase())).size !== recips.length) throw new Error('duplicate recipient');
      const d = Number(days);
      if (!Number.isInteger(d) || d <= 0 || d > 3650) throw new Error('validity days must be 1–3650');
      const client = await handleClientFor(account);
      const [l, b, f] = await Promise.all([
        client.encryptInput(parseUsdc(autoLimit), 'uint256', ADDR.VeilGuardModule),
        client.encryptInput(parseUsdc(budget), 'uint256', ADDR.VeilGuardModule),
        client.encryptInput(parseUsdc(floor), 'uint256', ADDR.VeilGuardModule),
      ]);
      const now = BigInt(Math.floor(Date.now() / 1000));
      const w = wallet();
      const hash = await w.writeContract({
        address: ADDR.VeilGuardModule, abi: moduleAbi, functionName: 'proposeMandate',
        args: [
          delegate as `0x${string}`, 0n, now + BigInt(d) * 86_400n,
          recips as `0x${string}`[],
          l.handle, l.handleProof, b.handle, b.handleProof, f.handle, f.handleProof,
        ],
        chain: w.chain, account: w.account!,
      });
      await publicClient.waitForTransactionReceipt({ hash });
    });

  const pause = () =>
    run('Pause all mandates', async () => {
      const w = wallet();
      const hash = await w.writeContract({
        address: ADDR.VeilGuardModule, abi: moduleAbi, functionName: 'pauseAll', args: [],
        chain: w.chain, account: w.account!,
      });
      await publicClient.waitForTransactionReceipt({ hash });
    });

  const createPacket = () =>
    run('Create audit packet', async () => {
      const ids = auditReqs.split(',').map((s) => s.trim()).filter(Boolean).map(BigInt);
      const w = wallet();
      const hash = await w.writeContract({
        address: ADDR.VeilGuardModule, abi: moduleAbi, functionName: 'createAuditPacket',
        args: [auditor as `0x${string}`, BigInt(auditMandate), ids],
        chain: w.chain, account: w.account!,
      });
      await publicClient.waitForTransactionReceipt({ hash });
    });

  return (
    <>
      <div className="notice">
        You propose <b>encrypted drafts</b> and can tighten (pause). Activating a policy, resuming, and
        approving escalations all require the <b>Safe multisig</b> — the admin alone can never widen
        spending powers.
      </div>

      <div className="grid2">
        <div className="card">
          <h3>Propose a confidential mandate</h3>
          <label>Delegate address</label>
          <input value={delegate} onChange={(e) => setDelegate(e.target.value as any)} className="mono" />
          <label>Allowed recipients (comma-separated)</label>
          <input value={recipients} onChange={(e) => setRecipients(e.target.value)} className="mono" />
          <div className="form-grid">
            <div><label>Auto-limit (cUSDC)</label><input type="number" value={autoLimit} onChange={(e) => setAutoLimit(e.target.value)} /></div>
            <div><label>Total budget</label><input type="number" value={budget} onChange={(e) => setBudget(e.target.value)} /></div>
            <div><label>Reserve floor</label><input type="number" value={floor} onChange={(e) => setFloor(e.target.value)} /></div>
            <div><label>Valid (days)</label><input type="number" value={days} onChange={(e) => setDays(e.target.value)} /></div>
          </div>
          <div style={{ marginTop: 14 }} className="row">
            <button className="btn primary" disabled={!!busy} onClick={propose}>🔒 Encrypt &amp; propose</button>
            <span className="muted" style={{ fontSize: 12.5 }}>then the Safe activates it (Signer tab)</span>
          </div>
        </div>

        <div className="card">
          <h3>Emergency &amp; audit</h3>
          <div className="row" style={{ marginBottom: 14 }}>
            <button className="btn" disabled={!!busy || paused} onClick={pause}>⏸ Pause all mandates</button>
            {paused && <span className="pill bad">PAUSED — only the Safe can resume</span>}
          </div>
          <label>Auditor address</label>
          <input value={auditor} onChange={(e) => setAuditor(e.target.value as any)} className="mono" />
          <div className="form-grid">
            <div><label>Mandate ID</label><input value={auditMandate} onChange={(e) => setAuditMandate(e.target.value)} /></div>
            <div><label>Request IDs (comma, ≤8)</label><input value={auditReqs} onChange={(e) => setAuditReqs(e.target.value)} placeholder="1,2,3" /></div>
          </div>
          <div style={{ marginTop: 14 }}>
            <button className="btn" disabled={!!busy} onClick={createPacket}>📦 Create immutable snapshot packet</button>
          </div>
        </div>
      </div>

      <div className="card">
        <h3>Policies <small>only you (viewer) can decrypt the numbers</small></h3>
        <div className="tbl"><table>
          <thead><tr><th>ID</th><th>Delegate</th><th>Status</th><th>Auto-limit</th><th>Budget left</th><th>Reserve floor</th></tr></thead>
          <tbody>
            {mandates.map((m) => (
              <tr key={String(m.id)}>
                <td className="mono">#{String(m.id)}</td>
                <td className="mono">{m.delegate.slice(0, 10)}…</td>
                <td><MandatePill state={m.state} /></td>
                <td><Decrypt handle={m.autoLimit} /></td>
                <td><Decrypt handle={m.budgetLeft} /></td>
                <td><Decrypt handle={m.reserveFloor} /></td>
              </tr>
            ))}
          </tbody>
        </table></div>
        <p className="muted" style={{ marginTop: 8, fontSize: 12.5 }}>
          {requests.length} request(s) so far — request amounts are also decryptable for you in the Dashboard rows via the Delegate/Signer views.
        </p>
      </div>
    </>
  );
}
