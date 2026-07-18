import { useEffect, useState } from 'react';
import { ADDR, erc20Abi, fmt, scan, short, usdc, wrapperAbi } from '../config';
import { publicClient } from '../nox';
import { walletWrite } from '../walletTx';
import { useApp } from '../App';
import { Icon } from '../icons';

const ETH_FAUCETS = [
  { name: 'Google Cloud Faucet', note: 'Sign in with any Google account — 0.05 Sepolia ETH daily, no mainnet balance required.', url: 'https://cloud.google.com/application/web3/faucet/ethereum/sepolia', tag: 'EASIEST' },
  { name: 'pk910 PoW Faucet', note: 'No account — your browser mines for a few minutes, then you claim.', url: 'https://sepolia-faucet.pk910.de' },
  { name: 'Alchemy Faucet', note: 'Instant drop if your mainnet address holds ≥ 0.001 ETH.', url: 'https://www.alchemy.com/faucets/ethereum-sepolia' },
];

export function FaucetView() {
  const { account, run, busy, toast, demoRole } = useApp();
  const [balance, setBalance] = useState<bigint>();
  const [amount, setAmount] = useState('1000');
  const injected = !demoRole;

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
      const hash = await walletWrite({
        account, address: ADDR.TestUSDC, abi: erc20Abi, functionName: 'faucet',
        args: [usdc(Number(amount))], onHint: (m) => toast(m), injected,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      await refreshBalance();
      toast(`Claimed ${amount} TestUSDC ✓`);
    });

  const wrapToTreasury = () =>
    run(`Wrap ${amount} into the Safe treasury`, async () => {
      if (!account) throw new Error('connect a wallet');
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
        const h1 = await walletWrite({
          account, address: ADDR.TestUSDC, abi: erc20Abi, functionName: 'approve',
          args: [ADDR.ConfidentialUSDC, value], onHint: (m) => toast(m), injected,
        });
        await publicClient.waitForTransactionReceipt({ hash: h1 });
      }
      const h2 = await walletWrite({
        account, address: ADDR.ConfidentialUSDC, abi: wrapperAbi, functionName: 'wrap',
        args: [ADDR.Safe, value], onHint: (m) => toast(m), injected,
      });
      await publicClient.waitForTransactionReceipt({ hash: h2 });
      await refreshBalance();
      toast(`Wrapped ${amount} cUSDC into the treasury ✓ (the amount becomes confidential from here on)`);
    });

  return (
    <>
      <header className="workspace-heading">
        <div>
          <span className="detail-kicker">Sepolia utilities</span>
          <h1>Test funds</h1>
          <p>Get gas for your wallet, claim the public test asset, or optionally fund the confidential Safe treasury.</p>
        </div>
      </header>

      <div className="notice">
        Grab <b>Sepolia ETH for gas</b> (official faucets, one is enough) and, if you like, claim demo
        <b> TestUSDC</b>. Note: claiming TestUSDC does <b>not</b> make your wallet a delegate — the module
        only accepts the delegate address fixed in a mandate. To act as a delegate, use <b>Try a role</b>
        in the top bar (a shared demo account that holds the delegate permission).
      </div>

      <div className="card">
        <h2>1 · Sepolia ETH — official faucets <small>login/captcha-gated by design — no site can claim for you</small></h2>
        <div className="tbl"><table>
          <caption className="sr-only">Official Sepolia ETH faucets</caption>
          <thead><tr><th scope="col">Faucet</th><th scope="col">How it works</th><th scope="col">Action</th></tr></thead>
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
        <h2>2 · TestUSDC — claim in one click
          {account && balance !== undefined && <small>your balance: {fmt(balance)} tUSDC</small>}
        </h2>
        <div className="row">
          <div className="faucet-amount-field">
            <label htmlFor="faucet-amount">Amount</label>
            <input id="faucet-amount" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} min="1" max="10000" />
          </div>
          <button className="btn primary" disabled={!account || !!busy} onClick={claim}><Icon name="funds" /> Claim TestUSDC</button>
        </div>
        <p className="muted" style={{ marginTop: 10, fontSize: 12.5 }}>
          Cap 10,000 per claim · token <a href={scan(ADDR.TestUSDC)} target="_blank" rel="noopener" className="mono">{short(ADDR.TestUSDC)}</a>.
          {!account && ' Connect a wallet first.'}
        </p>
      </div>

      <div className="card">
        <h2>3 · Optional — fund the treasury <small>wrap TestUSDC 1:1 into confidential cUSDC held by the Safe</small></h2>
        <div className="row">
          <button className="btn" disabled={!account || !!busy} onClick={wrapToTreasury}><Icon name="payments" /> Wrap {amount} → Safe treasury</button>
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
