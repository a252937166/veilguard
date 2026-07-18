import { useMemo, useState } from 'react';
import { keccak256, stringToBytes } from 'viem';
import { ADDR, REASON_LABEL, moduleAbi, parseUsdc, short } from '../config';
import { handleClientFor, makeWalletClient, publicClient } from '../nox';
import { useApp } from '../App';
import { Decrypt, RequestPill } from '../ui';

export function DelegateView() {
  const { account, mandates, requests, run, busy } = useApp();
  const [amount, setAmount] = useState('25');
  const [recipient, setRecipient] = useState('');
  const [memo, setMemo] = useState('');

  const myMandate = useMemo(
    () => mandates.find((m) => m.state === 2 && m.delegate.toLowerCase() === account?.toLowerCase()),
    [mandates, account],
  );
  const myRequests = useMemo(
    () => requests.filter((r) => r.delegate.toLowerCase() === account?.toLowerCase()),
    [requests, account],
  );

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
    });

  if (!account) return <div className="notice">Connect a wallet to act as a delegate.</div>;
  if (!myMandate)
    return (
      <div className="notice">
        The connected account (<span className="mono">{short(account)}</span>) has no <b>active</b> spending
        mandate. Ask the finance admin to propose one and the Safe to activate it.
      </div>
    );

  return (
    <>
      <div className="notice">
        You hold mandate <b>#{String(myMandate.id)}</b>. You never see the full policy — only your own
        requests and their outcomes. The policy itself stays encrypted.
      </div>

      <div className="grid2">
        <div className="card">
          <h3>Submit a spend request</h3>
          <label>Recipient (mandate allow-list)</label>
          <select value={recipient} onChange={(e) => setRecipient(e.target.value)}>
            {myMandate.recipients.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <label>Amount (cUSDC) — encrypted in your browser before it leaves</label>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} type="number" min="0" step="0.01" />
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
