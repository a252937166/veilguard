import { useMemo, useState } from 'react';
import { ADDR, ROLES, fmt, isAddress, moduleAbi, parseUsdc, short } from '../config';
import { handleClientFor, makeWalletClient, publicClient } from '../nox';
import { useApp } from '../App';
import { Decrypt, MandatePill, NoRole } from '../ui';

const WIZ = ['Policy details', 'Recipients', 'Review & encrypt'];

export function AdminView() {
  const { account, mandates, requests, run, busy, paused, toast } = useApp();
  const [step, setStep] = useState(0);
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
  const recips = useMemo(() => recipients.split(',').map((s) => s.trim()).filter(Boolean), [recipients]);

  if (!isAdmin)
    return <NoRole title="Finance Admin — restricted"
      body="The finance admin proposes encrypted policies and can pause the module. It is deliberately NOT a public demo role (it can create disclosure packets and pause spending), so it isn't offered as a one-click account. Watch what the admin did in the Dashboard evidence table, or try the Delegate / Auditor roles to experience the confidential flow." />;

  const wallet = () => makeWalletClient(account!);

  const step1Valid = isAddress(delegate) && [autoLimit, budget, floor].every((v) => /^\d+(\.\d{1,6})?$/.test(v) && Number(v) > 0) && Number(days) > 0 && Number(days) <= 3650;
  const step2Valid = recips.length > 0 && recips.every(isAddress) && new Set(recips.map((r) => r.toLowerCase())).size === recips.length;

  const propose = () =>
    run('Propose encrypted mandate', async () => {
      const client = await handleClientFor(account!);
      const [l, b, f] = await Promise.all([
        client.encryptInput(parseUsdc(autoLimit), 'uint256', ADDR.VeilGuardModule),
        client.encryptInput(parseUsdc(budget), 'uint256', ADDR.VeilGuardModule),
        client.encryptInput(parseUsdc(floor), 'uint256', ADDR.VeilGuardModule),
      ]);
      const now = BigInt(Math.floor(Date.now() / 1000));
      const w = wallet();
      const hash = await w.writeContract({
        address: ADDR.VeilGuardModule, abi: moduleAbi, functionName: 'proposeMandate',
        args: [delegate as `0x${string}`, 0n, now + BigInt(Number(days)) * 86_400n,
          recips as `0x${string}`[], l.handle, l.handleProof, b.handle, b.handleProof, f.handle, f.handleProof],
        chain: w.chain, account: w.account!,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      toast('✓ Encrypted mandate proposed. It stays a Draft until the Safe 2-of-2 activates it.');
      setStep(0);
    });

  const pause = () =>
    run('Pause all mandates', async () => {
      const w = wallet();
      const hash = await w.writeContract({ address: ADDR.VeilGuardModule, abi: moduleAbi, functionName: 'pauseAll', args: [], chain: w.chain, account: w.account! });
      await publicClient.waitForTransactionReceipt({ hash });
    });

  const createPacket = () =>
    run('Create audit packet', async () => {
      const ids = auditReqs.split(',').map((s) => s.trim()).filter(Boolean).map(BigInt);
      const w = wallet();
      const hash = await w.writeContract({ address: ADDR.VeilGuardModule, abi: moduleAbi, functionName: 'createAuditPacket', args: [auditor as `0x${string}`, BigInt(auditMandate), ids], chain: w.chain, account: w.account! });
      await publicClient.waitForTransactionReceipt({ hash });
      toast('✓ Selective-disclosure packet created for the auditor.');
    });

  return (
    <>
      <div className="notice">
        You propose <b>encrypted drafts</b> and can tighten (pause). Activating a policy, resuming and
        approving escalations all require the <b>Safe 2-of-2</b> — the admin alone can never widen spending powers.
      </div>

      <div className="card">
        <h3>Propose a new mandate</h3>
        <div className="wiz">
          {WIZ.map((w, i) => (
            <button key={w} className={`wiz-step ${i === step ? 'active' : ''} ${i < step ? 'done' : ''}`}
              onClick={() => i < step && setStep(i)}>
              <span className="wiz-n">{i < step ? '✓' : i + 1}</span>{w}
            </button>
          ))}
        </div>

        {step === 0 && (
          <div className="wiz-body">
            <label>Delegate address</label>
            <input value={delegate} onChange={(e) => setDelegate(e.target.value)} className="mono" />
            {!isAddress(delegate) && delegate && <p className="field-err">not a valid address</p>}
            <div className="form-grid">
              <div><label>Auto-limit (cUSDC)</label><input type="number" value={autoLimit} onChange={(e) => setAutoLimit(e.target.value)} /><span className="field-hint">≤ this auto-executes</span></div>
              <div><label>Total budget</label><input type="number" value={budget} onChange={(e) => setBudget(e.target.value)} /><span className="field-hint">delegated spend cap</span></div>
              <div><label>Reserve floor</label><input type="number" value={floor} onChange={(e) => setFloor(e.target.value)} /><span className="field-hint">treasury never drops below</span></div>
              <div><label>Valid (days)</label><input type="number" value={days} onChange={(e) => setDays(e.target.value)} /></div>
            </div>
            <div className="wiz-nav">
              <span className="muted" style={{ fontSize: 12.5 }}>🔒 All three amounts are encrypted in your browser before they leave.</span>
              <button className="btn primary" disabled={!step1Valid} onClick={() => setStep(1)}>Next: recipients →</button>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="wiz-body">
            <label>Allowed recipients — comma-separated addresses the delegate may pay</label>
            <textarea value={recipients} onChange={(e) => setRecipients(e.target.value)} className="mono" rows={3} style={{ width: '100%', resize: 'vertical' }} />
            <div className="recip-chips">
              {recips.map((r) => <span key={r} className={`pill ${isAddress(r) ? 'dim' : 'bad'} mono`}>{isAddress(r) ? short(r) : `invalid: ${r.slice(0, 12)}…`}</span>)}
            </div>
            {!step2Valid && recips.length > 0 && <p className="field-err">every recipient must be a unique valid address</p>}
            <div className="wiz-nav">
              <button className="btn ghost" onClick={() => setStep(0)}>← Back</button>
              <button className="btn primary" disabled={!step2Valid} onClick={() => setStep(2)}>Next: review →</button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="wiz-body">
            <div className="review">
              <div className="rv-row"><span>Delegate</span><span className="mono">{short(delegate)}</span></div>
              <div className="rv-row"><span>Auto-limit</span><span className="value">{fmt(parseUsdc(Number(autoLimit) ? autoLimit : '0'))} cUSDC 🔒</span></div>
              <div className="rv-row"><span>Total budget</span><span className="value">{fmt(parseUsdc(budget))} cUSDC 🔒</span></div>
              <div className="rv-row"><span>Reserve floor</span><span className="value">{fmt(parseUsdc(floor))} cUSDC 🔒</span></div>
              <div className="rv-row"><span>Valid for</span><span>{days} days</span></div>
              <div className="rv-row"><span>Recipients</span><span className="mono">{recips.map(short).join(', ')}</span></div>
            </div>
            <p className="muted" style={{ fontSize: 12.5, margin: '12px 0' }}>
              On submit, the three amounts are encrypted and only their handles go on-chain. The mandate is a
              <b> Draft</b> until the Safe 2-of-2 activates it.
            </p>
            <div className="wiz-nav">
              <button className="btn ghost" onClick={() => setStep(1)}>← Back</button>
              <button className="btn primary" disabled={!!busy} onClick={propose}>🔒 Encrypt &amp; propose</button>
            </div>
          </div>
        )}
      </div>

      <div className="grid2">
        <div className="card">
          <h3>Emergency control</h3>
          <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>The admin can pause instantly, but only the Safe 2-of-2 can resume — a compromised admin can tighten, never loosen.</p>
          <div className="row">
            <button className="btn" disabled={!!busy || paused} onClick={pause}>⏸ Pause all mandates</button>
            {paused && <span className="pill bad">PAUSED — only the Safe can resume</span>}
          </div>
        </div>
        <div className="card">
          <h3>Create disclosure packet <small>selective, immutable</small></h3>
          <label>Auditor address</label>
          <input value={auditor} onChange={(e) => setAuditor(e.target.value)} className="mono" />
          <div className="form-grid">
            <div><label>Mandate ID</label><input value={auditMandate} onChange={(e) => setAuditMandate(e.target.value)} /></div>
            <div><label>Request IDs (comma, ≤8)</label><input value={auditReqs} onChange={(e) => setAuditReqs(e.target.value)} placeholder="1,2,3" /></div>
          </div>
          <div style={{ marginTop: 12 }}>
            <button className="btn" disabled={!!busy || !isAddress(auditor)} onClick={createPacket}>📦 Create snapshot packet</button>
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
                <td className="mono">{short(m.delegate)}</td>
                <td><MandatePill state={m.state} /></td>
                <td><Decrypt handle={m.autoLimit} /></td>
                <td><Decrypt handle={m.budgetLeft} /></td>
                <td><Decrypt handle={m.reserveFloor} /></td>
              </tr>
            ))}
            {!mandates.length && <tr><td colSpan={6} className="muted">No mandates yet.</td></tr>}
          </tbody>
        </table></div>
        <p className="muted" style={{ marginTop: 8, fontSize: 12.5 }}>{requests.length} spend request(s) recorded across all mandates.</p>
      </div>
    </>
  );
}
