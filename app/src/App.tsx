import { Suspense, createContext, lazy, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ADDR, CHAIN_ID, ROLES, moduleAbi, safeAbi, short } from './config';
import { handlesResolved, publicClient } from './nox';
import { Landing } from './views/Landing';
import { MissionDrawer } from './GuidedTour';
import { WalletMenu } from './WalletMenu';
import { Logo } from './Logo';
import { WaveField } from './WaveField';
import { ConnectModal } from './ConnectModal';
import { DEMO_ROLES, demoAddress, type DemoRole } from './demo';
import { getActiveProvider, setActiveProvider } from './nox';
import { listWallets, onWalletsChanged, type WalletInfo } from './wallet';
import evidence from './demo-evidence.json';
import {
  createDemoSession,
  demoCompleted,
  demoSessionReducer,
  loadDemoSession,
  saveDemoSession,
  type DemoSessionAction,
  type DemoSessionV2,
} from './demo-session';
import {
  DEFAULT_APP_ROUTE,
  appRouteLabel,
  formatAppRoute,
  legacyTabToRoute,
  parseAppHash,
  selectionFromRoute,
  type AppRoute,
  type LegacyTabName,
} from './routes';
import { Icon, type IconName } from './icons';
import { ModalDialog } from './components/ModalDialog';
import { runBoundScenarioRequests } from './demo-scenarios';
import { reconcileRunBoundMissionEvidence } from './mission-recovery';
import { OperationCoordinator, type OperationSpec } from './operation-lock';
import { chainSnapshotFingerprint, changedRequestIds as diffChangedRequestIds, requestStateSnapshot } from './chain-refresh';

const EVIDENCE_COMMIT = evidence.commit;

const PublicView = lazy(() => import('./views/PublicView').then((module) => ({ default: module.PublicView })));
const DelegateView = lazy(() => import('./views/DelegateView').then((module) => ({ default: module.DelegateView })));
const SignerView = lazy(() => import('./views/SignerView').then((module) => ({ default: module.SignerView })));
const AuditorView = lazy(() => import('./views/AuditorView').then((module) => ({ default: module.AuditorView })));
const FaucetView = lazy(() => import('./views/FaucetView').then((module) => ({ default: module.FaucetView })));
const VerifyView = lazy(() => import('./views/VerifyView').then((module) => ({ default: module.VerifyView })));
const PoliciesView = lazy(() => import('./views/PoliciesView').then((module) => ({ default: module.PoliciesView })));
const DisclosureView = lazy(() => import('./views/DisclosureView').then((module) => ({ default: module.DisclosureView })));
const TrustCenterView = lazy(() => import('./views/TrustCenterView').then((module) => ({ default: module.TrustCenterView })));
const NotFoundView = lazy(() => import('./views/NotFoundView').then((module) => ({ default: module.NotFoundView })));

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
  financeAdmin?: `0x${string}`;
  chainOk: boolean;
  owners: `0x${string}`[];
  paused: boolean;
  mandates: Mandate[];
  requests: SpendRequest[];
  refresh: () => Promise<ChainRefreshResult>;
  toast: (msg: string, err?: boolean) => void;
  run: (operation: string | OperationSpec, fn: () => Promise<void>) => Promise<OperationRunResult>;
  busy: string | null;
  demoRole: DemoRole | null;
  startDemo: (role: DemoRole) => void;
  openRolePicker: () => void;
  goTab: (tab: string) => void;
  lastUpdated: number | null;
  loadError: boolean;
};

export type ChainRefreshResult =
  | { status: 'changed' | 'unchanged'; checkedAt: number; changedRequestIds: string[] }
  | { status: 'failed'; checkedAt: number; message: string; changedRequestIds: [] };

export type OperationRunResult =
  | { accepted: true; status: 'succeeded' | 'failed' }
  | { accepted: false; status: 'blocked'; blocker: { key: string; label: string; startedAt: number } };
const AppCtx = createContext<Ctx>(null as any);
export const useApp = () => useContext(AppCtx);

const TABS = ['Dashboard', 'Delegate', 'Admin', 'Signer', 'Auditor', 'Verify', 'Get Funds'] as const satisfies readonly LegacyTabName[];

