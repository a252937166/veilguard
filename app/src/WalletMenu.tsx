import { useCallback, useEffect, useRef, useState } from 'react';
import { formatEther } from 'viem';
import { ADDR, erc20Abi, fmt, scan, short } from './config';
import { publicClient } from './nox';

export function WalletMenu({
  account, roleChips, chainOk, onConnect, onSwitchChain, onSwitchAccount, onDisconnect,
}: {
  account?: `0x${string}`;
  roleChips: string[];
  chainOk: boolean;
  onConnect: () => void;
  onSwitchChain: () => void;
  onSwitchAccount: () => void;
  onDisconnect: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [eth, setEth] = useState<bigint>();
  const [tusdc, setTusdc] = useState<bigint>();
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const loadBalances = useCallback(async () => {
    if (!account) return;
    try {
      const [e, t] = await Promise.all([
        publicClient.getBalance({ address: account }),
        publicClient.readContract({ address: ADDR.TestUSDC, abi: erc20Abi, functionName: 'balanceOf', args: [account] }) as Promise<bigint>,
      ]);
      setEth(e); setTusdc(t);
    } catch { /* ignore transient RPC errors */ }
  }, [account]);

  useEffect(() => {
    if (!account) { setEth(undefined); setTusdc(undefined); return; }
    loadBalances();
    const iv = setInterval(loadBalances, 12_000);
    return () => clearInterval(iv);
  }, [account, loadBalances]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const copy = async () => {
    if (!account) return;
    await navigator.clipboard.writeText(account);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  if (!account) return <button className="btn primary" onClick={onConnect}>Connect wallet</button>;

  return (
    <div className="wallet" ref={ref}>
      {!chainOk && <button className="btn small wrongnet" onClick={onSwitchChain}>⚠ Wrong network — switch to Sepolia</button>}
      <button className={`wallet-btn ${open ? 'open' : ''}`} onClick={() => setOpen((o) => !o)}>
        <span className={`netdot ${chainOk ? 'ok' : 'bad'}`} />
        <span className="wallet-eth">{eth !== undefined ? `${Number(formatEther(eth)).toFixed(3)} ETH` : '…'}</span>
        <span className="wallet-addr mono">{short(account)}</span>
        <span className="caret">▾</span>
      </button>

      {open && (
        <div className="wallet-pop">
          <div className="wp-head">
            <div className="wp-roles">
              {roleChips.map((r) => <span key={r} className="pill tee">{r}</span>)}
            </div>
            <button className="wp-copy" onClick={copy} title="Copy address">
              <span className="mono">{short(account)}</span> {copied ? '✓' : '⧉'}
            </button>
          </div>

          <div className="wp-balances">
            <div className="wp-bal">
              <span className="wp-bal-label">Sepolia ETH</span>
              <span className="wp-bal-val">{eth !== undefined ? Number(formatEther(eth)).toFixed(4) : '…'}</span>
            </div>
            <div className="wp-bal">
              <span className="wp-bal-label">TestUSDC</span>
              <span className="wp-bal-val">{tusdc !== undefined ? fmt(tusdc) : '…'}</span>
            </div>
          </div>

          {eth !== undefined && eth === 0n && (
            <div className="wp-warn">No gas — grab Sepolia ETH from the faucets to transact.</div>
          )}

          <div className="wp-actions">
            <button className="wp-act" onClick={() => { loadBalances(); }}>↻ Refresh balances</button>
            <button className="wp-act" onClick={() => { setOpen(false); onSwitchAccount(); }}>⇄ Switch account</button>
            <a className="wp-act" href={scan(account)} target="_blank" rel="noopener" onClick={() => setOpen(false)}>↗ View on Etherscan</a>
            <button className="wp-act danger" onClick={() => { setOpen(false); onDisconnect(); }}>⏻ Disconnect</button>
          </div>
        </div>
      )}
    </div>
  );
}
