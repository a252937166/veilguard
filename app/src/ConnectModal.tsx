import { useEffect, useState } from 'react';
import { isEmojiIcon, listWallets, type WalletInfo } from './wallet';

/** Wallet chooser (EIP-6963) — lists every detected injected wallet by its real
 *  name + icon so we never mislabel OKX as MetaMask. */
export function ConnectModal({
  onPick, onClose, onDemo,
}: {
  onPick: (w: WalletInfo) => void;
  onClose: () => void;
  onDemo: () => void;
}) {
  const [wallets, setWallets] = useState<WalletInfo[]>(listWallets());
  useEffect(() => {
    // wallets can announce a beat after mount
    const t = setInterval(() => setWallets(listWallets()), 400);
    const stop = setTimeout(() => clearInterval(t), 3000);
    return () => { clearInterval(t); clearTimeout(stop); };
  }, []);

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Connect a wallet</h3>
        <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
          Detected {wallets.length} injected wallet{wallets.length === 1 ? '' : 's'} on this browser. Pick one to
          connect — VeilGuard runs on Ethereum Sepolia.
        </p>

        {wallets.map((w) => (
          <button key={w.uuid} className="walletcard" onClick={() => onPick(w)}>
            <span className="walletcard-icon">
              {isEmojiIcon(w.icon) ? w.icon : <img src={w.icon} alt="" width={26} height={26} />}
            </span>
            <span className="walletcard-name">{w.name}</span>
            <span className="walletcard-cta">Connect →</span>
          </button>
        ))}

        {!wallets.length && (
          <div className="notice" style={{ margin: '4px 0 12px' }}>
            No browser wallet detected. Install <a href="https://metamask.io" target="_blank" rel="noopener">MetaMask</a>,{' '}
            <a href="https://www.okx.com/web3" target="_blank" rel="noopener">OKX Wallet</a> or any EIP-1193 wallet —
            or try the demo below without one.
          </div>
        )}

        <div className="row" style={{ justifyContent: 'space-between', marginTop: 14 }}>
          <span className="muted" style={{ fontSize: 12.5 }}>No wallet handy?</span>
          <button className="btn small trybtn" onClick={() => { onClose(); onDemo(); }}>⚡ Try a demo role instead</button>
        </div>
      </div>
    </div>
  );
}
