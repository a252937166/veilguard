import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ADDR, CHAIN_ID, ROLES, moduleAbi, safeAbi, short } from './config';
import { handlesResolved, publicClient } from './nox';
import { PublicView } from './views/PublicView';
import { DelegateView } from './views/DelegateView';
import { AdminView } from './views/AdminView';
import { SignerView } from './views/SignerView';
import { AuditorView } from './views/AuditorView';
import { FaucetView } from './views/FaucetView';
import { Landing } from './views/Landing';
import { GuidedTour, useTour, type TabName } from './GuidedTour';
import { WalletMenu } from './WalletMenu';
import { ConnectModal } from './ConnectModal';
import { DEMO_ROLES, demoAddress, type DemoRole } from './demo';
import { getActiveProvider, setActiveProvider } from './nox';
import { listWallets, onWalletsChanged, type WalletInfo } from './wallet';
import evidence from './demo-evidence.json';

const EVIDENCE_COMMIT = evidence.commit;

export type Mandate = {
  id: bigint; delegate: `0x${string}`; validFrom: bigint; validUntil: bigint;
  version: number; state: number; autoLimit: `0x${string}`; budgetLeft: `0x${string}`;
  reserveFloor: `0x${string}`; recipients: `0x${string}`[];
};
export type SpendRequest = {
  id: bigint; mandateId: bigint; delegate: `0x${string}`; recipient: `0x${string}`;
  memoHash: `0x${string}`; createdAt: bigint; state: number;
  amount: `0x${string}`; decision: `0x${string}`; blockedReason: `0x${string}`;
  decisionReady?: boolean;
};

type Ctx = {
  account?: `0x${string}`;
  chainOk: boolean;
  owners: `0x${string}`[];
  paused: boolean;
  mandates: Mandate[];
  requests: SpendRequest[];
  refresh: () => void;
  toast: (msg: string, err?: boolean) => void;
  run: (label: string, fn: () => Promise<void>) => Promise<void>;
  busy: string | null;
  demoRole: DemoRole | null;
  startDemo: (role: DemoRole) => void;
  openRolePicker: () => void;
  goTab: (tab: string) => void;
};
const AppCtx = createContext<Ctx>(null as any);
export const useApp = () => useContext(AppCtx);

const TABS = ['Dashboard', 'Delegate', 'Admin', 'Signer', 'Auditor', 'Get Funds'] as const;

