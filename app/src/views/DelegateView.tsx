import { useEffect, useMemo, useRef, useState } from 'react';
import { keccak256, stringToBytes } from 'viem';
import { ADDR, REASON_LABEL, moduleAbi, parseUsdc, short } from '../config';
import { handleClientFor, makeWalletClient, publicClient } from '../nox';
import { useApp } from '../App';
import { Decrypt, DecisionLabel, RequestPill } from '../ui';

export function DelegateView() {
  const { account, mandates, requests, run, busy, refresh, toast } = useApp();
  const [amount, setAmount] = useState('25');
  const [recipient, setRecipient] = useState('');
  const [memo, setMemo] = useState('');
  const [trackId, setTrackId] = useState<bigint | null>(null);
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

  // fast-poll for a few seconds after submitting so the outcome shows quickly
  useEffect(() => {
    if (trackId == null) return;
    const iv = setInterval(refresh, 3000);
    const stop = setTimeout(() => clearInterval(iv), 40_000);
    return () => { clearInterval(iv); clearTimeout(stop); };
  }, [trackId, refresh]);

  const submit = () =>
    run(`Request ${amount} cUSDC`, async () => {
      if (!account || !myMandate) throw new Error('no active mandate for this account');
      const to = (recipient || myMandate.recipients[0]) as `0x${string}`;
      const client = await handleClientFor(account);
      const enc = await client.encryptInput(parseUsdc(amount), 'uint256', ADDR.VeilGuardModule);
      const wallet = makeWalletClient(account);
      const hash = await wallet.writeContract({
        address: ADDR.VeilGuardModule, abi: moduleAbi, functionName: 'requestSpend',
        args: [myMandate.id, to, enc.handle, enc.handleProof,
          keccak256(stringToBytes(memo || 'veilguard'))],
        chain: wallet.chain, account: wallet.account!,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      const nextId = (await publicClient.readContract({
        address: ADDR.VeilGuardModule, abi: moduleAbi, functionName: 'nextRequestId',
      })) as bigint;
      setTrackId(nextId - 1n);
      toast('Encrypted & submitted ✓  Watch the live status below — the TEE decides in a few seconds.');
      setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 300);
    });

  const finalize = (id: bigint, decisionHandle: `0x${string}`) =>
    run(`Reveal outcome of #${id}`, async () => {
      if (!account) return;
      const client = await handleClientFor(account);
      const { decryptionProof } = await client.publicDecrypt(decisionHandle as any);
      const wallet = makeWalletClient(account);
      const hash = await wallet.writeContract({
        address: ADDR.VeilGuardModule, abi: moduleAbi, functionName: 'finalize',
        args: [id, decryptionProof], chain: wallet.chain, account: wallet.account!,
      });
      await publicClient.waitForTransactionReceipt({ hash });
    });

  const stage = !latest ? 0 : latest.state === 1 ? (latest.decisionReady ? 2 : 1) : 3;

  if (!account) return <div className="notice">Connect a wallet to act as a delegate.</div>;
  if (!myMandate)
    return (
      <div className="notice">
        The connected account (<span className="mono">{short(account)}</span>) has no <b>active</b> spending
        mandate. Ask the finance admin to propose one and the Safe to activate it.
      </div>
    );

  const suggest = (v: string) => setAmount(v);

  return (
    <>
      <div className="notice">
        You hold mandate <b>#{String(myMandate.id)}</b>. You never see the full policy — only your own
        requests and their outcomes. The policy itself stays encrypted.
      </div>

      <div className="journey">
        <div className={`jstep ${stage >= 0 ? 'active' : ''} ${stage > 0 ? 'done' : ''}`}><b><span className="jn">1</span>Encrypt &amp; submit</b>your amount is encrypted in-browser, then sent</div>
        <div className={`jstep ${stage === 1 ? 'active' : ''} ${stage > 1 ? 'done' : ''}`}><b><span className="jn">2</span>TEE decides</b>the policy is evaluated on ciphertext (~2-6s)</div>
        <div className={`jstep ${stage === 2 ? 'active' : ''} ${stage > 2 ? 'done' : ''}`}><b><span className="jn">3</span>Finalize</b>submit the proof to reveal the outcome on-chain</div>
        <div className={`jstep ${stage === 3 ? 'active done' : ''}`}><b><span className="jn">4</span>Outcome</b>executed / escalated / blocked</div>
      </div>

      {latest && (
        <div className="latest" ref={resultRef}>
          <h4>
            {stage === 1 && <><span className="spin" /> Request #{String(latest.id)} — the TEE is deciding…</>}
            {stage === 2 && <>⚡ Request #{String(latest.id)} — decision ready</>}
            {stage === 3 && <>Request #{String(latest.id)} — done</>}
          </h4>
          <div className="lrow">
            <span className="muted" style={{ fontSize: 13 }}>
              {stage === 1 && 'Your amount stays encrypted; only a coarse outcome will ever be public.'}
              {stage === 2 && 'The gateway can prove the decision. Finalize to execute it on-chain and reveal the (still coarse) outcome.'}
              {stage === 3 && latest.state === 2 && 'Within the mandate — funds moved as a confidential transfer.'}
              {stage === 3 && latest.state === 3 && 'Above the auto-limit — held in escrow for the Safe 2-of-2 to approve.'}
              {stage === 3 && latest.state === 4 && 'Blocked — no funds moved. Decrypt the coarse reason below; a 10-minute cooldown is now active.'}
            </span>
            <div className="row">
              {stage === 2 && <button className="btn primary small" disabled={!!busy} onClick={() => finalize(latest.id, latest.decision)}>Finalize &amp; reveal →</button>}
              {stage === 3 && <RequestPill state={latest.state} />}
              {stage === 3 && latest.state === 4 && <Decrypt handle={latest.blockedReason} unit="" label="Why?" />}
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
            <button className="btn primary" disabled={!!busy || !amount} onClick={submit}>
              🔒 Encrypt &amp; submit
            </button>
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
