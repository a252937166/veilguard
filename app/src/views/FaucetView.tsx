import { useEffect, useState } from 'react';
import { ADDR, erc20Abi, fmt, scan, short, usdc, wrapperAbi } from '../config';
import { makeWalletClient, publicClient } from '../nox';
import { useApp } from '../App';

const ETH_FAUCETS = [
  { name: 'Google Cloud Faucet', note: 'Sign in with any Google account — 0.05 Sepolia ETH daily, no mainnet balance required.', url: 'https://cloud.google.com/application/web3/faucet/ethereum/sepolia', tag: 'EASIEST' },
  { name: 'pk910 PoW Faucet', note: 'No account — your browser mines for a few minutes, then you claim.', url: 'https://sepolia-faucet.pk910.de' },
  { name: 'Alchemy Faucet', note: 'Instant drop if your mainnet address holds ≥ 0.001 ETH.', url: 'https://www.alchemy.com/faucets/ethereum-sepolia' },
];

export function FaucetView() {
  const { account, run, busy, toast } = useApp();
  const [balance, setBalance] = useState<bigint>();
  const [amount, setAmount] = useState('1000');

  const refreshBalance = async () => {
    if (!account) return;
    setBalance((await publicClient.readContract({
      address: ADDR.TestUSDC, abi: erc20Abi, functionName: 'balanceOf', args: [account],
    })) as bigint);
  };
  useEffect(() => { refreshBalance(); }, [account]);

  const claim = () =>
    run(`Claim ${amount} TestUSDC`, async () => {
      if (!account) throw new Error('connect a wallet');
      const w = makeWalletClient(account);
      const hash = await w.writeContract({
        address: ADDR.TestUSDC, abi: erc20Abi, functionName: 'faucet',
        args: [usdc(Number(amount))], chain: w.chain, account: w.account!,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      await refreshBalance();
      toast(`Claimed ${amount} TestUSDC ✓`);
    });

  const wrapToTreasury = () =>
    run(`Wrap ${amount} into the Safe treasury`, async () => {
      if (!account) throw new Error('connect a wallet');
      const w = makeWalletClient(account);
      const value = usdc(Number(amount));
      const bal = (await publicClient.readContract({
        address: ADDR.TestUSDC, abi: erc20Abi, functionName: 'balanceOf', args: [account],
      })) as bigint;
      if (bal < value) throw new Error(`you only hold ${fmt(bal)} TestUSDC — claim some first`);
      const allowance = (await publicClient.readContract({
        address: ADDR.TestUSDC, abi: erc20Abi, functionName: 'allowance',
        args: [account, ADDR.ConfidentialUSDC],
      })) as bigint;
      if (allowance < value) {
        const h1 = await w.writeContract({
          address: ADDR.TestUSDC, abi: erc20Abi, functionName: 'approve',
          args: [ADDR.ConfidentialUSDC, value], chain: w.chain, account: w.account!,
        });
        await publicClient.waitForTransactionReceipt({ hash: h1 });
      }
      const h2 = await w.writeContract({
        address: ADDR.ConfidentialUSDC, abi: wrapperAbi, functionName: 'wrap',
        args: [ADDR.Safe, value], chain: w.chain, account: w.account!,
      });
      await publicClient.waitForTransactionReceipt({ hash: h2 });
      await refreshBalance();
      toast(`Wrapped ${amount} cUSDC into the treasury ✓ (the amount becomes confidential from here on)`);
    });

  return (
    <>
      <div className="notice">
        <b>Step 1 — Sepolia ETH for gas</b> (official faucets, one is enough), then
        <b> Step 2 — claim demo TestUSDC</b> in one click below. That's all you need to act as a delegate.
        Wrapping into the treasury is an optional admin-style step.
      </div>

      <div className="card">
        <h3>1 · Sepolia ETH — official faucets <small>login/captcha-gated by design — no site can claim for you</small></h3>
        <div className="tbl"><table>
          <thead><tr><th>Faucet</th><th>How it works</th><th></th></tr></thead>
          <tbody>
            {ETH_FAUCETS.map((f) => (
              <tr key={f.url}>
                <td>{f.name} {f.tag && <span className="pill ok">{f.tag}</span>}</td>
                <td className="muted">{f.note}</td>
                <td><a href={f.url} target="_blank" rel="noopener">Open ↗</a></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </div>

      <div className="card">
        <h3>2 · TestUSDC — claim in one click
          {account && balance !== undefined && <small>your balance: {fmt(balance)} tUSDC</small>}
        </h3>
        <div className="row">
          <div style={{ width: 150 }}>
            <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} min="1" max="10000" />
          </div>
          <button className="btn primary" disabled={!account || !!busy} onClick={claim}>💧 Claim TestUSDC</button>
        </div>
        <p className="muted" style={{ marginTop: 10, fontSize: 12.5 }}>
          Cap 10,000 per claim · token <a href={scan(ADDR.TestUSDC)} target="_blank" rel="noopener" className="mono">{short(ADDR.TestUSDC)}</a>.
          {!account && ' Connect a wallet first.'}
        </p>
      </div>

      <div className="card">
        <h3>3 · Optional — fund the treasury <small>wrap TestUSDC 1:1 into confidential cUSDC held by the Safe</small></h3>
        <div className="row">
          <button className="btn" disabled={!account || !!busy} onClick={wrapToTreasury}>🔒 Wrap {amount} → Safe treasury</button>
          <span className="muted" style={{ fontSize: 12.5 }}>needs TestUSDC balance ≥ amount; the treasury is already funded for the demo</span>
        </div>
        <p className="muted" style={{ marginTop: 10, fontSize: 12.5 }}>
          wrapper <a href={scan(ADDR.ConfidentialUSDC)} target="_blank" rel="noopener" className="mono">{short(ADDR.ConfidentialUSDC)}</a> ·
          wrap amounts are public at the entry point (inherent to wrappers); everything after is confidential.
        </p>
      </div>
    </>
  );
}
