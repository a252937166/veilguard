import { useMemo, useState } from 'react';
import { ADDR, ROLES, fmt, isAddress, moduleAbi, parseUsdc, short } from '../config';
import { handleClientFor, publicClient } from '../nox';
import { walletWrite } from '../walletTx';
import { useApp } from '../App';
import { Decrypt, MandatePill, NoRole, RequestPill } from '../ui';

const WIZ = ['Policy details', 'Recipients', 'Review & encrypt'];

/** Tiny persistent address book so the admin works with names, not raw hex. */
const loadBook = (): Record<string, string> => {
  try { return JSON.parse(localStorage.getItem('vg_addrbook') ?? '{}'); } catch { return {}; }
};
const saveBook = (b: Record<string, string>) => { try { localStorage.setItem('vg_addrbook', JSON.stringify(b)); } catch { /* ignore */ } };

export function AdminView() {
  const { account, mandates, requests, run, busy, paused, toast } = useApp();
  const [step, setStep] = useState(0);
  const [book, setBook] = useState<Record<string, string>>(loadBook);
  const [delegate, setDelegate] = useState<string>(ROLES.delegate);
  const [delegateName, setDelegateName] = useState('');
  const [recips, setRecips] = useState<string[]>([ROLES.deployer]);
  const [recipInput, setRecipInput] = useState('');
  const [autoLimit, setAutoLimit] = useState('40');
  const [budget, setBudget] = useState('100');
  const [floor, setFloor] = useState('500');
  const [days, setDays] = useState('30');
  const [auditor, setAuditor] = useState<string>(ROLES.auditor);
  const [auditMandate, setAuditMandate] = useState<string>('');
  const [auditSel, setAuditSel] = useState<Set<string>>(new Set());
  const [auditStep, setAuditStep] = useState<0 | 1>(0);

  const isAdmin = account?.toLowerCase() === ROLES.financeAdmin.toLowerCase();

  // name → address suggestions: built-ins + saved book + every address seen on-chain
  const nameOf = (a: string): string | undefined => {
    const lc = a.toLowerCase();
    if (book[lc]) return book[lc];
    if (lc === ROLES.delegate.toLowerCase()) return 'Demo delegate';
    if (lc === ROLES.auditor.toLowerCase()) return 'Demo auditor';
    if (lc === ROLES.deployer.toLowerCase()) return 'Ops payout';
    return undefined;
  };
  const knownAddrs = useMemo(() => {
    const set = new Map<string, string>();
    const add = (a?: string) => { if (a && isAddress(a)) set.set(a.toLowerCase(), a); };
    add(ROLES.delegate); add(ROLES.deployer); add(ROLES.auditor);
    Object.keys(book).forEach(add);
    mandates.forEach((m) => { add(m.delegate); m.recipients.forEach(add); });
    return [...set.values()];
  }, [mandates, book]);

  if (!isAdmin)
    return <NoRole title="Finance Admin — restricted"
      body="The finance admin proposes encrypted policies and can pause the module. It is deliberately NOT a public demo role (it can create disclosure packets and pause spending), so it isn't offered as a one-click account. Watch what the admin did in the Verify page, or try the Delegate / Auditor roles to experience the confidential flow." />;

  const step1Valid = isAddress(delegate) && [autoLimit, budget, floor].every((v) => /^\d+(\.\d{1,6})?$/.test(v) && Number(v) > 0) && Number(days) > 0 && Number(days) <= 3650;
  const step2Valid = recips.length > 0 && recips.every(isAddress) && new Set(recips.map((r) => r.toLowerCase())).size === recips.length;

  const addRecip = (a: string) => {
    const v = a.trim();
    if (!isAddress(v)) { toast('Not a valid address', true); return; }
    if (recips.some((r) => r.toLowerCase() === v.toLowerCase())) return;
    setRecips([...recips, v]); setRecipInput('');
  };

  const rememberName = () => {
    if (delegateName.trim() && isAddress(delegate)) {
      const next = { ...book, [delegate.toLowerCase()]: delegateName.trim() };
      setBook(next); saveBook(next);
    }
  };

  const propose = () =>
    run('Propose encrypted mandate', async () => {
      const client = await handleClientFor(account!);
      const [l, b, f] = await Promise.all([
        client.encryptInput(parseUsdc(autoLimit), 'uint256', ADDR.VeilGuardModule),
        client.encryptInput(parseUsdc(budget), 'uint256', ADDR.VeilGuardModule),
        client.encryptInput(parseUsdc(floor), 'uint256', ADDR.VeilGuardModule),
      ]);
      const now = BigInt(Math.floor(Date.now() / 1000));
      const hash = await walletWrite({
        account: account!, address: ADDR.VeilGuardModule, abi: moduleAbi, functionName: 'proposeMandate',
        args: [delegate as `0x${string}`, 0n, now + BigInt(Number(days)) * 86_400n,
          recips as `0x${string}`[], l.handle, l.handleProof, b.handle, b.handleProof, f.handle, f.handleProof],
        onHint: (m) => toast(m),
      });
      await publicClient.waitForTransactionReceipt({ hash });
      rememberName();
      toast('✓ Encrypted mandate proposed. It stays a Draft until the Safe 2-of-2 activates it.');
      setStep(0);
    });

  const pause = () =>
    run('Pause all mandates', async () => {
      const hash = await walletWrite({ account: account!, address: ADDR.VeilGuardModule, abi: moduleAbi, functionName: 'pauseAll', args: [], onHint: (m) => toast(m) });
      await publicClient.waitForTransactionReceipt({ hash });
    });

  // ---- packet builder: pick a mandate, tick terminal requests ----
  const packetMandate = auditMandate || (mandates[0] ? String(mandates[0].id) : '');
  const packetReqs = useMemo(
    () => requests.filter((r) => String(r.mandateId) === packetMandate && [2, 4, 5, 6].includes(r.state)),
    [requests, packetMandate],
  );
  const toggleReq = (id: string) => {
    const next = new Set(auditSel);
    if (next.has(id)) next.delete(id);
    else if (next.size >= 8) { toast('A packet holds at most 8 requests', true); return; }
    else next.add(id);
    setAuditSel(next);
  };

  const createPacket = () =>
    run('Create audit packet', async () => {
      const ids = [...auditSel].map(BigInt).sort((a, b) => (a < b ? -1 : 1));
      const hash = await walletWrite({
        account: account!, address: ADDR.VeilGuardModule, abi: moduleAbi, functionName: 'createAuditPacket',
        args: [auditor as `0x${string}`, BigInt(packetMandate), ids], onHint: (m) => toast(m),
      });
      await publicClient.waitForTransactionReceipt({ hash });
      setAuditSel(new Set());
      setAuditStep(0);
      toast('✓ Selective-disclosure packet created for the auditor.');
    });

  const suggest = (current: string, onPick: (a: string) => void, exclude: string[] = []) => (
    <div className="addr-suggest">
      {knownAddrs
        .filter((a) => a.toLowerCase() !== current.toLowerCase() && !exclude.some((e) => e.toLowerCase() === a.toLowerCase()))
        .slice(0, 5)
        .map((a) => (
          <button key={a} type="button" className="addr-chip" onClick={() => onPick(a)}>
            {nameOf(a) ? <b>{nameOf(a)}</b> : null}<span className="mono">{short(a)}</span>
          </button>
        ))}
    </div>
  );

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
            <div className="form-grid" style={{ gridTemplateColumns: '2fr 1fr' }}>
              <div>
                <label>Delegate address</label>
                <input value={delegate} onChange={(e) => setDelegate(e.target.value)} className="mono" />
                {!isAddress(delegate) && delegate && <p className="field-err">not a valid address</p>}
              </div>
              <div>
                <label>Name (optional, saved locally)</label>
                <input value={delegateName} onChange={(e) => setDelegateName(e.target.value)} placeholder="e.g. Marketing — Alice" />
              </div>
            </div>
            {suggest(delegate, (a) => setDelegate(a))}
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
            <label>Allowed recipients — the only addresses this delegate can pay</label>
            <div className="recip-picker">
              {recips.map((r) => (
                <span key={r} className="recip-chip">
                  {nameOf(r) && <b>{nameOf(r)}</b>}
                  <span className="mono">{short(r)}</span>
                  <button type="button" className="chip-x" onClick={() => setRecips(recips.filter((x) => x !== r))}>✕</button>
                </span>
              ))}
              <input value={recipInput} className="mono recip-input" placeholder="paste 0x… and press Enter"
                onChange={(e) => setRecipInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addRecip(recipInput); } }} />
              {recipInput && <button type="button" className="btn small" onClick={() => addRecip(recipInput)}>+ Add</button>}
            </div>
            {suggest('', (a) => addRecip(a), recips)}
            {!step2Valid && recips.length > 0 && <p className="field-err">every recipient must be a unique valid address</p>}
            <div className="wiz-nav">
              <button className="btn ghost" onClick={() => setStep(0)}>← Back</button>
              <button className="btn primary" disabled={!step2Valid} onClick={() => setStep(2)}>Next: review →</button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="wiz-body">
            <div className="nl-summary">
              In plain words: <b>{delegateName.trim() || short(delegate)}</b> may pay up to a confidential total
              budget of <b>{fmt(parseUsdc(budget))} cUSDC</b>, only to <b>{recips.length} approved
              recipient{recips.length === 1 ? '' : 's'}</b>, for <b>{days} days</b>. Payments over{' '}
              <b>{fmt(parseUsdc(Number(autoLimit) ? autoLimit : '0'))} cUSDC</b> need Safe approval, and the
              treasury never drops below <b>{fmt(parseUsdc(floor))} cUSDC</b>. On-chain, all four numbers are ciphertext.
            </div>
            <div className="review">
              <div className="rv-row"><span>Delegate</span><span className="mono">{delegateName.trim() ? `${delegateName.trim()} · ` : ''}{short(delegate)}</span></div>
              <div className="rv-row"><span>Auto-limit</span><span className="value">{fmt(parseUsdc(Number(autoLimit) ? autoLimit : '0'))} cUSDC 🔒</span></div>
              <div className="rv-row"><span>Total budget</span><span className="value">{fmt(parseUsdc(budget))} cUSDC 🔒</span></div>
              <div className="rv-row"><span>Reserve floor</span><span className="value">{fmt(parseUsdc(floor))} cUSDC 🔒</span></div>
              <div className="rv-row"><span>Valid for</span><span>{days} days</span></div>
              <div className="rv-row"><span>Recipients</span><span className="mono">{recips.map((r) => nameOf(r) ?? short(r)).join(', ')}</span></div>
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
        <div className="card disclosure-builder">
          <div className="section-heading compact">
            <div><h3>Create disclosure packet</h3><p>Scoped, immutable and irreversible once granted.</p></div>
            <span className="status-badge">{auditStep === 0 ? '1 · Select' : '2 · Review'}</span>
          </div>
          {auditStep === 0 ? (
            <>
              <label htmlFor="audit-auditor">Auditor address</label>
              <input id="audit-auditor" value={auditor} onChange={(e) => setAuditor(e.target.value)} className="mono" />
              {suggest(auditor, (a) => setAuditor(a))}
              <label htmlFor="audit-mandate">Mandate</label>
              <select id="audit-mandate" value={packetMandate} onChange={(e) => { setAuditMandate(e.target.value); setAuditSel(new Set()); }}>
                {mandates.map((m) => (
                  <option key={String(m.id)} value={String(m.id)}>#{String(m.id)} · {nameOf(m.delegate) ?? short(m.delegate)} · v{m.version}</option>
                ))}
              </select>
              <label>Terminal requests to disclose ({auditSel.size}/8)</label>
              <div className="req-picker">
                {packetReqs.map((r) => (
                  <label key={String(r.id)} className={`req-opt ${auditSel.has(String(r.id)) ? 'on' : ''}`}>
                    <input type="checkbox" checked={auditSel.has(String(r.id))} onChange={() => toggleReq(String(r.id))} />
                    <span className="mono">#{String(r.id)}</span>
                    <span className="mono muted">→ {short(r.recipient)}</span>
                    <RequestPill state={r.state} />
                  </label>
                ))}
                {!packetReqs.length && <p className="muted">No terminal requests on this mandate yet.</p>}
              </div>
              <div className="detail-actions"><button className="btn primary" disabled={!isAddress(auditor) || !auditSel.size} onClick={() => setAuditStep(1)}>Review irreversible scope →</button></div>
            </>
          ) : (
            <div className="disclosure-review">
              <div className="inline-alert bad"><b>This grant cannot be revoked.</b> The auditor receives isolated historical handles, never live policy state.</div>
              <dl className="data-list">
                <div><dt>Auditor</dt><dd className="mono">{short(auditor)}</dd></div>
                <div><dt>Mandate</dt><dd className="mono">#{packetMandate}</dd></div>
                <div><dt>Requests</dt><dd>{[...auditSel].sort().map((id) => `#${id}`).join(', ')}</dd></div>
              </dl>
              <div className="fixed-scope">
                <h4>Contract v1 fixed policy scope</h4>
                {['Auto-limit snapshot', 'Budget-left snapshot', 'Reserve-floor snapshot'].map((field) => <span key={field} className="status-badge ok">Included · {field}</span>)}
                <p>The deployed contract always includes these three policy snapshots. They are not optional UI fields.</p>
              </div>
              <div className="sticky-decision-bar">
                <button className="btn ghost" onClick={() => setAuditStep(0)}>Back to selection</button>
                <button className="btn primary" disabled={!!busy} onClick={createPacket}>Create immutable packet</button>
              </div>
            </div>
          )}
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
                <td className="mono">{nameOf(m.delegate) ? `${nameOf(m.delegate)} · ` : ''}{short(m.delegate)}</td>
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