export function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const parsedRoute = useMemo(() => parseAppHash(`#${location.pathname}`), [location.pathname]);
  const stage: 'landing' | 'app' = parsedRoute ? 'app' : 'landing';
  const route = parsedRoute ?? DEFAULT_APP_ROUTE;
  const [account, setAccount] = useState<`0x${string}`>();
  const [chainId, setChainId] = useState<number>();
  const [demoRole, setDemoRole] = useState<DemoRole | null>(null);
  const [tryOpen, setTryOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [walletInfo, setWalletInfo] = useState<WalletInfo | null>(null);
  const [demoSession, setDemoSession] = useState<DemoSessionV2 | null>(() => loadDemoSession());
  const [resumeOpen, setResumeOpen] = useState(false);
  const [restartBusy, setRestartBusy] = useState(false);
  const startupChecked = useRef(false);

  const goRoute = useCallback((target: AppRoute, options: { replace?: boolean } = {}) => {
    navigate(formatAppRoute(target).slice(1), options);
  }, [navigate]);

  const dispatchDemo = useCallback((action: DemoSessionAction) => {
    setDemoSession((current) => {
      if (!current) return current;
      // React may execute this updater while rendering App's routed children.
      // Keep it pure: saveDemoSession emits a synchronous window event and
      // must only run after the render has committed.
      return demoSessionReducer(current, action);
    });
  }, []);

  useEffect(() => {
    if (!demoSession) return;
    const persisted = loadDemoSession();
    if (persisted && JSON.stringify(persisted) === JSON.stringify(demoSession)) return;
    saveDemoSession(demoSession);
  }, [demoSession]);

  useEffect(() => {
    const sync = () => setDemoSession(loadDemoSession());
    window.addEventListener('vg-demo-session', sync);
    window.addEventListener('vg-missions', sync);
    return () => {
      window.removeEventListener('vg-demo-session', sync);
      window.removeEventListener('vg-missions', sync);
    };
  }, []);

  useEffect(() => {
    if (!demoSession || stage !== 'app') return;
    dispatchDemo({
      type: 'NAVIGATE', runId: demoSession.runId,
      route, selected: selectionFromRoute(route),
    });
    // Route changes are the only trigger; the session event emitted by the
    // reducer must not create a navigation feedback loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  const enterDemo = useCallback((role: DemoRole) => {
    setDemoRole(role);
    setAccount(demoAddress(role));
    setTryOpen(false);
    if (demoSession) dispatchDemo({ type: 'SET_ROLE', runId: demoSession.runId, role });
    try { sessionStorage.setItem('vg_demo', role); } catch { /* ignore */ }
  }, [demoSession, dispatchDemo]);

  const exitDemo = useCallback(() => {
    setDemoRole(null);
    setAccount(undefined);
    try { sessionStorage.removeItem('vg_demo'); } catch { /* ignore */ }
  }, []);

  const startFreshDemo = useCallback(() => {
    // A fresh run is already the result of an explicit launch decision. Mark
    // the one-time startup recovery check as handled before navigation so the
    // route effect cannot mistake this newly saved session for stale work.
    startupChecked.current = true;
    try { sessionStorage.removeItem('vg_track'); } catch { /* ignore */ }
    const next = createDemoSession({ route: { page: 'payment-inbox' }, role: 'delegate', tourActive: true });
    saveDemoSession(next);
    setDemoSession(next);
    setResumeOpen(false);
    enterDemo('delegate');
    goRoute(next.route);
  }, [enterDemo, goRoute]);

  useEffect(() => {
    if (stage !== 'app' || startupChecked.current) return;
    startupChecked.current = true;
    const existing = loadDemoSession();
    if (existing && !demoCompleted(existing) && existing.lifecycle !== 'completed') {
      setDemoSession(existing);
      setResumeOpen(true);
    }
  }, [stage]);

  const launch = useCallback((withTour: boolean, target?: LegacyTabName) => {
    if (withTour) {
      const existing = loadDemoSession();
      const hasProgress = !!existing && (
        existing.tour.active
        || Object.values(existing.missions).some((mission) => mission.requestId || mission.packetIds.length)
      );
      if (existing && !demoCompleted(existing) && hasProgress) {
        setDemoSession(existing);
        setResumeOpen(true);
        goRoute(existing.route);
        return;
      }
      startFreshDemo();
      return;
    }
    goRoute(target ? legacyTabToRoute(target) : DEFAULT_APP_ROUTE);
  }, [goRoute, startFreshDemo]);
  const [mandates, setMandates] = useState<Mandate[]>([]);
  const [requests, setRequests] = useState<SpendRequest[]>([]);
  const [owners, setOwners] = useState<`0x${string}`[]>([]);
  const [financeAdmin, setFinanceAdmin] = useState<`0x${string}`>();
  const [paused, setPaused] = useState(false);
  const [toastMsg, setToastMsg] = useState<{ msg: string; err: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [loadError, setLoadError] = useState(false);
  const toastTimer = useRef<any>(null);
  const operationCoordinator = useRef(new OperationCoordinator());
  const lastToast = useRef<{ msg: string; at: number } | null>(null);
  const chainRefresh = useRef<(() => Promise<ChainRefreshResult>) | null>(null);

  const toast = useCallback((msg: string, err = false) => {
    const now = Date.now();
    if (lastToast.current?.msg === msg && now - lastToast.current.at < 1_500) return;
    lastToast.current = { msg, at: now };
    setToastMsg({ msg, err });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), err ? 9000 : 5000);
  }, []);

  const refresh = useCallback((): Promise<ChainRefreshResult> => (
    chainRefresh.current?.() ?? Promise.resolve({
      status: 'failed', checkedAt: Date.now(), message: 'Chain reader is not ready yet.', changedRequestIds: [],
    })
  ), []);

  const run = useCallback(async (input: string | OperationSpec, fn: () => Promise<void>): Promise<OperationRunResult> => {
    const operation: OperationSpec = typeof input === 'string'
      ? {
          key: input,
          label: input,
          resources: account ? [`wallet:${account.toLowerCase()}`] : ['wallet:unconnected'],
          feedback: 'global',
        }
      : input;
    const acquired = operationCoordinator.current.acquire(operation);
    if (!acquired.acquired) {
      toast(`${acquired.blocker.label} is still running. Return to that operation before starting another conflicting action.`, true);
      return {
        accepted: false,
        status: 'blocked',
        blocker: {
          key: acquired.blocker.key,
          label: acquired.blocker.label,
          startedAt: acquired.blocker.startedAt,
        },
      };
    }
    if (acquired.operation.feedback === 'global') setBusy(acquired.operation.label);
    try {
      await fn();
      void refresh();
      return { accepted: true, status: 'succeeded' };
    } catch (e: any) {
      console.error(e);
      toast(`${acquired.operation.label} failed: ${e?.shortMessage ?? e?.message ?? e}`, true);
      return { accepted: true, status: 'failed' };
    } finally {
      if (acquired.operation.feedback === 'global') setBusy(null);
      operationCoordinator.current.release(acquired.operation);
    }
  }, [account, refresh, toast]);

  // wallet — open the picker (EIP-6963 multi-wallet)
  const connect = useCallback(() => {
    if (!listWallets().length) { setTryOpen(true); return; } // no wallet → offer demo mode
    setConnectOpen(true);
  }, []);

  // connect to a SPECIFIC detected wallet
  const connectWallet = useCallback(async (w: WalletInfo, silent = false) => {
    try {
      setActiveProvider(w.provider);
      setDemoRole(null);
      const accts = (await w.provider.request({ method: silent ? 'eth_accounts' : 'eth_requestAccounts' })) as string[];
      if (!accts?.[0]) return false;
      setAccount(accts[0] as `0x${string}`);
      setChainId(Number(await w.provider.request({ method: 'eth_chainId' })));
      setWalletInfo(w);
      setConnectOpen(false);
      try { localStorage.setItem('vg_wallet', w.rdns ?? w.uuid); } catch { /* ignore */ }
      return true;
    } catch (e: any) {
      if (!silent && e?.code !== 4001) toast(`Connect failed: ${e?.shortMessage ?? e?.message ?? e}`, true);
      return false;
    }
  }, [toast]);

  // restore a demo role for this tab, else reconnect the previously-used wallet
  useEffect(() => {
    try {
      const demo = sessionStorage.getItem('vg_demo');
      if (demo && demo in DEMO_ROLES) { enterDemo(demo as DemoRole); return; }
    } catch { /* ignore */ }
    let saved: string | null = null;
    try { saved = localStorage.getItem('vg_wallet'); } catch { /* ignore */ }
    if (!saved) return;
    let done = false;
    const tryReconnect = async () => {
      if (done) return;
      const w = listWallets().find((x) => (x.rdns ?? x.uuid) === saved);
      if (!w) return;
      done = true;
      await connectWallet(w, true); // silent: only if the wallet is still authorized
    };
    const off = onWalletsChanged(tryReconnect);
    tryReconnect();
    const t = setTimeout(() => { done = true; }, 3500);
    return () => { off(); clearTimeout(t); };
  }, [connectWallet]);

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
    try { localStorage.removeItem('vg_wallet'); } catch { /* ignore */ }
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
    let inFlight: Promise<ChainRefreshResult> | null = null;
    let previousFingerprint: string | null = null;
    let previousRequestState = new Map<string, string>();
    const load = (): Promise<ChainRefreshResult> => {
      if (inFlight) return inFlight;
      inFlight = (async (): Promise<ChainRefreshResult> => {
        try {
          const [nextM, nextR, own, currentFinanceAdmin, isPaused] = await Promise.all([
            publicClient.readContract({ address: ADDR.VeilGuardModule, abi: moduleAbi, functionName: 'nextMandateId' }) as Promise<bigint>,
            publicClient.readContract({ address: ADDR.VeilGuardModule, abi: moduleAbi, functionName: 'nextRequestId' }) as Promise<bigint>,
            publicClient.readContract({ address: ADDR.Safe, abi: safeAbi, functionName: 'getOwners' }) as Promise<`0x${string}`[]>,
            publicClient.readContract({ address: ADDR.VeilGuardModule, abi: moduleAbi, functionName: 'financeAdmin' }) as Promise<`0x${string}`>,
            publicClient.readContract({ address: ADDR.VeilGuardModule, abi: moduleAbi, functionName: 'paused' }) as Promise<boolean>,
          ]);
          // Fire all reads concurrently so viem's Multicall3 batching collapses them
          // into a single aggregate eth_call (keeps free-tier RPCs from rate-limiting).
          const mIds = Array.from({ length: Math.max(0, Number(nextM) - 1) }, (_, k) => BigInt(k + 1));
          const rIds = Array.from({ length: Math.max(0, Number(nextR) - 1) }, (_, k) => BigInt(k + 1));
          const [mRaw, rRaw] = await Promise.all([
            Promise.all(mIds.map((i) => publicClient.readContract({ address: ADDR.VeilGuardModule, abi: moduleAbi, functionName: 'getMandate', args: [i] }) as Promise<any[]>)),
            Promise.all(rIds.map((i) => publicClient.readContract({ address: ADDR.VeilGuardModule, abi: moduleAbi, functionName: 'getRequest', args: [i] }) as Promise<any[]>)),
          ]);
          const ms: Mandate[] = mRaw.map((m, k) => ({ id: mIds[k], delegate: m[0], validFrom: m[1], validUntil: m[2], version: Number(m[3]), state: Number(m[4]), autoLimit: m[5], budgetLeft: m[6], reserveFloor: m[7], recipients: m[8] }));
          const rs: SpendRequest[] = rRaw.map((r, k) => ({ id: rIds[k], mandateId: r[0], delegate: r[1], recipient: r[2], memoHash: r[3], createdAt: r[4], state: Number(r[5]), amount: r[6], decision: r[7], blockedReason: r[8] }));
          // TEE resolution status for pending requests
          const pending = rs.filter((r) => r.state === 1);
          if (pending.length) {
            await Promise.all(pending.map(async (r) => {
              r.decisionReady = await handlesResolved([r.decision]);
            }));
          }
          const checkedAt = Date.now();
          const requestState = requestStateSnapshot(rs);
          const changedRequestIds = diffChangedRequestIds(previousRequestState, requestState);
          const fingerprint = chainSnapshotFingerprint({ mandates: ms, requests: requestState, owners: own, financeAdmin: currentFinanceAdmin, paused: isPaused });
          const changed = previousFingerprint !== null && previousFingerprint !== fingerprint;
          previousFingerprint = fingerprint;
          previousRequestState = requestState;
          if (!stop) {
            setMandates(ms);
            setRequests(rs);
            setOwners(own);
            setFinanceAdmin(currentFinanceAdmin);
            setPaused(isPaused);
            setLastUpdated(checkedAt);
            setLoadError(false);
          }
          return { status: changed ? 'changed' : 'unchanged', checkedAt, changedRequestIds };
        } catch (error: any) {
          console.error('poll', error);
          if (!stop) setLoadError(true);
          return {
            status: 'failed',
            checkedAt: Date.now(),
            message: error?.shortMessage ?? error?.message ?? String(error),
            changedRequestIds: [],
          };
        }
      })().finally(() => { inFlight = null; });
      return inFlight!;
    };
    chainRefresh.current = load;
    void load();
    const iv = setInterval(() => { void load(); }, 10_000);
    return () => {
      stop = true;
      clearInterval(iv);
      chainRefresh.current = null;
    };
  }, []);

  // A receipt can become terminal before DelegateView has mounted or restored
  // its local tracking state. Reconcile the run-bound memo on every chain
  // snapshot so refresh/back navigation cannot leave the mission drawer stuck.
  useEffect(() => {
    if (!demoSession || !requests.length) return;
    const reconciled = reconcileRunBoundMissionEvidence(demoSession, requests);
    if (reconciled === demoSession) return;
    saveDemoSession(reconciled);
    setDemoSession(reconciled);
  }, [demoSession, requests]);

  const lc = account?.toLowerCase();
  const isAdmin = !!financeAdmin && lc === financeAdmin.toLowerCase();
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

  const goLegacy = useCallback((nextTab: string) => {
    if ((TABS as readonly string[]).includes(nextTab)) goRoute(legacyTabToRoute(nextTab as LegacyTabName));
  }, [goRoute]);

  const ctx: Ctx = { account, financeAdmin, chainOk, owners, paused, mandates, requests, refresh, toast, run, busy, demoRole, startDemo: enterDemo, openRolePicker: () => setTryOpen(true), goTab: goLegacy, lastUpdated, loadError };

  const resumeDemo = useCallback(() => {
    if (!demoSession) { startFreshDemo(); return; }
    const target = demoSession.tour.expectedRoute ?? demoSession.route;
    const step = demoSession.tour.step;
    let next = demoSessionReducer(demoSession, { type: 'RESUME_SESSION', runId: demoSession.runId });
    next = demoSessionReducer(next, {
      type: 'TOUR_STEP', runId: next.runId, step, route: target,
      role: demoSession.tour.expectedRole ?? demoSession.role,
    });
    saveDemoSession(next);
    setDemoSession(next);
    setResumeOpen(false);
    enterDemo(next.role);
    goRoute(target);
  }, [demoSession, enterDemo, goRoute, startFreshDemo]);

  const restartDemo = useCallback(async () => {
    if (!demoSession || restartBusy) return;
    setRestartBusy(true);
    let current = demoSession;
    let pending: string | undefined;

    try {
      const scenarioKeys = ['routine', 'approval', 'violation'] as const;
      const runRequests: Array<SpendRequest & { scenario: typeof scenarioKeys[number] }> = [];
      for (const scenario of scenarioKeys) {
        const matches = runBoundScenarioRequests(current.runId, scenario, requests);
        runRequests.push(...matches.map((request) => ({ ...request, scenario })));
        const boundId = current.missions[scenario].requestId;
        if (!boundId || matches.some((request) => String(request.id) === boundId)) continue;

        // A just-submitted request may be bound before the polling snapshot sees
        // it. Resolve every mission directly so Restart cannot orphan encrypted
        // escrow while the TEE is still working.
        const raw = await publicClient.readContract({
          address: ADDR.VeilGuardModule,
          abi: moduleAbi,
          functionName: 'getRequest',
          args: [BigInt(boundId)],
        }) as any[];
        const resolved: SpendRequest = {
          id: BigInt(boundId), mandateId: raw[0], delegate: raw[1], recipient: raw[2],
          memoHash: raw[3], createdAt: raw[4], state: Number(raw[5]), amount: raw[6],
          decision: raw[7], blockedReason: raw[8],
        };
        if (!runBoundScenarioRequests(current.runId, scenario, [resolved]).length) {
          throw new Error(`bound ${scenario} request #${boundId} does not belong to this demo run`);
        }
        runRequests.push({ ...resolved, scenario });
      }

      if (!scenarioKeys.some((key) => current.missions[key].requestId) && (loadError || !lastUpdated)) {
        throw new Error('current chain state is unavailable, so pending escrow cannot be ruled out');
      }

      const uniqueRunRequests = [...new Map(runRequests.map((request) => [String(request.id), request])).values()];
      const evaluating = uniqueRunRequests.find((request) => request.state === 1);
      if (evaluating) {
        throw new Error(`request #${evaluating.id} is still in TEE evaluation and may reserve escrow; Resume until it reaches a terminal or approval state`);
      }
      const unsupportedAwaiting = uniqueRunRequests.find((request) => request.state === 3 && request.scenario !== 'approval');
      if (unsupportedAwaiting) {
        throw new Error(`request #${unsupportedAwaiting.id} reached an unexpected approval path and requires manual recovery`);
      }
      const awaiting = uniqueRunRequests.filter((request) => request.state === 3 && request.scenario === 'approval');
      if (awaiting.length > 1) throw new Error('multiple run-bound approval requests need manual recovery');
      pending = awaiting[0] ? String(awaiting[0].id) : undefined;

      current = demoSessionReducer(current, {
        type: 'REQUEST_RESTART', runId: current.runId,
        ...(pending ? { pendingApprovalRequestId: pending } : {}),
      });
      saveDemoSession(current);
      setDemoSession(current);

      if (pending) {
        const response = await fetch('/api/demo-decision', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ runId: current.runId, requestId: pending, action: 'reject' }),
          signal: AbortSignal.timeout(15_000),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok && response.status !== 410) throw new Error(payload.error ?? `cleanup returned ${response.status}`);

        let refunded = false;
        for (let attempt = 0; attempt < 45; attempt++) {
          const request = await publicClient.readContract({
            address: ADDR.VeilGuardModule, abi: moduleAbi,
            functionName: 'getRequest', args: [BigInt(pending)],
          }) as any[];
          if (Number(request[5]) === 5) { refunded = true; break; }
          if (Number(request[5]) !== 3) throw new Error(`request reached ${Number(request[5])}, not the refunded state`);
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
        if (!refunded) throw new Error('refund was not confirmed before the recovery window closed');
        current = demoSessionReducer(current, {
          type: 'RESTART_CLEANUP_SUCCEEDED', runId: current.runId, requestId: pending,
        });
      }

      const restarted = demoSessionReducer(current, {
        type: 'CONFIRM_RESTART', runId: current.runId,
      });
      try { sessionStorage.removeItem('vg_track'); } catch { /* ignore */ }
      saveDemoSession(restarted);
      setDemoSession(restarted);
      setResumeOpen(false);
      enterDemo('delegate');
      goRoute(restarted.route);
      refresh();
    } catch (reason: any) {
      if (pending) {
        current = demoSessionReducer(current, {
          type: 'RESTART_CLEANUP_FAILED', runId: current.runId,
          requestId: pending, error: reason?.message ?? String(reason),
        });
        saveDemoSession(current);
        setDemoSession(current);
      }
      toast(`Restart refused: ${reason?.message ?? reason}. Resume this run to recover safely.`, true);
    } finally {
      setRestartBusy(false);
    }
  }, [demoSession, enterDemo, goRoute, lastUpdated, loadError, refresh, requests, restartBusy, toast]);

  const tryModal = tryOpen && (
    <ModalDialog
      labelledBy="role-picker-title"
      describedBy="role-picker-description"
      onClose={() => setTryOpen(false)}
    >
      <div className="modal-title-row"><h2 id="role-picker-title">Try VeilGuard instantly</h2><button type="button" className="icon-button" aria-label="Close role picker" onClick={() => setTryOpen(false)}><Icon name="close" /></button></div>
      <p id="role-picker-description" className="muted" style={{ fontSize: 13.5, marginBottom: 14 }}>
        Pick a demo role — a shared, pre-funded public testnet account with that role's on-chain
        permissions. No wallet, no setup. (The powerful roles — finance admin and Safe signer —
        are deliberately not public.)
      </p>
      {(Object.keys(DEMO_ROLES) as DemoRole[]).map((r, index) => (
        <button
          key={r}
          className="rolecard"
          data-dialog-initial-focus={index === 0 ? '' : undefined}
          onClick={() => { enterDemo(r); goRoute(r === 'delegate' ? { page: 'payment-inbox' } : { page: 'audit-packets' }); }}
        >
          <span className="rolecard-icon"><Icon name={r === 'delegate' ? 'payments' : 'audit'} size={20} /></span>
          <span>
            <b>Act as {DEMO_ROLES[r].label}</b>
            <small>{DEMO_ROLES[r].blurb}</small>
          </span>
        </button>
      ))}
      <div className="try-divider"><span>or use your own wallet</span></div>
      <button className="btn primary wide" onClick={() => { setTryOpen(false); if (stage === 'landing') launch(false); connect(); }}>
        <Icon name="wallet" /> Connect my wallet
      </button>
      <p className="muted" style={{ fontSize: 12, marginTop: 8, textAlign: 'center' }}>
        MetaMask, OKX, Rabby, Coinbase… — you'll be able to get your wallet provisioned as a delegate and sign with it yourself.
      </p>
    </ModalDialog>
  );

  if (stage === 'landing') {
    return (
      <AppCtx.Provider value={ctx}>
        <a className="skip-link" href="#main-content">Skip to product content</a>
        <WaveField />
        <div className="page-scrim" />
        <div className="wrap">
          <header className="topbar">
            <div>
              <Logo />
              <div className="tagline">Confidential spending policies for Safe treasuries · Ethereum Sepolia · powered by iExec Nox</div>
            </div>
            <div className="row">
              <button className="btn ghost" onClick={() => launch(false, 'Verify')}>Verify on-chain</button>
              <button className="btn primary" onClick={() => launch(true)}><Icon name="tour" /> Start interactive demo</button>
            </div>
          </header>
          <main id="main-content" tabIndex={-1}>
            <Landing onLaunch={() => launch(true)} onVerify={() => launch(false, 'Verify')}
              onConnect={() => { launch(false); connect(); }} />
          </main>
          <footer>
            <div>VEILGUARD — confidential treasury controls on <a href="https://safe.global" target="_blank" rel="noopener">Safe</a> · powered by <a href="https://docs.noxprotocol.io" target="_blank" rel="noopener">iExec Nox</a></div>
            <div>Ethereum Sepolia · testnet prototype — not audited</div>
          </footer>
        </div>
        {tryModal}
      </AppCtx.Provider>
    );
  }

  const NAV: { route: AppRoute; label: string; icon: IconName; group: string }[] = [
    { route: { page: 'overview' }, label: 'Overview', icon: 'overview', group: 'Desk' },
    { route: { page: 'payment-inbox' }, label: 'Payments', icon: 'payments', group: 'Desk' },
    { route: { page: 'approvals' }, label: 'Approvals', icon: 'approvals', group: 'Desk' },
    { route: { page: 'policies' }, label: 'Policies', icon: 'policies', group: 'Control' },
    { route: { page: 'disclosure-builder' }, label: 'Build Packet', icon: 'disclosure', group: 'Control' },
    { route: { page: 'audit-packets' }, label: 'Audit', icon: 'audit', group: 'Control' },
    { route: { page: 'verify' }, label: 'Verify', icon: 'verify', group: 'Evidence' },
    { route: { page: 'contracts' }, label: 'Contracts', icon: 'contracts', group: 'Evidence' },
    { route: { page: 'provenance' }, label: 'Provenance', icon: 'provenance', group: 'Evidence' },
    { route: { page: 'funds' }, label: 'Funds', icon: 'funds', group: 'Tools' },
  ];
  const groups = ['Desk', 'Control', 'Evidence', 'Tools'];
  const activeNav = (target: AppRoute) => {
    if (target.page === 'payment-inbox') return ['payment-inbox', 'new-payment', 'payment-detail'].includes(route.page);
    if (target.page === 'approvals') return ['approvals', 'approval-detail'].includes(route.page);
    if (target.page === 'policies') return ['policies', 'policy-new', 'policy-detail', 'policy-new-version'].includes(route.page);
    if (target.page === 'audit-packets') return ['audit-packets', 'audit-detail'].includes(route.page);
    return route.page === target.page;
  };

  return (
    <AppCtx.Provider value={ctx}>
      <a className="skip-link" href="#main-content">Skip to workspace</a>
      <WaveField />
      <div className="page-scrim page-scrim-workspace" />
      <div className="shell">
        <aside className="sidebar">
          <button className="side-logo" onClick={() => navigate('/')} title="Back to product introduction" aria-label="Back to product introduction">
            <Logo />
          </button>
          <nav className="side-nav" aria-label="Operations desk">
            {groups.map((g) => (
              <div key={g} className="side-group">
                <div className="side-group-label">{g}</div>
                {NAV.filter((n) => n.group === g).map((n) => (
                  <button
                    key={n.label}
                    className={`side-item ${activeNav(n.route) ? 'active' : ''}`}
                    aria-current={activeNav(n.route) ? 'page' : undefined}
                    title={n.label}
                    onClick={() => goRoute(n.route)}
                  >
                    <span className="side-ico"><Icon name={n.icon} /></span><span className="side-label">{n.label}</span>
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <div className="side-foot">
            {!demoSession?.tour.active && <button className="btn small ghost wide" onClick={() => launch(true)}><Icon name="tour" /> <span className="side-label">Guided demo</span></button>}
            <div className="side-status mono">
              {lastUpdated ? `synced ${Math.round((Date.now() - lastUpdated) / 1000)}s ago`
                : loadError ? <span style={{ color: 'var(--warn)' }}>connecting…</span> : 'loading…'}
            </div>
          </div>
        </aside>

        <main className="main" id="main-content" tabIndex={-1}>
          <div className="main-top">
            <div className="crumb"><span className="crumb-parent">Confidential Operations Desk</span><Icon name="chevron" size={14} /><span className="crumb-page">{appRouteLabel(route)}</span></div>
            <div className="row">
              {paused && <span className="pill bad">PAUSED</span>}
              {!demoSession?.tour.active && (
                <button
                  type="button"
                  className="btn ghost mobile-guided-trigger"
                  aria-label="Start interactive demo"
                  title="Start guided demo"
                  onClick={() => launch(true)}
                >
                  <Icon name="tour" />
                </button>
              )}
              {demoRole ? (
                <button className="context-role-chip" onClick={() => setTryOpen(true)}><Icon name="role" /><span>{DEMO_ROLES[demoRole].label}</span><small>Demo role</small></button>
              ) : (
                <button className="btn small trybtn" onClick={() => setTryOpen(true)}><Icon name="role" /> Try a role</button>
              )}
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

          <div className="main-body">
            {busy && <div className="notice" role="status"><span className="spin" /> &nbsp;<b>{busy}</b> — {demoRole ? 'signing locally, waiting for the chain…' : 'follow any wallet prompt · waiting for the chain…'}</div>}

            {(['payment-inbox', 'new-payment', 'payment-detail', 'contracts', 'provenance'] as string[]).includes(route.page)
              && <h1 className="sr-only">{appRouteLabel(route)}</h1>}

            {noRole && !demoRole && (
              <div className="notice">
                <b>Your wallet holds no role in this treasury</b> — that's by design: every number is gated by
                on-chain ACLs. You can still <b>finalize</b> pending requests and inspect public evidence.
                To experience the full loop, <button className="btn small primary" style={{ margin: '0 6px' }}
                  onClick={() => setTryOpen(true)}>try a demo role</button> — no setup needed.
              </div>
            )}

            <Suspense fallback={<div className="card workspace-skeleton" role="status"><span className="skeleton-line wide" /><span className="skeleton-line" /><span className="skeleton-panel" /><span className="sr-only">Loading workspace</span></div>}>
              {route.page === 'overview' && <PublicView />}
              {['payment-inbox', 'new-payment', 'payment-detail'].includes(route.page) && (
                <DelegateView
                  key={demoSession?.runId ?? 'no-demo-run'}
                  detailRequestId={route.page === 'payment-detail' ? route.requestId : undefined}
                />
              )}
              {['policies', 'policy-new', 'policy-detail', 'policy-new-version'].includes(route.page) && <PoliciesView />}
              {['approvals', 'approval-detail'].includes(route.page) && <SignerView />}
              {route.page === 'disclosure-builder' && <DisclosureView />}
              {['audit-packets', 'audit-detail'].includes(route.page) && <AuditorView />}
              {route.page === 'verify' && <VerifyView />}
              {route.page === 'contracts' && <TrustCenterView mode="contracts" />}
              {route.page === 'provenance' && <TrustCenterView mode="provenance" />}
              {route.page === 'funds' && <FaucetView />}
              {route.page === 'not-found' && <NotFoundView path={route.path} />}
            </Suspense>

            <footer>
              <div>VEILGUARD — confidential treasury controls on <a href="https://safe.global" target="_blank" rel="noopener">Safe</a> · powered by <a href="https://docs.noxprotocol.io" target="_blank" rel="noopener">iExec Nox</a></div>
              <div>
                <a href="https://github.com/a252937166/veilguard" target="_blank" rel="noopener">GitHub ↗</a> ·
                {' '}<a href={`https://sepolia.etherscan.io/address/${ADDR.VeilGuardModule}`} target="_blank" rel="noopener">Module ↗</a> ·
                {' '}<a href={`https://sepolia.etherscan.io/address/${ADDR.Safe}`} target="_blank" rel="noopener">Safe ↗</a> ·
                {' '}<span className="mono">ui {__UI_BUILD_SHA__}</span> · <span className="mono">evidence {EVIDENCE_COMMIT}</span> · not audited
              </div>
            </footer>
          </div>
        </main>
      </div>
      {demoSession?.tour.active && (
        <MissionDrawer
          session={demoSession}
          dispatch={dispatchDemo}
          currentRoute={route}
          currentRole={demoRole}
          onNavigate={({ route: target, role }) => {
            if (role && role !== demoRole) enterDemo(role);
            goRoute(target);
          }}
          onRefresh={refresh}
          onClose={() => undefined}
        />
      )}
      {resumeOpen && demoSession && (
        <ModalDialog
          labelledBy="resume-title"
          describedBy="resume-description"
          className="resume-dialog"
          onClose={() => setResumeOpen(false)}
        >
          <div className="modal-title-row">
            <div><p className="workspace-kicker">Run {demoSession.runId}</p><h2 id="resume-title">Continue the unfinished Launch Day shift?</h2></div>
            <button className="icon-button" aria-label="Close resume dialog" onClick={() => setResumeOpen(false)}><Icon name="close" /></button>
          </div>
          <p id="resume-description" className="muted">Your request and packet evidence remains bound to this run. Restarting is safe only after any pending ShieldOps escrow is rejected and the refund is confirmed on-chain.</p>
          <dl className="resume-facts">
            <div><dt>Current mission</dt><dd>{demoSession.currentMission}</dd></div>
            <div><dt>Role</dt><dd>{DEMO_ROLES[demoSession.role].label}</dd></div>
            <div><dt>Last route</dt><dd>{appRouteLabel(demoSession.route)}</dd></div>
          </dl>
          {demoSession.restart.status === 'failed' && <div className="inline-alert error" role="alert">Refund cleanup could not be confirmed. Restart stays disabled; resume this run and recover the pending request.</div>}
          {restartBusy && <div className="inline-alert neutral" role="status"><span className="spin" /> Rejecting pending escrow and confirming the refund before reset…</div>}
          <div className="modal-actions">
            <button className="btn ghost" disabled={restartBusy || demoSession.restart.status === 'failed'} onClick={restartDemo}>Restart safely</button>
            <button className="btn primary" data-dialog-initial-focus disabled={restartBusy} onClick={resumeDemo}>Resume run</button>
          </div>
        </ModalDialog>
      )}
      {tryModal}
      {connectOpen && <ConnectModal onPick={connectWallet} onClose={() => setConnectOpen(false)} onDemo={() => setTryOpen(true)} />}
      {toastMsg && (
        <div
          className={`toast ${toastMsg.err ? 'err' : ''}`}
          role={toastMsg.err ? 'alert' : 'status'}
          aria-live={toastMsg.err ? 'assertive' : 'polite'}
          aria-atomic="true"
        >
          {toastMsg.msg}
        </div>
      )}
    </AppCtx.Provider>
  );
}
