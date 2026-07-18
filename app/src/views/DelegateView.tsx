import { useEffect, useMemo, useRef, useState } from 'react';
import { keccak256, stringToBytes } from 'viem';
import { ADDR, FINALIZE_API, PROVISION_API, moduleAbi, parseUsdc, scanTx, short, vendorName } from '../config';
import { handleClientFor, publicClient } from '../nox';
import { walletWrite } from '../walletTx';
import { fetchRequestTxs, type RequestTxs } from '../txlog';
import { useApp, type SpendRequest } from '../App';
import { NoRole, RequestPill } from '../ui';
import { VIOLATION_DELEGATE, demoWalletByAddress } from '../demo';
import { MISSIONS, completeMission, loadMissions, type MissionKey, type MissionState } from '../missions';

const REASONS: Record<number, string> = {
  1: 'over the delegated budget',
  2: 'treasury balance too low',
  3: 'would breach the reserve floor',
};

function mmss(sec: number): string {
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function DelegateView() {
  const { account, mandates, requests, run, busy, refresh, toast, goTab, startDemo } = useApp();
  const [amount, setAmount] = useState('25');
  const [recipient, setRecipient] = useState('');
  const [memo, setMemo] = useState('');
  const [trackId, setTrackId] = useState<bigint | null>(null);
  const [missionOf, setMissionOf] = useState<MissionKey | 'free' | null>(null);
  const [lastAmount, setLastAmount] = useState<string>('');
  const [lastTx, setLastTx] = useState<`0x${string}` | null>(null);
  const [reasonVal, setReasonVal] = useState<string | null>(null);
  const [reasonBusy, setReasonBusy] = useState(false);
  const [missions, setMissions] = useState<MissionState>(loadMissions);
  const [txs, setTxs] = useState<Map<string, RequestTxs>>(new Map());
  const [cool, setCool] = useState<{ main: number; violation: number }>({ main: 0, violation: 0 });

  // Rich progress state: label + started + expected duration + optional tx link.
  type Flow = { label: string; startedAt: number; expect?: number; tx?: `0x${string}` };
  const [flow, setFlowState] = useState<Flow | null>(null);
  const setFlow = (label: string | null, expect?: number, tx?: `0x${string}`) =>
    setFlowState((f) => label === null ? null : ({
      label,
      startedAt: f && f.label === label ? f.startedAt : Date.now(),
      expect: expect ?? (f && f.label === label ? f.expect : undefined),
      tx: tx ?? f?.tx,
    }));
  const [, forceTick] = useState(0);
  useEffect(() => {
    const need = !!flow || cool.main > Math.floor(Date.now() / 1000) || cool.violation > Math.floor(Date.now() / 1000);
    if (!need) return;
    const iv = setInterval(() => forceTick((t) => t + 1), 500);
    return () => clearInterval(iv);
  }, [flow?.label, cool.main, cool.violation]);

  const freeFormRef = useRef<HTMLDivElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const receiptRef = useRef<HTMLDivElement>(null);

  const isDemo = account?.toLowerCase() === '0x17ee5ad7e4b40cadafad27c5f68f74d02c7fd532';
  const myMandate = useMemo(
    () => mandates.find((m) => m.state === 2 && m.delegate.toLowerCase() === account?.toLowerCase()),
    [mandates, account],
  );
  const violationMandate = useMemo(
    () => mandates.find((m) => m.state === 2 && m.delegate.toLowerCase() === VIOLATION_DELEGATE.address.toLowerCase()),
    [mandates],
  );
  const myRequests = useMemo(() => {
    const mine = (d: string) => d.toLowerCase() === account?.toLowerCase()
      || (isDemo && d.toLowerCase() === VIOLATION_DELEGATE.address.toLowerCase());
    return [...requests].filter((r) => mine(r.delegate)).reverse();
  }, [requests, account, isDemo]);
  const latest = useMemo(() => (trackId != null ? requests.find((r) => r.id === trackId) : undefined), [requests, trackId]);

  // In-flight (Requested OR AwaitingSafeApproval) occupies the mandate slot —
  // both must block new submissions (the contract rejects them anyway).
  const blockingRequest = useMemo(
    () => (myMandate ? requests.find((r) => r.mandateId === myMandate.id && (r.state === 1 || r.state === 3)) : undefined),
    [requests, myMandate],
  );
  // adopt an untracked in-flight request (e.g. left over from a previous visit)
  useEffect(() => {
    if (trackId == null && blockingRequest) { setTrackId(blockingRequest.id); setMissionOf(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockingRequest?.id]);

  // fast-poll while a request is in flight
  useEffect(() => {
    if (trackId == null) return;
    const iv = setInterval(refresh, 3000);
    const stop = setTimeout(() => clearInterval(iv), 60_000);
    return () => { clearInterval(iv); clearTimeout(stop); };
  }, [trackId, refresh]);

  // anti-probing cooldown clocks for both demo identities
  useEffect(() => {
    if (!account) return;
    let stop = false;
    const load = async () => {
      try {
        const [a, b] = await Promise.all([
          publicClient.readContract({ address: ADDR.VeilGuardModule, abi: moduleAbi, functionName: 'cooldownUntil', args: [account] }) as Promise<bigint>,
          publicClient.readContract({ address: ADDR.VeilGuardModule, abi: moduleAbi, functionName: 'cooldownUntil', args: [VIOLATION_DELEGATE.address] }) as Promise<bigint>,
        ]);
        if (!stop) setCool({ main: Number(a), violation: Number(b) });
      } catch { /* transient */ }
    };
    load();
    const iv = setInterval(load, 15_000);
    return () => { stop = true; clearInterval(iv); };
  }, [account, requests.length]);
  const nowSec = Math.floor(Date.now() / 1000);
  const mainCoolLeft = Math.max(0, cool.main - nowSec);
  const violationCoolLeft = Math.max(0, cool.violation - nowSec);

  // mission bookkeeping on outcome transitions
  const seenTerminal = useRef<string | null>(null);
  useEffect(() => {
    if (!latest || latest.state === 1 || latest.state === 3) return;
    const key = `${latest.id}:${latest.state}`;
    if (seenTerminal.current === key) return;
    seenTerminal.current = key;
    if (latest.state === 2 && missionOf === 'routine') setMissions(completeMission('routine'));
    if (latest.state === 2 && missionOf === 'approval') { setMissions(completeMission('approval')); fetchRequestTxs(true).then(setTxs).catch(() => {}); }
    setTimeout(() => receiptRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 250);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latest?.state, latest?.id]);
  useEffect(() => { fetchRequestTxs().then(setTxs).catch(() => {}); }, []);
  useEffect(() => {
    const on = () => setMissions(loadMissions());
    window.addEventListener('vg-missions', on);
    return () => window.removeEventListener('vg-missions', on);
  }, []);

  // flash table rows whose outcome just changed (skip the initial load)
  const prevStates = useRef<Map<string, number>>(new Map());
  const primed = useRef(false);
  const [flashIds, setFlashIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    const changed = new Set<string>();
    for (const r of requests) {
      const k = String(r.id);
      const prev = prevStates.current.get(k);
      if (prev === undefined) { if (primed.current) changed.add(k); }
      else if (prev !== r.state) changed.add(k);
      prevStates.current.set(k, r.state);
    }
    primed.current = true;
    if (!changed.size) return;
    setFlashIds((old) => new Set([...old, ...changed]));
    const t = setTimeout(() => setFlashIds((old) => {
      const n = new Set(old); changed.forEach((c) => n.delete(c)); return n;
    }), 2600);
    return () => clearTimeout(t);
  }, [requests]);

  const explainRevert = (e: any): string => {
    const s = `${e?.metaMessages?.join(' ') ?? ''} ${e?.shortMessage ?? ''} ${e?.message ?? ''}`;
    if (/PendingRequestExists/.test(s)) return 'a previous request is still in flight — it resolves automatically in under a minute';
    if (/CooldownActive/.test(s)) return 'this delegate is in the anti-probing cooldown — the countdown above shows when it ends';
    if (/NotActiveMandate/.test(s)) return 'this mandate is no longer the active one for the delegate';
    if (/RecipientNotAllowed/.test(s)) return 'that recipient is not on the mandate allow-list';
    if (/MandateNotInWindow/.test(s)) return 'the mandate is outside its valid time window';
    if (/insufficient funds|exceeds the balance|gas required exceeds/.test(s)) return 'the demo account is low on Sepolia gas — try again shortly (it gets topped up)';
    return e?.shortMessage ?? e?.message ?? 'transaction reverted';
  };

  /** Shared submit pipeline — works for the page identity AND the hidden violation delegate. */
  const submitCore = (who: `0x${string}`, mandateId: bigint, recipient: `0x${string}`, amt: string, mission: MissionKey | 'free') =>
    run(`Pay ${amt} cUSDC`, async () => {
      const local = !!demoWalletByAddress(who);
      try {
        setFlow(local ? 'Encrypting the amount in-browser…' : '① Check your wallet — approve the signature to encrypt your amount', local ? 6 : undefined);
        const sigHint = !local && setTimeout(() => setFlow(
          '① No signature popup? Click the wallet (🦊) icon in your toolbar — the request is queued there without auto-opening.',
        ), 12_000);
        let enc;
        try {
          const client = await handleClientFor(who);
          enc = await client.encryptInput(parseUsdc(amt), 'uint256', ADDR.VeilGuardModule);
        } finally { if (sigHint) clearTimeout(sigHint); }

        setFlow(local ? 'Broadcasting the encrypted payment…' : '② Now confirm the transaction in your wallet', local ? 4 : undefined);
        let hash: `0x${string}`;
        try {
          hash = await walletWrite({
            account: who, address: ADDR.VeilGuardModule, abi: moduleAbi, functionName: 'requestSpend',
            args: [mandateId, recipient, enc.handle, enc.handleProof, keccak256(stringToBytes(memo || 'veilguard'))],
            onHint: setFlow, injected: !local,
          });
        } catch (e: any) {
          if (e?.code === 4001 || /User rejected|denied/i.test(`${e?.message}`)) throw new Error('you rejected the transaction in the wallet');
          throw new Error(explainRevert(e));
        }
        setFlow('Sepolia is including your transaction…', 13, hash);
        await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 1_200 });
        // find our request id (scan back a little — other visitors may interleave)
        const nextId = (await publicClient.readContract({
          address: ADDR.VeilGuardModule, abi: moduleAbi, functionName: 'nextRequestId',
        })) as bigint;
        let id = nextId - 1n;
        for (let i = nextId - 1n; i > 0n && i > nextId - 5n; i--) {
          const r = (await publicClient.readContract({
            address: ADDR.VeilGuardModule, abi: moduleAbi, functionName: 'getRequest', args: [i],
          })) as any[];
          if ((r[1] as string).toLowerCase() === who.toLowerCase()) { id = i; break; }
        }
        setReasonVal(null); setLastAmount(amt); setLastTx(hash); setMissionOf(mission); setTrackId(id);
      } finally { setFlow(null); }
    });

  const finalizingRef = useRef<bigint | null>(null);
  useEffect(() => {
    if (!latest || latest.state !== 1 || !latest.decisionReady) return;
    if (finalizingRef.current === latest.id || busy) return;
    finalizingRef.current = latest.id;
    run('Publishing the result', async () => {
      setFlow('The decision is ready — the keeper is publishing the TEE proof on-chain…', 22);
      try {
        const res = await fetch(FINALIZE_API, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId: Number(latest.id) }),
        });
        if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d?.error ?? 'finalize failed'); }
        for (let k = 0; k < 6; k++) { await new Promise((r) => setTimeout(r, 1500)); refresh(); }
      } finally { setFlow(null); }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latest?.id, latest?.decisionReady]);

  // ---------------- scenario engine ----------------
  const unlocked: Record<MissionKey, boolean> = {
    routine: true,
    approval: missions.routine,
    violation: missions.approval,
    audit: missions.routine && missions.approval && missions.violation,
  };
  const vendorOf = (m?: { recipients: `0x${string}`[] }) => (m?.recipients[0] ?? '0x') as `0x${string}`;

  const loadScenario = (amt: string, label: string) => {
    setAmount(amt); setTrackId(null); setReasonVal(null);
    requestAnimationFrame(() => freeFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    setTimeout(() => amountRef.current?.focus(), 420);
    toast(`${label} loaded — press Submit to run it with your wallet.`);
  };

  const runScenario = (key: MissionKey) => {
    if (!myMandate || busy) return;
    if (blockingRequest) { toast('A payment is still in flight — it clears in under a minute.', true); return; }
    if (key === 'routine' || key === 'approval') {
      const amt = key === 'routine' ? '25' : '60';
      if (!isDemo) { loadScenario(amt, key === 'routine' ? 'Routine payment' : 'Approval challenge'); return; }
      submitCore(account!, myMandate.id, vendorOf(myMandate), amt, key);
      return;
    }
    // violation: use the dedicated delegate so the main one never enters cooldown
    if (isDemo && violationMandate && violationCoolLeft <= 0) {
      submitCore(VIOLATION_DELEGATE.address, violationMandate.id, vendorOf(violationMandate), '600', 'violation');
      return;
    }
    if (isDemo && violationMandate) {
      // someone just ran it — exhibit the freshest blocked request instead
      const exhibit = [...requests].reverse().find((r) => r.mandateId === violationMandate.id && r.state === 4);
      if (exhibit) {
        setReasonVal(null); setLastAmount('600'); setLastTx(null); setMissionOf('violation'); setTrackId(exhibit.id);
        toast('A visitor just triggered the block — showing that live payment. Decrypt its reason to finish the mission.');
        setTimeout(() => receiptRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 250);
        return;
      }
      toast(`The violation delegate is cooling down (${mmss(violationCoolLeft)}) — try again shortly.`, true);
      return;
    }
    // own wallet (or setup missing): run it on the caller's own mandate
    loadScenario('600', 'Policy violation');
  };

  const decryptReason = async () => {
    if (!latest) return;
    setReasonBusy(true);
    try {
      const client = await handleClientFor(latest.delegate);
      const { value } = await client.decrypt(latest.blockedReason as any);
      const n = Number(value);
      setReasonVal(`${n} · ${REASONS[n] ?? 'unknown'}`);
      if (missionOf === 'violation') setMissions(completeMission('violation'));
    } catch (e: any) {
      toast(`Decrypt refused: ${e?.message ?? e}`.slice(0, 260), true);
    } finally { setReasonBusy(false); }
  };

  if (!account)
    return <NoRole demo="delegate" title="Act as a Delegate"
      body="A delegate submits encrypted spend requests and watches the TEE decide. Connect your own wallet and get it provisioned as a delegate (below), or jump into the shared demo delegate to try the flow instantly." />;
  if (!myMandate)
    return <ProvisionMe account={account} />;

  const vendor = vendorOf(latest ? mandates.find((m) => m.id === latest.mandateId) ?? myMandate : myMandate);
  const vName = vendorName(vendor) ?? short(vendor);
  const stage = !latest ? (busy ? 1 : 0) : latest.state === 1 ? 2 : 3;
  const inFlight = stage === 1 || stage === 2;
  const terminal = latest && latest.state !== 1 && latest.state !== 3;
  const escalated = latest?.state === 3;
  const allCollected = missions.routine && missions.approval && missions.violation;

  const primaryNext = () => {
    if (!missions.routine) return { label: '▶ Run: Routine payment', act: () => runScenario('routine') };
    if (!missions.approval) return { label: 'Continue: Approval challenge →', act: () => runScenario('approval') };
    if (!missions.violation) return { label: 'Continue: Policy violation →', act: () => runScenario('violation') };
    return { label: 'Open the disclosure packet as Auditor →', act: () => startDemo('auditor') };
  };

  // ---------------- render ----------------
  return (
    <div className="paygrid">
      <div className="paymain">
        {flow && (() => {
          const elapsed = Math.floor((Date.now() - flow.startedAt) / 1000);
          const pct = flow.expect ? Math.min(96, (elapsed / flow.expect) * 100) : null;
          const slow = flow.expect ? elapsed > flow.expect * 2 : false;
          return (
            <div className="flowbar rich">
              <div className="fb-row">
                <span className="spin" /> <b>{flow.label}</b>
                <span className="fb-elapsed mono">{elapsed}s{flow.expect ? ` · ~${flow.expect}s expected` : ''}</span>
                {flow.tx && <a className="alink mono" href={scanTx(flow.tx)} target="_blank" rel="noopener">view tx ↗</a>}
              </div>
              {pct !== null && <div className="fb-track"><div className="fb-fill" style={{ width: `${pct}%` }} /></div>}
              {!isDemo && flow.label.startsWith('①') && <div className="fb-note">Your wallet should be asking you to sign a message — approve it to continue.</div>}
              {!isDemo && flow.label.startsWith('②') && <div className="fb-note">Your wallet should be asking you to confirm a transaction.</div>}
              {slow && <div className="fb-note">Taking longer than usual — Sepolia occasionally stretches to ~30s. Nothing is stuck.</div>}
            </div>
          );
        })()}

        {/* 3-step strip — only while something is actually processing */}
        {inFlight && (
          <div className="journey three">
            <div className={`jstep ${stage === 1 ? 'active' : 'done'}`}><b><span className="jn">1</span>Submit payment</b>encrypted in your browser, then sent</div>
            <div className={`jstep ${stage === 2 ? 'active' : ''}`}><b><span className="jn">2</span>Private policy check</b>TEE evaluates on ciphertext · proof lands on-chain (~15–40s)</div>
            <div className="jstep"><b><span className="jn">3</span>Result</b>executed / needs approval / blocked</div>
          </div>
        )}

        {/* ---- receipt / live committee card ---- */}
        {latest && (terminal || escalated) && (
          <div ref={receiptRef} data-tour="outcome"
            className={`receipt ${latest.state === 2 ? 'ok' : latest.state === 3 ? 'warn' : latest.state === 4 ? 'bad' : 'dim'}`}>
            <div className="r-head">
              {latest.state === 2 && <b>✓ Payment completed privately</b>}
              {latest.state === 3 && <b>⏸ Payment held for approval</b>}
              {latest.state === 4 && <b>⛔ Payment blocked — treasury protected</b>}
              {(latest.state === 5 || latest.state === 6) && <b>Request {latest.state === 5 ? 'cancelled' : 'expired'}</b>}
              <span className="mono muted">#{String(latest.id)}</span>
            </div>
            <div className="r-rows">
              {lastAmount && <div className="r-row"><span>Amount</span><span><b>{lastAmount} cUSDC</b> → {vName} <i className="muted">(visible only to you)</i></span></div>}
              {!lastAmount && <div className="r-row"><span>Paid to</span><span>{vName} <span className="mono muted">{short(latest.recipient)}</span></span></div>}
              <div className="r-row"><span>Policy result</span><span>{latest.state === 2 ? (missionOf === 'approval' ? 'Above auto-limit — approved by the committee' : 'Within mandate') : latest.state === 3 ? 'Above auto-limit — committee sign-off required' : latest.state === 4 ? 'Violates the confidential policy' : '—'}</span></div>
              {latest.state === 3 && <div className="r-row"><span>Funds</span><span className="ok-text">reserved in escrow — nothing moves without the 2-of-2</span></div>}
              {latest.state === 4 && <div className="r-row"><span>Funds</span><span className="ok-text">untouched — budget intact, cooldown armed</span></div>}
              {latest.state === 4 && (
                <div className="r-row"><span>Private reason</span>
                  <span>{reasonVal ? <b className="value">{reasonVal}</b> : <i className="muted">encrypted — only you can open it</i>}</span>
                </div>
              )}
              {missionOf === 'approval' && latest.state === 2 && (
                <div className="r-row"><span>Committee</span>
                  <span className="ok-text">✓ approved by a real Safe 2-of-2{txs.get(String(latest.id))?.approval && <> · <a className="alink mono" href={scanTx(txs.get(String(latest.id))!.approval!)} target="_blank" rel="noopener">view approval ↗</a></>}</span>
                </div>
              )}
              <div className="r-row"><span>Publicly visible</span><span>outcome only — never the number</span></div>
            </div>

            {escalated && (
              <div className="committee-live">
                <span className="spin" /> <b>Treasury committee reviewing…</b> approves with a real 2-of-2 within ~1 minute — this card updates by itself.
              </div>
            )}

            {!escalated && (
              <div className="r-cta">
                {latest.state === 4 && !reasonVal
                  ? <button className="btn primary" disabled={reasonBusy} onClick={decryptReason}>{reasonBusy ? <><span className="spin" /> Decrypting…</> : '🔓 Decrypt the private reason'}</button>
                  : <button className="btn primary" disabled={!!busy} onClick={primaryNext().act}>{primaryNext().label}</button>}
                <details className="more-menu">
                  <summary>More actions ▾</summary>
                  <div className="mm-body">
                    <button className="mm-item" onClick={() => { setTrackId(null); setReasonVal(null); }}>Send another payment</button>
                    <button className="mm-item" onClick={() => loadScenario(amount || '25', 'Custom payment')}>Enter a custom amount</button>
                    {lastTx && <a className="mm-item" href={scanTx(lastTx)} target="_blank" rel="noopener">View transaction proof ↗</a>}
                    <button className="mm-item" onClick={() => goTab('Dashboard')}>See it in the evidence table</button>
                  </div>
                </details>
              </div>
            )}

            <details className="privacy-acc slim">
              <summary>Why was this private? ▾</summary>
              <p className="muted" style={{ fontSize: 13 }}>
                Your amount was encrypted in the browser. Nox evaluated the confidential policy inside a TEE —
                budget, balance and reserve rules, all on ciphertext. Only the coarse outcome became public,
                and the payout (if any) moved as an ERC-7984 confidential transfer.
              </p>
            </details>
          </div>
        )}

        {/* ---- guided sandbox ---- */}
        <div className="card">
          <h3>Guided sandbox <small>collect all three outcomes — deterministic teaching scenarios</small></h3>
          <div className="scen-list">
            {MISSIONS.map((m, i) => {
              const done = missions[m.key];
              const locked = !unlocked[m.key];
              return (
                <div key={m.key} className={`scen-card ${done ? 'done' : ''} ${locked ? 'locked' : ''}`}
                  data-tour={i === 0 ? 'scenario-routine' : undefined}>
                  <div className="sc-head">
                    <b>{i + 1} · {m.title}</b>
                    {done ? <span className="pill ok">COLLECTED</span> : locked ? <span className="pill dim">🔒 finish the previous one</span> : <span className="pill tee">{m.outcome}</span>}
                  </div>
                  <p className="muted">{m.goal}</p>
                  {!locked && (
                    <button className={`btn small ${done ? '' : 'primary'}`} disabled={!!busy || !!blockingRequest}
                      onClick={() => runScenario(m.key)}>
                      {done ? '↻ Run again' : isDemo ? '▶ Run scenario' : '→ Load scenario'}
                    </button>
                  )}
                  {m.key === 'violation' && !locked && isDemo && violationCoolLeft > 0 && (
                    <span className="muted" style={{ fontSize: 11.5, marginLeft: 8 }}>fresh run in {mmss(violationCoolLeft)} — or replay the latest block</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* ---- free play ---- */}
        <div className="card" data-tour="submit" ref={freeFormRef}>
          <h3>Free play <small>your own amount — the outcome is unknown until the TEE evaluates it</small></h3>
          {mainCoolLeft > 0 && (
            <div className="cooldown-bar">
              ⏳ <b>Anti-probing cooldown</b> — a blocked payment freezes this delegate for 10 minutes so the
              secret limits can't be binary-searched. Ready in <b className="mono">{mmss(mainCoolLeft)}</b>.
            </div>
          )}
          <label>Pay to</label>
          {myMandate.recipients.length > 1 ? (
            <select value={recipient || myMandate.recipients[0]} onChange={(e) => setRecipient(e.target.value)}>
              {myMandate.recipients.map((r) => <option key={r} value={r}>{vendorName(r) ?? short(r)} · {short(r)}</option>)}
            </select>
          ) : (
            <div className="vendor-card">
              <div><b>{vendorName(myMandate.recipients[0]) ?? 'Approved recipient'}</b>
                <span className="mono muted"> {short(myMandate.recipients[0])}</span></div>
              <button className="btn small ghost" onClick={() => { navigator.clipboard?.writeText(myMandate.recipients[0]); toast('Address copied'); }}>copy</button>
            </div>
          )}
          <label>Amount (cUSDC) — encrypted in your browser before it leaves</label>
          <input ref={amountRef} value={amount} onChange={(e) => setAmount(e.target.value)} type="number" min="0" step="0.01" />
          <label>Memo (only its hash goes on-chain)</label>
          <input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="invoice #… (optional)" />
          <div style={{ marginTop: 14 }}>
            <button className="btn primary" disabled={!!busy || !amount || !!blockingRequest || mainCoolLeft > 0}
              onClick={() => submitCore(account, myMandate.id, (recipient || vendorOf(myMandate)) as `0x${string}`, amount, 'free')}>
              🔒 Submit confidential payment
            </button>
            {blockingRequest && <p className="muted" style={{ fontSize: 12, marginTop: 7 }}>A payment is in flight — it clears automatically in under a minute.</p>}
          </div>
        </div>

        <div className="card">
          <h3>My payments</h3>
          <div className="tbl"><table>
            <thead><tr><th>ID</th><th>To</th><th>Outcome</th><th>Reason</th></tr></thead>
            <tbody>
              {myRequests.slice(0, 10).map((r) => (
                <tr key={String(r.id)} className={flashIds.has(String(r.id)) ? 'row-flash' : ''}>
                  <td className="mono">#{String(r.id)}</td>
                  <td>{vendorName(r.recipient) ?? short(r.recipient)}</td>
                  <td><RequestPill state={r.state} decisionReady={r.decisionReady} /></td>
                  <td>{r.state === 4 ? <ReasonCell r={r} /> : <span className="muted">—</span>}</td>
                </tr>
              ))}
              {!myRequests.length && <tr><td colSpan={4} className="muted">No payments yet — run the first scenario above.</td></tr>}
            </tbody>
          </table></div>
        </div>
      </div>

      {/* ---------------- mission panel ---------------- */}
      <aside className="mission-panel">
        <div className="card mp-card">
          <h3>Your mission</h3>
          {!allCollected ? (
            <p className="mp-goal">{MISSIONS.find((m) => !missions[m.key])?.goal}</p>
          ) : !missions.audit ? (
            <p className="mp-goal">All three outcomes collected — finish the relay as the Auditor.</p>
          ) : (
            <p className="mp-goal ok-text">Demo completed — you've seen the whole confidential loop.</p>
          )}
          <div className="mp-list">
            {MISSIONS.map((m) => (
              <div key={m.key} className={`mp-row ${missions[m.key] ? 'done' : ''}`}>
                <span className="mp-dot">{missions[m.key] ? '✓' : '○'}</span>
                <span>{m.title}</span>
                <span className="mp-out muted">{m.outcome}</span>
              </div>
            ))}
            <div className={`mp-row ${missions.audit ? 'done' : ''}`}>
              <span className="mp-dot">{missions.audit ? '✓' : '○'}</span>
              <span>Audit the packet</span>
              <span className="mp-out muted">🕵 selective disclosure</span>
            </div>
          </div>

          {allCollected && !missions.audit && (
            <button className="btn primary wide" style={{ marginTop: 12 }} onClick={() => startDemo('auditor')}>
              Open the disclosure packet as Auditor →
            </button>
          )}
          {missions.audit && (
            <div className="mp-doneblock">
              <div className="mp-donetitle">🎉 Demo completed</div>
              {['Confidential state', 'Confidential computation', 'Confidential execution', 'Safe 2-of-2 governance', 'Selective disclosure'].map((t) => (
                <div key={t} className="mp-row done"><span className="mp-dot">✓</span><span>{t}</span></div>
              ))}
              <button className="btn primary wide" style={{ marginTop: 10 }} onClick={() => goTab('Verify')}>Verify every step on Sepolia →</button>
            </div>
          )}
        </div>

        <div className="card mp-card">
          <h3>Privacy checks <small>live on every payment</small></h3>
          <div className="mp-priv">
            <div className="mp-row"><span>Per-payment auto-limit</span><span className="enc">🔒 hidden</span></div>
            <div className="mp-row"><span>Delegated budget</span><span className="enc">🔒 hidden</span></div>
            <div className="mp-row"><span>Treasury reserve floor</span><span className="enc">🔒 hidden</span></div>
            <div className="mp-row"><span>Your amounts</span><span className="enc">🔒 encrypted</span></div>
          </div>
          <p className="muted" style={{ fontSize: 12, marginTop: 9 }}>
            The TEE checks every rule on ciphertext — you never see the numbers, they never see daylight.
          </p>
        </div>
      </aside>
    </div>
  );
}

/** Reason decryptor bound to the ROW's delegate identity (demo keys sign locally). */
function ReasonCell({ r }: { r: SpendRequest }) {
  const { toast } = useApp();
  const [v, setV] = useState<string>();
  const [b, setB] = useState(false);
  if (v) return <span className="value">{v}</span>;
  return (
    <button className="btn small ghost" disabled={b} onClick={async () => {
      setB(true);
      try {
        const c = await handleClientFor(r.delegate);
        const { value } = await c.decrypt(r.blockedReason as any);
        const n = Number(value);
        setV(`${n} · ${REASONS[n] ?? 'unknown'}`);
      } catch (e: any) { toast(`Decrypt refused: ${e?.message ?? e}`.slice(0, 200), true); }
      finally { setB(false); }
    }}>{b ? <span className="spin" /> : '🔓 Reason'}</button>
  );
}

/**
 * Sponsored onboarding: a connected wallet asks the server-side provisioner
 * (which holds the admin + Safe-owner keys, never the browser) to propose and
 * 2-of-2 activate a small capped mandate for THIS address. Afterwards the user
 * submits requestSpend with their own wallet and gas.
 */
function ProvisionMe({ account }: { account: `0x${string}` }) {
  const { refresh, toast, startDemo, openRolePicker } = useApp();
  const [busy, setBusy] = useState(false);

  const provision = async () => {
    setBusy(true);
    try {
      const res = await fetch(PROVISION_API, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: account }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'provisioning failed');
      toast(`✓ Your wallet is now a delegate on mandate #${data.mandateId}. Submit an encrypted request below — you'll need a little Sepolia ETH for gas (see 💧 Get test funds).`);
      setTimeout(refresh, 2500);
    } catch (e: any) {
      toast(`Provisioning failed: ${e?.message ?? e}`, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="norole">
      <h3>Use your own wallet as a delegate</h3>
      <p className="muted" style={{ fontSize: 13.5, maxWidth: 660 }}>
        The module only accepts the delegate address fixed in a mandate — so to act as a delegate with{' '}
        <b>your own wallet</b> (<span className="mono">{short(account)}</span>), the treasury has to grant it one.
        Click below and the sponsored provisioner will propose an encrypted mandate for your address and activate
        it with a <b>real 2-of-2 Safe multisig</b> (two distinct owner signatures, threshold 2 — produced here by the demo's own keys, not a multi-party approval queue). Then you submit
        requests yourself, signing with your own wallet.
      </p>
      <div className="row" style={{ marginTop: 14 }}>
        <button className="btn primary" disabled={busy} onClick={provision}>
          {busy ? <><span className="spin" /> Provisioning (2-of-2 activation, ~30s)…</> : '🔑 Provision my wallet as a delegate'}
        </button>
        <button className="btn" onClick={() => startDemo('delegate')}>or use the shared demo delegate</button>
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
        Onboarding is sponsored (the treasury pays the two governance txs); you then sign requests with your own wallet and gas. Capped demo policy: auto-execute ≤ 40, budget 300, reserve 100 cUSDC ·
        one per address per hour. You'll need a little Sepolia ETH to submit requests —{' '}
        <button className="btn small ghost" onClick={openRolePicker} style={{ display: 'none' }}>x</button>
        grab some from 💧 Get test funds.
      </p>
    </div>
  );
}
