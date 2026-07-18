import { useEffect, useState } from 'react';
import { iconSrc, isImageIcon, listWallets, type WalletInfo } from './wallet';
import { Icon } from './icons';
import { ModalDialog } from './components/ModalDialog';

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
    <ModalDialog labelledBy="connect-wallet-title" describedBy="connect-wallet-description" onClose={onClose}>
      <div className="modal-title-row">
        <h2 id="connect-wallet-title">Connect a wallet</h2>
        <button type="button" className="icon-button" aria-label="Close wallet chooser" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <p id="connect-wallet-description" className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
          Detected {wallets.length} injected wallet{wallets.length === 1 ? '' : 's'} on this browser. Pick one to
          connect — VeilGuard runs on Ethereum Sepolia.
      </p>

      {wallets.map((w, index) => (
        <button
          key={w.uuid}
          className="walletcard"
          data-dialog-initial-focus={index === 0 ? '' : undefined}
          onClick={() => onPick(w)}
        >
          <span className="walletcard-icon">
            {isImageIcon(w.icon)
              ? <img src={iconSrc(w.icon)} alt="" width={26} height={26} onError={(e) => { (e.currentTarget.style.display = 'none'); }} />
              : <Icon name="wallet" size={22} />}
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
        <button
          className="btn small trybtn"
          data-dialog-initial-focus={!wallets.length ? '' : undefined}
          onClick={() => { onClose(); onDemo(); }}
        >
          <Icon name="role" /> Try a demo role instead
        </button>
      </div>
    </ModalDialog>
  );
}
