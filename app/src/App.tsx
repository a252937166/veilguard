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
  const tour = useTour();

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

  // wallet
  const connect = useCallback(async () => {
    const eth = (window as any).ethereum;
    if (!eth) { toast('No EIP-1193 wallet found — install MetaMask.', true); return; }
    const [acct] = await eth.request({ method: 'eth_requestAccounts' });
    setAccount(acct);
    setChainId(Number(await eth.request({ method: 'eth_chainId' })));
  }, [toast]);

  const switchChain = useCallback(async () => {
    const eth = (window as any).ethereum;
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
    const eth = (window as any).ethereum;
    if (!eth) return;
    try {
      await eth.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] });
      const [acct] = await eth.request({ method: 'eth_requestAccounts' });
      setAccount(acct);
    } catch (e: any) {
      if (e?.code !== 4001) toast(`Switch account failed: ${e?.message ?? e}`, true);
    }
  }, [toast]);

  const disconnect = useCallback(async () => {
    const eth = (window as any).ethereum;
    try { await eth?.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] }); }
    catch { /* not all wallets support revoke — clearing local state still disconnects the UI */ }
    setAccount(undefined);
    toast('Wallet disconnected from VeilGuard.');
  }, [toast]);

  useEffect(() => {
    const eth = (window as any).ethereum;
    if (!eth) return;
    eth.request({ method: 'eth_accounts' }).then((a: string[]) => a[0] && setAccount(a[0] as `0x${string}`));
    eth.request({ method: 'eth_chainId' }).then((c: string) => setChainId(Number(c)));
    const onAcct = (a: string[]) => setAccount(a[0] as `0x${string}` | undefined);
    const onChain = (c: string) => setChainId(Number(c));
    eth.on?.('accountsChanged', onAcct);
    eth.on?.('chainChanged', onChain);
    return () => { eth.removeListener?.('accountsChanged', onAcct); eth.removeListener?.('chainChanged', onChain); };
  }, []);

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
        if (!stop) { setMandates(ms); setRequests(rs); setOwners(own); setPaused(isPaused); }
      } catch (e) { console.error('poll', e); }
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
  const chainOk = chainId === CHAIN_ID;

  const roleChips = useMemo(() => {
    const roles: string[] = [];
    if (isAdmin) roles.push('FINANCE ADMIN');
    if (isOwner) roles.push('SAFE SIGNER');
    if (isDelegate) roles.push('DELEGATE');
    if (isAuditor) roles.push('AUDITOR');
    return roles.length ? roles : ['OBSERVER'];
  }, [isAdmin, isOwner, isDelegate, isAuditor]);

  const ctx: Ctx = { account, chainOk, owners, paused, mandates, requests, refresh, toast, run, busy };

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
              <button className="btn ghost" onClick={() => launch(false)}>Open app</button>
              <button className="btn primary" onClick={() => launch(true)}>▶ Guided demo</button>
            </div>
          </div>
          <Landing onLaunch={() => launch(true)} />
          <footer>
            <div>VEILGUARD — confidential treasury controls on <a href="https://safe.global" target="_blank" rel="noopener">Safe</a> · powered by <a href="https://docs.noxprotocol.io" target="_blank" rel="noopener">iExec Nox</a></div>
            <div>Ethereum Sepolia · testnet prototype — not audited</div>
          </footer>
        </div>
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
            <button className="btn small faucetbtn" onClick={() => setTab('Get Funds')}>💧 Get test funds</button>
            <WalletMenu
              account={account}
              roleChips={roleChips}
              chainOk={chainOk}
              onConnect={connect}
              onSwitchChain={switchChain}
              onSwitchAccount={switchAccount}
              onDisconnect={disconnect}
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

        {busy && <div className="notice"><span className="spin" /> &nbsp;<b>{busy}</b> — confirm in your wallet / waiting for the chain…</div>}

        {tab === 'Dashboard' && <PublicView />}
        {tab === 'Delegate' && <DelegateView />}
        {tab === 'Admin' && <AdminView />}
        {tab === 'Signer' && <SignerView />}
        {tab === 'Auditor' && <AuditorView />}
        {tab === 'Get Funds' && <FaucetView />}

        <footer>
          <div>VEILGUARD — confidential treasury controls on <a href="https://safe.global" target="_blank" rel="noopener">Safe</a> · powered by <a href="https://docs.noxprotocol.io" target="_blank" rel="noopener">iExec Nox</a></div>
          <div><a href={`https://sepolia.etherscan.io/address/${ADDR.VeilGuardModule}`} target="_blank" rel="noopener">Module ↗</a> · <a href={`https://sepolia.etherscan.io/address/${ADDR.Safe}`} target="_blank" rel="noopener">Safe ↗</a> · Testnet prototype — not audited</div>
        </footer>
      </div>
      {toastMsg && <div className={`toast ${toastMsg.err ? 'err' : ''}`}>{toastMsg.msg}</div>}
    </AppCtx.Provider>
  );
}
