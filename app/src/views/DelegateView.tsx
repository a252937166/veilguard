import { useEffect, useMemo, useRef, useState } from 'react';
import { keccak256, stringToBytes } from 'viem';
import { ADDR, PROVISION_API, REASON_LABEL, moduleAbi, parseUsdc, short } from '../config';
import { handleClientFor, makeWalletClient, publicClient } from '../nox';
import { useApp } from '../App';
import { Decrypt, NoRole, RequestPill } from '../ui';

export function DelegateView() {
  const { account, mandates, requests, run, busy, refresh, toast, goTab, startDemo } = useApp();
  const [amount, setAmount] = useState('25');
  const [recipient, setRecipient] = useState('');
  const [memo, setMemo] = useState('');
  const [trackId, setTrackId] = useState<bigint | null>(null);
  const [flow, setFlow] = useState<string | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  const myMandate = useMemo(
    () => mandates.find((m) => m.state === 2 && m.delegate.toLowerCase() === account?.toLowerCase()),
    [mandates, account],
  );
  const myRequests = useMemo(
    () => [...requests].filter((r) => r.delegate.toLowerCase() === account?.toLowerCase()).reverse(),
    [requests, account],
  );
  const latest = useMemo(() => (trackId != null ? requests.find((r) => r.id === trackId) : undefined), [requests, trackId]);
  // The module allows one in-flight request per mandate; a request left in
  // "Requested" (not yet finalized) blocks new ones for everyone on the shared
  // demo account. Surface it so anyone can finalize it and unblock.
  const blockingPending = useMemo(
    () => (myMandate ? requests.find((r) => r.mandateId === myMandate.id && r.state === 1) : undefined),
    [requests, myMandate],
  );

  // fast-poll for a few seconds after submitting so the outcome shows quickly
  useEffect(() => {
    if (trackId == null) return;
    const iv = setInterval(refresh, 3000);
    const stop = setTimeout(() => clearInterval(iv), 40_000);
    return () => { clearInterval(iv); clearTimeout(stop); };
  }, [trackId, refresh]);

  const explainRevert = (e: any): string => {
    const s = `${e?.metaMessages?.join(' ') ?? ''} ${e?.shortMessage ?? ''} ${e?.message ?? ''}`;
    if (/PendingRequestExists/.test(s)) return 'a previous request is still awaiting finalization — finalize it above to free the slot, then try again';
    if (/CooldownActive/.test(s)) return 'this delegate is in a short cooldown after a blocked request — wait a moment and retry';
    if (/NotActiveMandate/.test(s)) return 'this mandate is no longer the active one for the delegate';
    if (/RecipientNotAllowed/.test(s)) return 'that recipient is not on the mandate allow-list';
    if (/MandateNotInWindow/.test(s)) return 'the mandate is outside its valid time window';
    if (/insufficient funds|exceeds the balance|gas required exceeds/.test(s)) return 'the demo account is low on Sepolia gas — try again shortly (it gets topped up)';
    return e?.shortMessage ?? e?.message ?? 'transaction reverted';
  };

  const isDemo = account?.toLowerCase() === '0x17ee5ad7e4b40cadafad27c5f68f74d02c7fd532';
  const submit = () =>
    run(`Request ${amount} cUSDC`, async () => {
      if (!account || !myMandate) throw new Error('no active mandate for this account');
      if (blockingPending) throw new Error('PendingRequestExists');
      const to = (recipient || myMandate.recipients[0]) as `0x${string}`;
      try {
        // 1/2 — encrypt: real wallets pop a SIGNATURE request here
        setFlow(isDemo ? 'Encrypting your amount…' : '① Check your wallet — approve the signature to encrypt your amount');
        const client = await handleClientFor(account);
        const enc = await client.encryptInput(parseUsdc(amount), 'uint256', ADDR.VeilGuardModule);

        // 2/2 — submit: real wallets pop a TRANSACTION confirmation here
        setFlow(isDemo ? 'Submitting the request…' : '② Now confirm the transaction in your wallet');
        const wallet = makeWalletClient(account);
        let hash: `0x${string}`;
        try {
          hash = await wallet.writeContract({
            address: ADDR.VeilGuardModule, abi: moduleAbi, functionName: 'requestSpend',
            args: [myMandate.id, to, enc.handle, enc.handleProof,
              keccak256(stringToBytes(memo || 'veilguard'))],
            chain: wallet.chain, account: wallet.account!,
          });
        } catch (e: any) {
          throw new Error(explainRevert(e));
        }
        setFlow('Waiting for the chain to confirm…');
        await publicClient.waitForTransactionReceipt({ hash });
        const nextId = (await publicClient.readContract({
          address: ADDR.VeilGuardModule, abi: moduleAbi, functionName: 'nextRequestId',
        })) as bigint;
        setTrackId(nextId - 1n);
        toast('Encrypted & submitted ✓  Watch the live status below — the TEE decides in a few seconds.');
        setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 300);
      } finally {
        setFlow(null);
      }
    });

  const finalizingRef = useRef<bigint | null>(null);
  const finalize = (id: bigint, decisionHandle: `0x${string}`, auto = false) =>
    run(auto ? 'Revealing the outcome' : `Reveal outcome of #${id}`, async () => {
      if (!account) return;
      try {
        setFlow(isDemo ? 'Revealing the outcome…' : 'Confirm in your wallet to reveal the outcome');
        const client = await handleClientFor(account);
        const { decryptionProof } = await client.publicDecrypt(decisionHandle as any);
        const wallet = makeWalletClient(account);
        const hash = await wallet.writeContract({
          address: ADDR.VeilGuardModule, abi: moduleAbi, functionName: 'finalize',
          args: [id, decryptionProof], chain: wallet.chain, account: wallet.account!,
        });
        setFlow('Waiting for the chain to confirm…');
        await publicClient.waitForTransactionReceipt({ hash });
      } finally {
        setFlow(null);
      }
    });

  const stage = !latest ? 0 : latest.state === 1 ? (latest.decisionReady ? 2 : 1) : 3;

  // Auto-finalize: the moment the TEE decision is provable, submit the proof so
  // the outcome just "appears" — the delegate never has to understand the
  // two-step finalize. (Own wallets get one clear confirmation prompt.)
  useEffect(() => {
    if (!latest || latest.state !== 1 || !latest.decisionReady) return;
    if (finalizingRef.current === latest.id || busy) return;
    finalizingRef.current = latest.id;
    finalize(latest.id, latest.decision, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latest?.id, latest?.decisionReady]);

  if (!account)
    return <NoRole demo="delegate" title="Act as a Delegate"
      body="A delegate submits encrypted spend requests and watches the TEE decide. Connect your own wallet and get it provisioned as a delegate (below), or jump into the shared demo delegate to try the flow instantly." />;
  if (!myMandate)
    return <ProvisionMe account={account} />;

  const suggest = (v: string) => setAmount(v);

  return (
    <>
      <div className="notice">
        You hold mandate <b>#{String(myMandate.id)}</b>. You never see the full policy — only your own
        requests and their outcomes. The policy itself stays encrypted.
        {!isDemo && <> With your own wallet this takes <b>two approvals</b>: a signature to encrypt, then the transaction.</>}
      </div>

      {flow && (
        <div className="flowbar">
          <span className="spin" /> <b>{flow}</b>
          {!isDemo && flow.startsWith('①') && <span className="muted"> — your wallet should be asking you to sign a message; approve it to continue.</span>}
          {!isDemo && flow.startsWith('②') && <span className="muted"> — your wallet should be asking you to confirm a transaction.</span>}
        </div>
      )}

      {blockingPending && (!latest || latest.id !== blockingPending.id) && (
        <div className="latest" style={{ borderColor: 'var(--warn)' }}>
          <h4>⏳ Request #{String(blockingPending.id)} is awaiting finalization</h4>
          <div className="lrow">
            <span className="muted" style={{ fontSize: 13 }}>
              This shared demo mandate allows one in-flight request at a time. Finalize the pending one
              (anyone can — it's proof-gated) to unblock new requests.
            </span>
            <button className="btn primary small" disabled={!!busy || !blockingPending.decisionReady}
              onClick={() => finalize(blockingPending.id, blockingPending.decision)}>
              {blockingPending.decisionReady ? 'Finalize to unblock →' : <><span className="spin" /> TEE deciding…</>}
            </button>
          </div>
        </div>
      )}

      <div className="journey">
        <div className={`jstep ${stage >= 0 ? 'active' : ''} ${stage > 0 ? 'done' : ''}`}><b><span className="jn">1</span>Encrypt &amp; submit</b>your amount is encrypted in-browser, then sent</div>
        <div className={`jstep ${stage === 1 ? 'active' : ''} ${stage > 1 ? 'done' : ''}`}><b><span className="jn">2</span>TEE decides</b>the policy is evaluated on ciphertext (~2-6s)</div>
        <div className={`jstep ${stage === 2 ? 'active' : ''} ${stage > 2 ? 'done' : ''}`}><b><span className="jn">3</span>Reveal</b>the proof is submitted automatically to reveal the outcome</div>
        <div className={`jstep ${stage === 3 ? 'active done' : ''}`}><b><span className="jn">4</span>Outcome</b>executed / escalated / blocked</div>
      </div>

      {latest && stage < 3 && (
        <div className="latest" ref={resultRef}>
          <h4>
            <span className="spin" /> Request #{String(latest.id)} — {stage === 1 ? 'the TEE is deciding on your encrypted amount…' : 'decision ready — revealing the outcome…'}
          </h4>
          <div className="lrow">
            <span className="muted" style={{ fontSize: 13 }}>
              {stage === 1 && 'The policy is evaluated on ciphertext inside the TEE (a few seconds). Your amount stays encrypted; only a coarse outcome will ever be public.'}
              {stage === 2 && (isDemo
                ? 'Submitting the decryption proof on-chain to reveal the outcome — no action needed.'
                : 'Your wallet will ask you to confirm one transaction to reveal the outcome. Approve it and the result appears here.')}
            </span>
            <div className="row">
              {stage === 2 && !busy && <button className="btn small" onClick={() => finalize(latest.id, latest.decision)}>Reveal manually</button>}
            </div>
          </div>
        </div>
      )}

      {latest && stage === 3 && (
        <div className="outcome-panel" ref={resultRef}>
          <div className="op-head">
            <span className={`op-badge ${latest.state === 2 ? 'ok' : latest.state === 3 ? 'warn' : 'bad'}`}>
              {latest.state === 2 ? '✓ EXECUTED' : latest.state === 3 ? '⏸ APPROVAL REQUIRED' : '⛔ BLOCKED'}
            </span>
            <b>Request #{String(latest.id)} complete</b>
          </div>
          <p className="op-desc">
            {latest.state === 2 && <>The payment was within your secret policy, so it executed immediately as a confidential ERC-7984 transfer — the amount stayed encrypted end to end. Nobody watching the chain learned how much moved.</>}
            {latest.state === 3 && <>The amount was above the secret auto-limit, so it's held in escrow for the Safe 2-of-2 to approve. Signers (only signers) can decrypt it. Watch it in the Signer tab.</>}
            {latest.state === 4 && <>The request violated the secret policy — no funds moved, your budget is untouched, and a 10-minute cooldown is now active. You can decrypt a coarse reason, never the exact limit.</>}
          </p>
          {latest.state === 4 && (
            <div className="row" style={{ marginBottom: 12 }}>
              <span className="muted" style={{ fontSize: 13 }}>Coarse reason (private to you):</span>
              <Decrypt handle={latest.blockedReason} unit="" label="Decrypt reason" />
            </div>
          )}
          <div className="op-next">
            <span className="op-next-label">What next?</span>
            <div className="row">
              {latest.state !== 3 && <button className="btn small" onClick={() => { setAmount('60'); setTrackId(null); }}>Try 60 → see escalation</button>}
              {latest.state !== 4 && <button className="btn small" onClick={() => { setAmount('600'); setTrackId(null); }}>Try 600 → see it blocked</button>}
              {latest.state === 2 && <button className="btn small" onClick={() => { setAmount('25'); setTrackId(null); }}>Send another</button>}
              <button className="btn small ghost" onClick={() => goTab('Dashboard')}>See it in the evidence table →</button>
              <button className="btn small ghost" onClick={() => startDemo('auditor')}>Switch to the Auditor role →</button>
            </div>
          </div>
        </div>
      )}

      <div className="grid2">
        <div className="card">
          <h3>Submit a spend request</h3>
          <label>Recipient (mandate allow-list)</label>
          <select value={recipient} onChange={(e) => setRecipient(e.target.value)}>
            {myMandate.recipients.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <label>Amount (cUSDC) — encrypted in your browser before it leaves</label>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} type="number" min="0" step="0.01" />
          <div className="row" style={{ marginTop: 8, gap: 7 }}>
            <span className="muted" style={{ fontSize: 12 }}>try:</span>
            <button className="btn small ghost" onClick={() => suggest('25')}>25 → likely execute</button>
            <button className="btn small ghost" onClick={() => suggest('60')}>60 → likely escalate</button>
            <button className="btn small ghost" onClick={() => suggest('600')}>600 → likely blocked</button>
          </div>
          <label>Memo (only its hash goes on-chain)</label>
          <input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="invoice #… (optional)" />
          <div style={{ marginTop: 14 }}>
            <button className="btn primary" disabled={!!busy || !amount || (!!blockingPending && (!latest || latest.id !== blockingPending.id))} onClick={submit}>
              🔒 Encrypt &amp; submit
            </button>
            {blockingPending && (!latest || latest.id !== blockingPending.id) && (
              <p className="muted" style={{ fontSize: 12, marginTop: 7 }}>Finalize the pending request above first.</p>
            )}
          </div>
        </div>

        <div className="card">
          <h3>What you can(not) learn</h3>
          <p className="muted" style={{ fontSize: 13.5 }}>
            After the TEE evaluates your request you see one of three outcomes. If it's blocked you may
            decrypt a <b>coarse reason</b> — never the exact limit or the remaining budget, so the policy
            can't be probed out of you. A blocked request also starts a 10-minute cooldown.
          </p>
          <p className="muted" style={{ fontSize: 13, marginTop: 10 }}>
            The exact numbers are secret, but the demo policy roughly is: small payments auto-execute, larger
            ones need Safe approval, and anything over budget is blocked. Try the presets to see all three.
          </p>
        </div>
      </div>

      <div className="card">
        <h3>My requests</h3>
        <div className="tbl"><table>
          <thead><tr><th>ID</th><th>Recipient</th><th>My amount</th><th>Outcome</th><th>Blocked reason</th></tr></thead>
          <tbody>
            {myRequests.map((r) => (
              <tr key={String(r.id)}>
                <td className="mono">#{String(r.id)}</td>
                <td className="mono">{short(r.recipient)}</td>
                <td><Decrypt handle={r.amount} /></td>
                <td><RequestPill state={r.state} decisionReady={r.decisionReady} /></td>
                <td>{r.state === 4 ? <Decrypt handle={r.blockedReason} unit="" label="Reason" /> : <span className="muted">—</span>}</td>
              </tr>
            ))}
            {!myRequests.length && <tr><td colSpan={5} className="muted">No requests yet.</td></tr>}
          </tbody>
        </table></div>
        <p className="muted" style={{ marginTop: 8, fontSize: 12.5 }}>
          Blocked reasons decode as: 1 = {REASON_LABEL[1]}, 2 = {REASON_LABEL[2]}, 3 = {REASON_LABEL[3]}.
        </p>
      </div>
    </>
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