export function App() {
  const [stage, setStage] = useState<'landing' | 'app'>(
    typeof window !== 'undefined' && window.location.hash === '#app' ? 'app' : 'landing',
  );
  const [account, setAccount] = useState<`0x${string}`>();
  const [chainId, setChainId] = useState<number>();
  const [tab, setTab] = useState<(typeof TABS)[number]>('Dashboard');
  const [demoRole, setDemoRole] = useState<DemoRole | null>(null);
  const [tryOpen, setTryOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [walletInfo, setWalletInfo] = useState<WalletInfo | null>(null);
  const tour = useTour();

  const enterDemo = useCallback((role: DemoRole) => {
    setDemoRole(role);
    setAccount(demoAddress(role));
    setTryOpen(false);
    setTab(role === 'delegate' ? 'Delegate' : 'Auditor');
  }, []);

  const exitDemo = useCallback(() => {
    setDemoRole(null);
    setAccount(undefined);
  }, []);

  const launch = useCallback((withTour: boolean) => {
    window.location.hash = '#app';
    setStage('app');
    if (withTour) tour.start();
  }, [tour]);
  const [mandates, setMandates] = useState<Mandate[]>([]);
  const [requests, setRequests] = useState<SpendRequest[]>([]);
  const [owners, setOwners] = useState<`0x${string}`[]>([]);
  const [paused, setPaused] = useState(false);
  const [toastMsg, setToastMsg] = useState<{ msg: string; err: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [loadError, setLoadError] = useState(false);
  const toastTimer = useRef<any>(null);

  const toast = useCallback((msg: string, err = false) => {
    setToastMsg({ msg, err });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), err ? 9000 : 5000);
  }, []);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const run = useCallback(async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
      refresh();
    } catch (e: any) {
      console.error(e);
      toast(`${label} failed: ${e?.shortMessage ?? e?.message ?? e}`, true);
    } finally {
      setBusy(null);
    }
  }, [refresh, toast]);

  // wallet — open the picker (EIP-6963 multi-wallet)
  const connect = useCallback(() => {
    if (!listWallets().length) { setTryOpen(true); return; } // no wallet → offer demo mode
    setConnectOpen(true);
  }, []);

  // connect to a SPECIFIC detected wallet
  const connectWallet = useCallback(async (w: WalletInfo) => {
    try {
      setActiveProvider(w.provider);
      setDemoRole(null);
      const accts = (await w.provider.request({ method: 'eth_requestAccounts' })) as string[];
      if (!accts?.[0]) return;
      setAccount(accts[0] as `0x${string}`);
      setChainId(Number(await w.provider.request({ method: 'eth_chainId' })));
      setWalletInfo(w);
      setConnectOpen(false);
    } catch (e: any) {
      if (e?.code !== 4001) toast(`Connect failed: ${e?.shortMessage ?? e?.message ?? e}`, true);
    }
  }, [toast]);

  const switchChain = useCallback(async () => {
    const eth = getActiveProvider();
    if (!eth) return;
    try {
      await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xaa36a7' }] });
    } catch (e: any) {
      if (e?.code === 4902) {
        await eth.request({ method: 'wallet_addEthereumChain', params: [{
          chainId: '0xaa36a7', chainName: 'Sepolia',
          nativeCurrency: { name: 'Sepolia ETH', symbol: 'ETH', decimals: 18 },
          rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com'],
          blockExplorerUrls: ['https://sepolia.etherscan.io'],
        }] });
      }
    }
    setChainId(Number(await eth.request({ method: 'eth_chainId' })));
  }, []);

  const switchAccount = useCallback(async () => {
    const eth = getActiveProvider();
    if (!eth) return;
    try {
      await eth.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] });
      const accts = (await eth.request({ method: 'eth_requestAccounts' })) as string[];
      setAccount(accts[0] as `0x${string}`);
    } catch (e: any) {
      if (e?.code !== 4001) toast(`Switch account failed: ${e?.message ?? e}`, true);
    }
  }, [toast]);

  const disconnect = useCallback(async () => {
    const eth = getActiveProvider();
    try { await eth?.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] }); }
    catch { /* not all wallets support revoke — clearing local state still disconnects the UI */ }
    setAccount(undefined);
    setWalletInfo(null);
    setActiveProvider(undefined);
    toast('Wallet disconnected from VeilGuard.');
  }, [toast]);

  // re-render wallet picker as wallets announce themselves
  useEffect(() => onWalletsChanged(() => setConnectOpen((o) => o)), []);

  // subscribe to the active provider's events once connected
  useEffect(() => {
    const eth = walletInfo?.provider;
    if (!eth) return;
    const onAcct = (a: string[]) => {
      setDemoRole((dr) => { if (!dr) { setAccount(a[0] as `0x${string}` | undefined); if (!a[0]) setWalletInfo(null); } return dr; });
    };
    const onChain = (c: string) => setChainId(Number(c));
    eth.on?.('accountsChanged', onAcct);
    eth.on?.('chainChanged', onChain);
    return () => { eth.removeListener?.('accountsChanged', onAcct); eth.removeListener?.('chainChanged', onChain); };
  }, [walletInfo]);

  // chain polling
  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const [nextM, nextR, own, isPaused] = await Promise.all([
          publicClient.readContract({ address: ADDR.VeilGuardModule, abi: moduleAbi, functionName: 'nextMandateId' }) as Promise<bigint>,
          publicClient.readContract({ address: ADDR.VeilGuardModule, abi: moduleAbi, functionName: 'nextRequestId' }) as Promise<bigint>,
          publicClient.readContract({ address: ADDR.Safe, abi: safeAbi, functionName: 'getOwners' }) as Promise<`0x${string}`[]>,
          publicClient.readContract({ address: ADDR.VeilGuardModule, abi: moduleAbi, functionName: 'paused' }) as Promise<boolean>,
        ]);
        const ms: Mandate[] = [];
        for (let i = 1n; i < nextM; i++) {
          const m = (await publicClient.readContract({
            address: ADDR.VeilGuardModule, abi: moduleAbi, functionName: 'getMandate', args: [i],
          })) as any[];
          ms.push({ id: i, delegate: m[0], validFrom: m[1], validUntil: m[2], version: Number(m[3]), state: Number(m[4]), autoLimit: m[5], budgetLeft: m[6], reserveFloor: m[7], recipients: m[8] });
        }
        const rs: SpendRequest[] = [];
        for (let i = 1n; i < nextR; i++) {
          const r = (await publicClient.readContract({
            address: ADDR.VeilGuardModule, abi: moduleAbi, functionName: 'getRequest', args: [i],
          })) as any[];
          rs.push({ id: i, mandateId: r[0], delegate: r[1], recipient: r[2], memoHash: r[3], createdAt: r[4], state: Number(r[5]), amount: r[6], decision: r[7], blockedReason: r[8] });
        }
        // TEE resolution status for pending requests
        const pending = rs.filter((r) => r.state === 1);
        if (pending.length) {
          await Promise.all(pending.map(async (r) => {
            r.decisionReady = await handlesResolved([r.decision]);
          }));
        }
        if (!stop) { setMandates(ms); setRequests(rs); setOwners(own); setPaused(isPaused); setLastUpdated(Date.now()); setLoadError(false); }
      } catch (e) { console.error('poll', e); if (!stop) setLoadError(true); }
    };
    load();
    const iv = setInterval(load, 10_000);
    return () => { stop = true; clearInterval(iv); };
  }, [tick]);

  const lc = account?.toLowerCase();
  const isAdmin = lc === ROLES.financeAdmin.toLowerCase();
  const isOwner = owners.some((o) => o.toLowerCase() === lc);
  const isDelegate = mandates.some((m) => m.delegate.toLowerCase() === lc);
  const isAuditor = lc === ROLES.auditor.toLowerCase();
  // demo accounts sign locally on Sepolia — the injected wallet's chain is irrelevant
  const chainOk = demoRole ? true : chainId === CHAIN_ID;
  const noRole = !!account && !isAdmin && !isOwner && !isDelegate && !isAuditor;

  const roleChips = useMemo(() => {
    const roles: string[] = [];
    if (isAdmin) roles.push('FINANCE ADMIN');
    if (isOwner) roles.push('SAFE SIGNER');
    if (isDelegate) roles.push('DELEGATE');
    if (isAuditor) roles.push('AUDITOR');
    return roles.length ? roles : ['OBSERVER'];
  }, [isAdmin, isOwner, isDelegate, isAuditor]);

  const ctx: Ctx = { account, chainOk, owners, paused, mandates, requests, refresh, toast, run, busy, demoRole, startDemo: enterDemo, openRolePicker: () => setTryOpen(true), goTab: (t) => setTab(t as any) };

  const tryModal = tryOpen && (
    <div className="modal-back" onClick={() => setTryOpen(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>⚡ Try VeilGuard instantly</h3>
        <p className="muted" style={{ fontSize: 13.5, marginBottom: 14 }}>
          Pick a demo role — a shared, gas-sponsored testnet account with that role's on-chain
          permissions. No wallet, no setup. (The powerful roles — finance admin and Safe signer —
          are deliberately not public.)
        </p>
        {(Object.keys(DEMO_ROLES) as DemoRole[]).map((r) => (
          <button key={r} className="rolecard" onClick={() => { if (stage === 'landing') launch(false); enterDemo(r); }}>
            <span className="rolecard-icon">{DEMO_ROLES[r].icon}</span>
            <span>
              <b>Act as {DEMO_ROLES[r].label}</b>
              <small>{DEMO_ROLES[r].blurb}</small>
            </span>
          </button>
        ))}
        <div className="try-divider"><span>or use your own wallet</span></div>
        <button className="btn primary wide" onClick={() => { setTryOpen(false); if (stage === 'landing') launch(false); connect(); }}>
          🔗 Connect my wallet
        </button>
        <p className="muted" style={{ fontSize: 12, marginTop: 8, textAlign: 'center' }}>
          MetaMask, OKX, Rabby, Coinbase… — you'll be able to get your wallet provisioned as a delegate and sign with it yourself.
        </p>
      </div>
    </div>
  );

  if (stage === 'landing') {
    return (
      <AppCtx.Provider value={ctx}>
        <div className="wrap">
          <div className="topbar">
            <div>
              <div className="logo">VEIL<span>GUARD</span></div>
              <div className="tagline">Confidential spending policies for Safe treasuries · Ethereum Sepolia · powered by iExec Nox</div>
            </div>
            <div className="row">
              <button className="btn ghost" onClick={() => setTryOpen(true)}>⚡ Try a role</button>
              <button className="btn ghost" onClick={() => launch(false)}>Open app</button>
              <button className="btn primary" onClick={() => launch(true)}>▶ Guided demo</button>
            </div>
          </div>
          <Landing onLaunch={() => launch(true)} onTry={() => setTryOpen(true)} />
          <footer>
            <div>VEILGUARD — confidential treasury controls on <a href="https://safe.global" target="_blank" rel="noopener">Safe</a> · powered by <a href="https://docs.noxprotocol.io" target="_blank" rel="noopener">iExec Nox</a></div>
            <div>Ethereum Sepolia · testnet prototype — not audited</div>
          </footer>
        </div>
        {tryModal}
      </AppCtx.Provider>
    );
  }

  return (
    <AppCtx.Provider value={ctx}>
      <div className="wrap">
        <div className="topbar">
          <div className="row" style={{ gap: 14 }}>
            <button className="logolink" onClick={() => { window.location.hash = ''; setStage('landing'); }} title="Back to overview">
              <span className="logo">VEIL<span>GUARD</span></span>
            </button>
            {!tour.active && <button className="btn small ghost" onClick={tour.start}>✦ Guided demo</button>}
          </div>
          <div className="row">
            {paused && <span className="pill bad">PAUSED</span>}
            {!demoRole && <button className="btn small trybtn" onClick={() => setTryOpen(true)}>⚡ Try a role</button>}
            <button className="btn small faucetbtn" onClick={() => setTab('Get Funds')}>💧 Get test funds</button>
            <WalletMenu
              account={account}
              roleChips={demoRole ? [`DEMO · ${DEMO_ROLES[demoRole].label.toUpperCase()}`] : roleChips}
              chainOk={chainOk}
              wallet={walletInfo}
              isDemo={!!demoRole}
              onConnect={connect}
              onSwitchChain={switchChain}
              onSwitchAccount={demoRole ? () => setTryOpen(true) : switchAccount}
              onDisconnect={demoRole ? exitDemo : disconnect}
            />
          </div>
        </div>

        {tour.active && (
          <GuidedTour
            step={tour.step}
            setStep={tour.setStep}
            onGoToTab={(t: TabName) => setTab(t)}
            onClose={tour.close}
          />
        )}

        <div className="tabs">
          {TABS.map((t) => (
            <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
              {t}
              {t === 'Delegate' && isDelegate && <span className="rolechip">●</span>}
              {t === 'Admin' && isAdmin && <span className="rolechip">●</span>}
              {t === 'Signer' && isOwner && <span className="rolechip">●</span>}
              {t === 'Auditor' && isAuditor && <span className="rolechip">●</span>}
            </button>
          ))}
        </div>

        {busy && <div className="notice"><span className="spin" /> &nbsp;<b>{busy}</b> — {demoRole ? 'signing locally, waiting for the chain…' : 'confirm in your wallet / waiting for the chain…'}</div>}

        {demoRole && (
          <div className="demobar">
            <span>{DEMO_ROLES[demoRole].icon} You are the <b>{DEMO_ROLES[demoRole].label}</b> (shared demo account, gas sponsored) — {DEMO_ROLES[demoRole].blurb}</span>
            <button className="btn small ghost" onClick={() => setTryOpen(true)}>switch role</button>
          </div>
        )}

        {noRole && !demoRole && (
          <div className="notice">
            <b>Your wallet holds no role in this treasury</b> — that's by design: every number is gated by
            on-chain ACLs. You can still <b>finalize</b> pending requests and use the 💧 faucet.
            To experience the full loop, <button className="btn small primary" style={{ margin: '0 6px' }}
              onClick={() => setTryOpen(true)}>⚡ try a demo role</button> — no setup needed.
          </div>
        )}

        {tab === 'Dashboard' && <PublicView />}
        {tab === 'Delegate' && <DelegateView />}
        {tab === 'Admin' && <AdminView />}
        {tab === 'Signer' && <SignerView />}
        {tab === 'Auditor' && <AuditorView />}
        {tab === 'Get Funds' && <FaucetView />}

        <footer>
          <div>
            VEILGUARD — confidential treasury controls on <a href="https://safe.global" target="_blank" rel="noopener">Safe</a> · powered by <a href="https://docs.noxprotocol.io" target="_blank" rel="noopener">iExec Nox</a>
            <br />
            <span className="mono" style={{ fontSize: 11.5 }}>
              {loadError ? <span style={{ color: 'var(--warn)' }}>⚠ chain read failing — showing last known state</span>
                : lastUpdated ? `chain synced ${Math.round((Date.now() - lastUpdated) / 1000)}s ago` : 'loading…'}
            </span>
          </div>
          <div>
            <a href="https://github.com/a252937166/veilguard" target="_blank" rel="noopener">GitHub ↗</a> ·
            {' '}<a href={`https://sepolia.etherscan.io/address/${ADDR.VeilGuardModule}`} target="_blank" rel="noopener">Module ↗</a> ·
            {' '}<a href={`https://sepolia.etherscan.io/address/${ADDR.Safe}`} target="_blank" rel="noopener">Safe ↗</a> ·
            {' '}<span className="mono">{EVIDENCE_COMMIT}</span> · Testnet prototype — not audited
          </div>
        </footer>
      </div>
      {tryModal}
      {connectOpen && <ConnectModal onPick={connectWallet} onClose={() => setConnectOpen(false)} onDemo={() => setTryOpen(true)} />}
      {toastMsg && <div className={`toast ${toastMsg.err ? 'err' : ''}`}>{toastMsg.msg}</div>}
    </AppCtx.Provider>
  );
}
