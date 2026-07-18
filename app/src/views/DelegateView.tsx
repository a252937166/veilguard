import { useEffect, useMemo, useRef, useState } from 'react';
import { keccak256, parseEventLogs, stringToBytes } from 'viem';
import { ADDR, FINALIZE_API, PROVISION_API, moduleAbi, parseUsdc, scanTx, short, vendorName } from '../config';
import { handleClientFor, publicClient } from '../nox';
import { walletWrite } from '../walletTx';
import { fetchRequestTxs, type RequestTxs } from '../txlog';
import { useApp, type SpendRequest } from '../App';
import { NoRole, RequestPill } from '../ui';
import { FREEPLAY_DELEGATE, VIOLATION_DELEGATE, demoWalletByAddress } from '../demo';
import { MISSIONS, bindMissionRequest, completeMission, confirmApprovalDecision, getOrCreateDemoSession, loadMissions, type MissionKey, type MissionState } from '../missions';
import { DEMO_SCENARIOS, demoMemoHash, scenarioByKey, scenarioByRecipient, type DemoScenarioKey } from '../demo-scenarios';
import { loadDemoSession } from '../demo-session';
import { formatAppRoute, parseAppHash } from '../routes';
import { PrivacyLens } from '../components/PrivacyLens';
import { PaymentProgress, PAYMENT_PHASE_INDEX, type PaymentFlow, type PaymentPhase } from '../components/PaymentProgress';
import { acquireOperationLock, releaseOperationLock } from '../operation-lock';

const REASONS: Record<number, string> = {
  1: 'over the delegated budget',
  2: 'treasury balance too low',
  3: 'would breach the reserve floor',
};

type Track = { id?: string; mission: MissionKey | 'free'; amount: string; tx?: `0x${string}`; delegate?: `0x${string}`; at: number; runId?: string };
const loadTrack = (): Track | null => { try { return JSON.parse(sessionStorage.getItem('vg_track') ?? 'null'); } catch { return null; } };
const saveTrack = (t: Track | null) => { try { t ? sessionStorage.setItem('vg_track', JSON.stringify(t)) : sessionStorage.removeItem('vg_track'); } catch { /* ignore */ } };

const MAIN_DEMO = '0x17ee5ad7e4b40cadafad27c5f68f74d02c7fd532';
const isDemoAddr = (a?: string) => !!a && [MAIN_DEMO, VIOLATION_DELEGATE.address.toLowerCase(), FREEPLAY_DELEGATE.address.toLowerCase()].includes(a.toLowerCase());

function activeRunId(): string {
  return getOrCreateDemoSession().runId;
}

function mmss(sec: number): string {
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function DelegateView() {
  const { account, mandates, requests, run, busy, refresh, toast, goTab, startDemo, lastUpdated, loadError } = useApp();
  const [amount, setAmount] = useState('25');
  const [recipient, setRecipient] = useState('');
  const [memo, setMemo] = useState('');
  const [trackId, setTrackId] = useState<bigint | null>(null);
  const [missionOf, setMissionOf] = useState<MissionKey | 'free' | null>(null);
  const [lastAmount, setLastAmount] = useState<string>('');
  const [lastTx, setLastTx] = useState<`0x${string}` | null>(null);
  const [reasonVal, setReasonVal] = useState<string | null>(null);
  const [reasonBusy, setReasonBusy] = useState(false);
  const [missions, setMissions] = useState<MissionState>(loadMissions);
  const [txs, setTxs] = useState<Map<string, RequestTxs>>(new Map());
  const [cool, setCool] = useState<{ main: number; violation: number; freeplay: number }>({ main: 0, violation: 0, freeplay: 0 });
  const [selectedScenario, setSelectedScenario] = useState<DemoScenarioKey>('routine');
  const [decisionBusy, setDecisionBusy] = useState<'approve' | 'reject' | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const decisionLock = useRef(false);

  const [flow, setFlowState] = useState<PaymentFlow | null>(null);
  const setFlow = (phase: PaymentPhase, label: string, expect?: number, tx?: `0x${string}`) =>
    setFlowState((f) => ({
      phase,
      label,
      startedAt: f && f.label === label ? f.startedAt : Date.now(),
      expect: expect ?? (f && f.label === label ? f.expect : undefined),
      tx: tx ?? f?.tx,
    }));
  const clearFlow = () => setFlowState(null);
  const submissionLock = useRef(false);
  const [submittingScenario, setSubmittingScenario] = useState<MissionKey | 'free' | null>(null);
  const [, forceTick] = useState(0);
  useEffect(() => {
    const need = !!flow || Object.values(cool).some((t) => t > Math.floor(Date.now() / 1000))
      || (trackId != null && requests.find((r) => r.id === trackId)?.state === 3);
    if (!need) return;
    const iv = setInterval(() => forceTick((t) => t + 1), 500);
    return () => clearInterval(iv);
  }, [flow?.label, cool.main, cool.violation, cool.freeplay, trackId, requests]);

  const freeFormRef = useRef<HTMLDivElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const receiptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const selectFromRoute = () => {
      const route = parseAppHash(window.location.hash);
      if (route?.page !== 'payment-detail' || !/^\d+$/.test(route.requestId)) return;
      const id = BigInt(route.requestId);
      const session = loadDemoSession();
      const mission = session && (['routine', 'approval', 'violation'] as const)
        .find((key) => session.missions[key].requestId === route.requestId);
      setTrackId(id);
      setMissionOf(mission ?? null);
    };
    selectFromRoute();
    window.addEventListener('hashchange', selectFromRoute);
    return () => window.removeEventListener('hashchange', selectFromRoute);
  }, []);

  const isDemo = account?.toLowerCase() === '0x17ee5ad7e4b40cadafad27c5f68f74d02c7fd532';
  const myMandate = useMemo(
    () => mandates.find((m) => m.state === 2 && m.delegate.toLowerCase() === account?.toLowerCase()),
    [mandates, account],
  );
  const violationMandate = useMemo(
    () => mandates.find((m) => m.state === 2 && m.delegate.toLowerCase() === VIOLATION_DELEGATE.address.toLowerCase()),
    [mandates],
  );
  const freeplayMandate = useMemo(
    () => mandates.find((m) => m.state === 2 && m.delegate.toLowerCase() === FREEPLAY_DELEGATE.address.toLowerCase()),
    [mandates],
  );
  const myRequests = useMemo(() => {
    const mine = (d: string) => d.toLowerCase() === account?.toLowerCase() || (isDemo && isDemoAddr(d));
    return [...requests].filter((r) => mine(r.delegate)).reverse();
  }, [requests, account, isDemo]);
  const latest = useMemo(() => (trackId != null ? requests.find((r) => r.id === trackId) : undefined), [requests, trackId]);

  // In-flight (Requested OR AwaitingSafeApproval) occupies the mandate slot —
  // both must block new submissions (the contract rejects them anyway).
  const blockingRequest = useMemo(
    () => (myMandate ? requests.find((r) => r.mandateId === myMandate.id && (r.state === 1 || r.state === 3)) : undefined),
    [requests, myMandate],
  );
  const freeplayBlocking = useMemo(
    () => (freeplayMandate ? requests.find((r) => r.mandateId === freeplayMandate.id && (r.state === 1 || r.state === 3)) : undefined),
    [requests, freeplayMandate],
  );

  // restore the tracked payment after a refresh (mission attribution survives),
  // else adopt an untracked in-flight request left over from a previous visit
  useEffect(() => {
    if (trackId != null) return;
    const session = loadDemoSession();
    let t = loadTrack();
    if (t && session && t.runId !== session.runId) {
      saveTrack(null);
      t = null;
    }
    if (t?.id && requests.some((r) => String(r.id) === t.id)) {
      setTrackId(BigInt(t.id)); setMissionOf(t.mission); setLastAmount(t.amount); if (t.tx) setLastTx(t.tx);
      return;
    }
    if (t && !t.id) {
      setMissionOf(t.mission); setLastAmount(t.amount); if (t.tx) setLastTx(t.tx);
      if (t.tx) setFlow('recovering', 'Recovering the broadcast request from Sepolia…', 30, t.tx);
    }
    const boundMission = session && (['routine', 'approval', 'violation'] as const)
      .find((mission) => {
        const requestId = session.missions[mission].requestId;
        return requestId && requests.some((request) => String(request.id) === requestId);
      });
    if (boundMission) {
      const requestId = session!.missions[boundMission].requestId!;
      setTrackId(BigInt(requestId));
      setMissionOf(boundMission);
      return;
    }
    if (blockingRequest) { setTrackId(blockingRequest.id); setMissionOf(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockingRequest?.id, requests.length]);

  // Recover the exact request id from a broadcast transaction when the first
  // receipt wait timed out. This also covers free play, whose memo is
  // intentionally not run-bound and therefore cannot use mission reconciliation.
  useEffect(() => {
    if (flow?.phase !== 'recovering') return;
    const initial = loadTrack();
    if (!initial?.tx || initial.id) return;
    let stopped = false;
    let checking = false;
    const recoverReceipt = async () => {
      if (stopped || checking) return;
      const tracked = loadTrack();
      if (!tracked?.tx || tracked.tx !== initial.tx || tracked.id) return;
      checking = true;
      try {
        const receipt = await publicClient.waitForTransactionReceipt({
          hash: tracked.tx,
          pollingInterval: 1_200,
          timeout: 12_000,
        });
        if (stopped) return;
        if (receipt.status !== 'success') {
          saveTrack(null);
          clearFlow();
          setSubmittingScenario(null);
          stopped = true;
          toast(`Transaction ${short(tracked.tx)} reverted before a request was created. It is safe to retry.`, true);
          return;
        }
        const events = parseEventLogs({ abi: moduleAbi as any, logs: receipt.logs, eventName: 'SpendRequested' }) as any[];
        const event = tracked.delegate
          ? events.find((candidate) => (candidate.args?.delegate as string)?.toLowerCase() === tracked.delegate!.toLowerCase())
          : events[0];
        if (!event?.args?.requestId) {
          saveTrack(null);
          clearFlow();
          setSubmittingScenario(null);
          stopped = true;
          toast('The confirmed transaction created no VeilGuard request. It is safe to retry.', true);
          return;
        }
        const id = event.args.requestId as bigint;
        const runId = tracked.runId ?? activeRunId();
        saveTrack({ ...tracked, id: String(id), at: Date.now(), runId });
        if (tracked.mission !== 'free' && tracked.mission !== 'audit') bindMissionRequest(tracked.mission, id, runId);
        setReasonVal(null);
        setLastAmount(tracked.amount);
        setLastTx(tracked.tx);
        setMissionOf(tracked.mission);
        setTrackId(id);
        setFlow('evaluating', `Request #${id} recovered · Nox is evaluating three private rules…`, 30, tracked.tx);
        stopped = true;
        refresh();
      } catch {
        // Still pending or the RPC is temporarily unavailable. The next
        // bounded attempt reuses the same hash and never creates a duplicate.
      } finally {
        checking = false;
      }
    };
    void recoverReceipt();
    const interval = setInterval(() => { void recoverReceipt(); }, 15_000);
    return () => { stopped = true; clearInterval(interval); };
  }, [flow?.phase, requests.length, trackId, refresh, toast]);

  // fast-poll while a request is in flight
  useEffect(() => {
    if (!(latest && (latest.state === 1 || latest.state === 3)) && flow?.phase !== 'recovering') return;
    const iv = setInterval(refresh, 3000);
    const stop = setTimeout(() => clearInterval(iv), 60_000);
    return () => { clearInterval(iv); clearTimeout(stop); };
  }, [latest?.id, latest?.state, flow?.phase, refresh]);

  // anti-probing cooldown clocks for both demo identities
  useEffect(() => {
    if (!account) return;
    let stop = false;
    const load = async () => {
      try {
        const [a, b, c] = await Promise.all([
          publicClient.readContract({ address: ADDR.VeilGuardModule, abi: moduleAbi, functionName: 'cooldownUntil', args: [account] }) as Promise<bigint>,
          publicClient.readContract({ address: ADDR.VeilGuardModule, abi: moduleAbi, functionName: 'cooldownUntil', args: [VIOLATION_DELEGATE.address] }) as Promise<bigint>,
          publicClient.readContract({ address: ADDR.VeilGuardModule, abi: moduleAbi, functionName: 'cooldownUntil', args: [FREEPLAY_DELEGATE.address] }) as Promise<bigint>,
        ]);
        if (!stop) setCool({ main: Number(a), violation: Number(b), freeplay: Number(c) });
      } catch { /* transient */ }
    };
    load();
    const iv = setInterval(load, 15_000);
    return () => { stop = true; clearInterval(iv); };
  }, [account, requests.length]);
  const nowSec = Math.floor(Date.now() / 1000);
  const mainCoolLeft = Math.max(0, cool.main - nowSec);
  const violationCoolLeft = Math.max(0, cool.violation - nowSec);
  const freeplayCoolLeft = Math.max(0, cool.freeplay - nowSec);

  // Mission bookkeeping remains idempotent and uses the persisted run binding;
  // attribution may arrive one render after the terminal request snapshot.
  useEffect(() => {
    if (!latest || latest.state === 1 || latest.state === 3) return;
    const tracked = loadTrack();
    const session = loadDemoSession();
    const persistedMission = session && (['routine', 'approval', 'violation'] as const)
      .find((mission) => session.missions[mission].requestId === String(latest.id));
    if (tracked && session && tracked.runId !== session.runId) return;
    // A newly broadcast request may not have a receipt/id yet while `latest`
    // still points at the preceding terminal request. Never let that stale
    // object clear the new request's recovery pointer or progress surface.
    if (tracked) {
      const tracksLatest = tracked.id === String(latest.id)
        || (!tracked.id
          && !!persistedMission
          && tracked.mission === persistedMission
          && (!tracked.runId || tracked.runId === session?.runId));
      if (!tracksLatest) return;
    }
    const attributedMission = persistedMission ?? missionOf ?? (tracked?.id === String(latest.id) ? tracked.mission : null);
    const runId = persistedMission ? session!.runId : tracked?.runId ?? session?.runId ?? activeRunId();
    let completed = false;
    if (latest.state === 2 && attributedMission === 'routine') {
      setMissions(completeMission('routine', { requestId: latest.id, outcome: 'executed', runId }));
      completed = true;
    }
    if ((latest.state === 2 || latest.state === 5) && attributedMission === 'approval') {
      setMissions(completeMission('approval', {
        requestId: latest.id,
        outcome: latest.state === 5 ? 'cancelled' : 'executed',
        decision: latest.state === 5 ? 'reject' : 'approve',
        runId,
      }));
      fetchRequestTxs(true).then(setTxs).catch(() => {});
      completed = session?.missions.approval.decisionConfirmed === true;
    }
    if (attributedMission === 'free' || completed) saveTrack(null);
    clearFlow();
    setTimeout(() => receiptRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 250);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latest?.state, latest?.id, missionOf]);
  useEffect(() => { fetchRequestTxs().then(setTxs).catch(() => {}); }, []);
  useEffect(() => {
    const on = () => {
      setMissions(loadMissions());
      if (trackId != null) return;
      const session = loadDemoSession();
      const mission = session && (['routine', 'approval', 'violation'] as const)
        .find((key) => {
          const requestId = session.missions[key].requestId;
          return requestId && requests.some((request) => String(request.id) === requestId);
        });
      if (!mission) return;
      setMissionOf(mission);
      setTrackId(BigInt(session!.missions[mission].requestId!));
    };
    window.addEventListener('vg-missions', on);
    window.addEventListener('vg-demo-session', on);
    return () => {
      window.removeEventListener('vg-missions', on);
      window.removeEventListener('vg-demo-session', on);
    };
  }, [requests, trackId]);
  useEffect(() => {
    const next = DEMO_SCENARIOS.find((scenario) => !missions[scenario.key]);
    if (next) setSelectedScenario(next.key);
  }, [missions.routine, missions.approval, missions.violation]);

  // flash table rows whose outcome just changed (skip the initial load)
  const prevStates = useRef<Map<string, number>>(new Map());
  const primed = useRef(false);
  const [flashIds, setFlashIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    const changed = new Set<string>();
    for (const r of requests) {
      const k = String(r.id);
      const prev = prevStates.current.get(k);
      if (prev === undefined) { if (primed.current) changed.add(k); }
      else if (prev !== r.state) changed.add(k);
      prevStates.current.set(k, r.state);
    }
    primed.current = true;
    if (!changed.size) return;
    setFlashIds((old) => new Set([...old, ...changed]));
    const t = setTimeout(() => setFlashIds((old) => {
      const n = new Set(old); changed.forEach((c) => n.delete(c)); return n;
    }), 2600);
    return () => clearTimeout(t);
  }, [requests]);

  const explainRevert = (e: any): string => {
    const s = `${e?.metaMessages?.join(' ') ?? ''} ${e?.shortMessage ?? ''} ${e?.message ?? ''}`;
    if (/PendingRequestExists/.test(s)) return 'a previous request is still in flight — it resolves automatically in under a minute';
    if (/CooldownActive/.test(s)) return 'this delegate is in the anti-probing cooldown — the countdown above shows when it ends';
    if (/NotActiveMandate/.test(s)) return 'this mandate is no longer the active one for the delegate';
    if (/RecipientNotAllowed/.test(s)) return 'that recipient is not on the mandate allow-list';
    if (/MandateNotInWindow/.test(s)) return 'the mandate is outside its valid time window';
    if (/insufficient funds|exceeds the balance|gas required exceeds/.test(s)) return 'the demo account is low on Sepolia gas — try again shortly (it gets topped up)';
    return e?.shortMessage ?? e?.message ?? 'transaction reverted';
  };

  /** Shared submit pipeline — works for the page identity AND the hidden violation delegate. */
  const submitCore = async (who: `0x${string}`, mandateId: bigint, recipient: `0x${string}`, amt: string, mission: MissionKey | 'free'): Promise<'bound' | 'recovering' | 'failed'> => {
    let requestBound = false;
    let recoveryPending = false;
    await run(`Pay ${amt} cUSDC`, async () => {
      const local = !!demoWalletByAddress(who);
      const runId = activeRunId();
      try {
        setFlow('encrypting', local ? 'Encrypting the amount in-browser…' : '① Check your wallet — approve the signature to encrypt your amount', local ? 6 : undefined);
        const sigHint = !local && setTimeout(() => setFlow(
          'encrypting',
          '① No signature popup? Click the wallet (🦊) icon in your toolbar — the request is queued there without auto-opening.',
        ), 12_000);
        let enc;
        try {
          const client = await handleClientFor(who);
          enc = await client.encryptInput(parseUsdc(amt), 'uint256', ADDR.VeilGuardModule);
        } finally { if (sigHint) clearTimeout(sigHint); }

        setFlow('broadcasting', local ? 'Broadcasting the encrypted payment…' : '② Now confirm the transaction in your wallet', local ? 4 : undefined);
        let hash: `0x${string}`;
        try {
          hash = await walletWrite({
            account: who, address: ADDR.VeilGuardModule, abi: moduleAbi, functionName: 'requestSpend',
            args: [mandateId, recipient, enc.handle, enc.handleProof,
              local && mission !== 'free' && mission !== 'audit'
                ? demoMemoHash(runId, mission as DemoScenarioKey, mandateId, who)
                : keccak256(stringToBytes(memo || 'veilguard'))],
            onHint: (message) => setFlow('broadcasting', message), injected: !local,
          });
        } catch (e: any) {
          if (e?.code === 4001 || /User rejected|denied/i.test(`${e?.message}`)) throw new Error('you rejected the transaction in the wallet');
          throw new Error(explainRevert(e));
        }
        // Persist at broadcast time, not receipt time. A slow RPC can no longer
        // erase the only recovery pointer after the transaction is already live.
        saveTrack({ mission, amount: amt, tx: hash, delegate: who, at: Date.now(), runId });
        setLastAmount(amt); setLastTx(hash); setMissionOf(mission);
        setFlow('confirming', 'Sepolia is including your transaction…', 13, hash);
        let receipt;
        try {
          receipt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 1_200, timeout: 60_000 });
        } catch {
          recoveryPending = true;
          setFlow('recovering', 'Receipt is delayed — recovering the request from chain state…', 30, hash);
          return;
        }
        if (receipt.status !== 'success') {
          saveTrack(null);
          throw new Error(`transaction ${short(hash)} reverted before a request was created; it is safe to retry`);
        }
        // exact request id from OUR receipt's SpendRequested event — immune to
        // concurrent visitors interleaving requests
        const evs = parseEventLogs({ abi: moduleAbi as any, logs: receipt.logs, eventName: 'SpendRequested' }) as any[];
        const ev = evs.find((e) => (e.args?.delegate as string)?.toLowerCase() === who.toLowerCase()) ?? evs[0];
        if (!ev) {
          saveTrack(null);
          throw new Error('transaction confirmed without a SpendRequested event; no request was created and it is safe to retry');
        }
        const id = ev.args.requestId as bigint;
        saveTrack({ id: String(id), mission, amount: amt, tx: hash, delegate: who, at: Date.now(), runId });
        if (mission !== 'free' && mission !== 'audit') bindMissionRequest(mission, id, runId);
        setReasonVal(null); setLastAmount(amt); setLastTx(hash); setMissionOf(mission); setTrackId(id);
        requestBound = true;
        setFlow('evaluating', `Request #${id} submitted · Nox is evaluating three private rules…`, 30, hash);
      } finally {
        if (!requestBound && !recoveryPending) clearFlow();
      }
    });
    return requestBound ? 'bound' : recoveryPending ? 'recovering' : 'failed';
  };

  const finalizingRef = useRef<{ id: bigint; startedAt: number } | null>(null);
  const finalizeRetryAt = useRef(0);
  useEffect(() => {
    if (!latest || latest.state !== 1 || !latest.decisionReady) {
      if (latest && finalizingRef.current?.id === latest.id) finalizingRef.current = null;
      return;
    }
    const activeFinalize = finalizingRef.current;
    if ((activeFinalize?.id === latest.id && Date.now() - activeFinalize.startedAt < 60_000)
      || busy || Date.now() < finalizeRetryAt.current) return;
    run('Publishing the result', async () => {
      // Set the lock only after App.run accepted this operation. If another
      // action owned the global lock in the same render frame, the next chain
      // poll can still retry instead of leaving this request stuck forever.
      finalizingRef.current = { id: latest.id, startedAt: Date.now() };
      setFlow('finalizing', 'The decision is ready — the keeper is publishing the TEE proof on-chain…', 22, lastTx ?? undefined);
      try {
        const res = await fetch(FINALIZE_API, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId: Number(latest.id) }),
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d?.error ?? 'finalize failed'); }
        for (let k = 0; k < 6; k++) { await new Promise((r) => setTimeout(r, 1500)); refresh(); }
      } catch (error) {
        finalizingRef.current = null;
        finalizeRetryAt.current = Date.now() + 5_000;
        throw error;
      } finally { clearFlow(); }
    });
    // `requests` retries a transient failure on the next bounded chain poll;
    // `busy` ensures a decision that became ready during submission is not lost.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latest?.id, latest?.state, latest?.decisionReady, busy, requests]);

  // ---------------- scenario engine ----------------
  const unlocked: Record<MissionKey, boolean> = {
    routine: true,
    approval: missions.routine,
    violation: missions.approval,
    audit: missions.routine && missions.approval && missions.violation,
  };
  const vendorOf = (m?: { recipients: `0x${string}`[] }) => (m?.recipients[0] ?? '0x') as `0x${string}`;

  const loadScenario = (amt: string, label: string, to?: `0x${string}`) => {
    setAmount(amt); if (to) setRecipient(to); setTrackId(null); setReasonVal(null);
    requestAnimationFrame(() => freeFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    setTimeout(() => amountRef.current?.focus(), 420);
    toast(`${label} loaded — press Submit to run it with your wallet.`);
  };

  /** Ask the server whether a demo delegate is truly ready (mandate/slot/cooldown/gas/budget). */
  const ensureReady = async (delegate: string): Promise<boolean> => {
    try {
      const res = await fetch('/api/demo-ready', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delegate }),
        signal: AbortSignal.timeout(8_000),
      });
      const d = await res.json();
      if (d?.ready === false) {
        toast(d.cooldownLeft ? `${d.reason} — ${mmss(d.cooldownLeft)} left` : (d.reason ?? 'demo treasury not ready — retry shortly'), true);
        return false;
      }
      return true;
    } catch {
      toast('Demo readiness check timed out. No transaction was sent; retry when the connection is stable.', true);
      return false;
    }
  };

  const beginSubmission = (mission: MissionKey | 'free', label: string) => {
    if (busy || !acquireOperationLock(submissionLock)) return false;
    setSubmittingScenario(mission);
    setFlow('preflight', label, 4);
    return true;
  };

  const finishSubmission = (result: 'bound' | 'recovering' | 'failed') => {
    releaseOperationLock(submissionLock);
    setSubmittingScenario(null);
    if (result === 'failed') clearFlow();
  };

  const runScenario = async (key: MissionKey) => {
    if (!myMandate || busy || submissionLock.current) return;
    if (blockingRequest) { toast('A payment is still in flight — it clears in under a minute.', true); return; }
    if (key === 'routine' || key === 'approval') {
      const scenario = scenarioByKey(key);
      const amt = scenario.amount;
      if (!isDemo) { loadScenario(amt, scenario.vendor, scenario.recipient); return; }
      if (!beginSubmission(key, `Checking ${scenario.vendor} payment readiness…`)) return;
      let result: 'bound' | 'recovering' | 'failed' = 'failed';
      try {
        if (!(await ensureReady(account!))) return;
        if (!myMandate.recipients.some((r) => r.toLowerCase() === scenario.recipient.toLowerCase())) {
          toast('The demo treasury is refreshing its recipient policy. Try again in about two minutes.', true);
          return;
        }
        result = await submitCore(account!, myMandate.id, scenario.recipient, amt, key);
      } finally {
        finishSubmission(result);
      }
      return;
    }
    // violation: use the dedicated delegate so the main one never enters cooldown
    if (isDemo && violationMandate && violationCoolLeft <= 0) {
      const scenario = scenarioByKey('violation');
      if (!beginSubmission('violation', `Checking ${scenario.vendor} payment readiness…`)) return;
      let result: 'bound' | 'recovering' | 'failed' = 'failed';
      try {
        if (!(await ensureReady(VIOLATION_DELEGATE.address))) return;
        if (!violationMandate.recipients.some((r) => r.toLowerCase() === scenario.recipient.toLowerCase())) {
          toast('The isolated demo mandate is refreshing its recipient policy. Try again shortly.', true);
          return;
        }
        result = await submitCore(VIOLATION_DELEGATE.address, violationMandate.id, scenario.recipient, scenario.amount, 'violation');
      } finally {
        finishSubmission(result);
      }
      return;
    }
    if (isDemo && violationMandate) {
      // A shared visitor's request is useful live evidence, but its memo is
      // bound to another run and must never advance this session or its audit.
      const exhibit = [...requests].reverse().find((r) => r.mandateId === violationMandate.id && r.state === 4);
      if (exhibit) {
        setReasonVal(null); setLastAmount('600'); setLastTx(null); setMissionOf(null); setTrackId(exhibit.id);
        toast('Another run just triggered this live block. You may inspect it, but it cannot complete or enter your run-bound audit packet.');
        setTimeout(() => receiptRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 250);
        return;
      }
      toast(`The violation delegate is cooling down (${mmss(violationCoolLeft)}) — try again shortly.`, true);
      return;
    }
    // own wallet (or setup missing): run it on the caller's own mandate
    const scenario = scenarioByKey('violation');
    loadScenario(scenario.amount, scenario.vendor, scenario.recipient);
  };

  const runFreePlay = async () => {
    if (!amount || submissionLock.current || busy) return;
    if (isDemo ? (freeplayBlocking || freeplayCoolLeft > 0) : (blockingRequest || mainCoolLeft > 0)) return;
    if (!beginSubmission('free', 'Checking confidential payment readiness…')) return;
    let result: 'bound' | 'recovering' | 'failed' = 'failed';
    try {
      if (!isDemo) {
        result = await submitCore(account!, myMandate!.id, (recipient || vendorOf(myMandate)) as `0x${string}`, amount, 'free');
        return;
      }
      if (!freeplayMandate) {
        toast('Free-play treasury is being provisioned — try again in ~2 min.', true);
        return;
      }
      if (!(await ensureReady(FREEPLAY_DELEGATE.address))) return;
      result = await submitCore(FREEPLAY_DELEGATE.address, freeplayMandate.id, vendorOf(freeplayMandate), amount, 'free');
    } finally {
      finishSubmission(result);
    }
  };

  const decryptReason = async () => {
    if (!latest) return;
    setReasonBusy(true);
    try {
      const client = await handleClientFor(latest.delegate);
      const { value } = await client.decrypt(latest.blockedReason as any);
      const n = Number(value);
      setReasonVal(`${n} · ${REASONS[n] ?? 'unknown'}`);
      if (missionOf === 'violation') {
        const tracked = loadTrack();
        const runId = tracked?.runId ?? activeRunId();
        const expectedMemo = demoMemoHash(runId, 'violation', latest.mandateId, latest.delegate);
        if (latest.memoHash.toLowerCase() === expectedMemo.toLowerCase()) {
          setMissions(completeMission('violation', {
            requestId: latest.id,
            outcome: 'blocked',
            reasonDecrypted: true,
            runId,
          }));
        } else {
          toast('Reason unlocked for this live exhibit, but it belongs to another run and was not added to your mission.', true);
        }
      }
    } catch (e: any) {
      toast(`Decrypt refused: ${e?.message ?? e}`.slice(0, 260), true);
    } finally { setReasonBusy(false); }
  };

  const decideEscalation = async (action: 'approve' | 'reject') => {
    if (!latest || latest.state !== 3 || !acquireOperationLock(decisionLock)) return;
    setDecisionBusy(action);
    setDecisionError(null);
    try {
      const tracked = loadTrack();
      const runId = tracked?.runId ?? activeRunId();
      let data: any;
      for (let attempt = 0; attempt < 45; attempt++) {
        const res = await fetch('/api/demo-decision', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runId, requestId: String(latest.id), action }),
          signal: AbortSignal.timeout(15_000),
        });
        data = await res.json().catch(() => ({}));
        if (res.status === 202) {
          if (attempt === 0) toast('The Safe decision is being assembled. Recovering its on-chain receipt…');
          await new Promise((resolve) => setTimeout(resolve, 1_500));
          continue;
        }
        if (!res.ok) throw new Error(data?.error ?? data?.code ?? 'committee decision failed');
        break;
      }
      if (!data?.ok || data?.state !== (action === 'approve' ? 'safe-approved' : 'safe-rejected')) {
        throw new Error('committee decision did not return a confirmed terminal receipt');
      }
      confirmApprovalDecision(latest.id, action, { runId, transactionHash: data.hash });
      setMissions(completeMission('approval', {
        requestId: latest.id,
        outcome: action === 'reject' ? 'cancelled' : 'executed',
        decision: action,
        runId,
      }));
      toast(action === 'approve'
        ? 'Safe 2-of-2 approved the payment. Confirming the confidential payout…'
        : 'Safe 2-of-2 rejected the payment. Confirming escrow return and budget restoration…');
      for (let i = 0; i < 12; i++) {
        refresh();
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }
      fetchRequestTxs(true).then(setTxs).catch(() => {});
    } catch (e: any) {
      const message = e?.message ?? String(e);
      setDecisionError(message);
      toast(`Decision not completed: ${message}. Your request remains recoverable from this page.`, true);
    } finally {
      setDecisionBusy(null);
      releaseOperationLock(decisionLock);
    }
  };

  if (!account)
    return <NoRole demo="delegate" title="Act as a Delegate"
      body="A delegate submits encrypted spend requests and watches the TEE decide. Connect your own wallet and get it provisioned as a delegate (below), or jump into the shared demo delegate to try the flow instantly." />;
  if (!myMandate && !lastUpdated)
    return (
      <section className="card workspace-loading" role="status" aria-live="polite">
        <h2>Payment Inbox</h2>
        <p className="muted">{loadError ? 'Sepolia state is temporarily unavailable. No provisioning action is shown until the current mandate registry is known.' : 'Loading the current mandate and run-bound request evidence from Sepolia…'}</p>
        {loadError ? <button type="button" className="btn" onClick={refresh}>Retry chain state</button> : <div className="operation-track loading-track" aria-hidden="true"><span className="active" /><span /><span /><span /><span /></div>}
      </section>
    );
  if (!myMandate)
    return <ProvisionMe account={account} />;

  const selectedStory = scenarioByKey(selectedScenario);
  const latestStory = scenarioByRecipient(latest?.recipient) ?? (missionOf && missionOf !== 'free' && missionOf !== 'audit' ? scenarioByKey(missionOf as DemoScenarioKey) : undefined);
  const vendor = (latest?.recipient ?? selectedStory.recipient) as `0x${string}`;
  const vName = latestStory?.vendor ?? vendorName(vendor) ?? short(vendor);
  const stage = !latest ? (flow ? (PAYMENT_PHASE_INDEX[flow.phase] >= 3 ? 2 : 1) : busy ? 1 : 0) : latest.state === 1 ? 2 : 3;
  const inFlight = stage === 1 || stage === 2;
  const terminal = latest && latest.state !== 1 && latest.state !== 3;
  const escalated = latest?.state === 3;
  const allCollected = missions.routine && missions.approval && missions.violation;
  const demoComplete = allCollected && missions.audit;
  const sessionSnapshot = loadDemoSession();
  const confirmedApproval = latest && sessionSnapshot?.missions.approval.requestId === String(latest.id)
    && sessionSnapshot.missions.approval.decisionConfirmed === true
    ? sessionSnapshot.missions.approval.decision
    : undefined;
  const selectedOperationActive = !!flow
    && (submittingScenario === selectedStory.key || missionOf === selectedStory.key);
  const freePlayOperationActive = !!flow
    && (submittingScenario === 'free' || missionOf === 'free');

  const primaryNext = () => {
    if (!missions.routine) return { label: '▶ Run: Routine payment', act: () => runScenario('routine') };
    if (!missions.approval) return { label: 'Continue: Approval challenge →', act: () => runScenario('approval') };
    if (!missions.violation) return { label: 'Continue: Policy violation →', act: () => runScenario('violation') };
    return {
      label: 'Build the Launch Day disclosure bundle →',
      act: () => { window.location.hash = formatAppRoute({ page: 'disclosure-builder' }); },
    };
  };

  // ---------------- render ----------------
  return (
    <div className="paygrid">
      <div className="paymain">
        {/* 3-step strip — only while something is actually processing */}
        {inFlight && (
          <div className="journey three">
            <div className={`jstep ${stage === 1 ? 'active' : 'done'}`}><b><span className="jn">1</span>Submit payment</b>encrypted in your browser, then sent</div>
            <div className={`jstep ${stage === 2 ? 'active' : ''}`}><b><span className="jn">2</span>Private policy check</b>TEE evaluates on ciphertext · proof lands on-chain (~15–40s)</div>
            <div className="jstep"><b><span className="jn">3</span>Result</b>executed / needs approval / blocked</div>
          </div>
        )}

        {/* ---- receipt / live committee card ---- */}
        {latest && (terminal || escalated) && (
          <div ref={receiptRef} data-tour="outcome"
            className={`receipt ${latest.state === 2 ? 'ok' : latest.state === 3 ? 'warn' : latest.state === 4 ? 'bad' : 'dim'}`}>
            <div className="r-head">
              {latest.state === 2 && <b>✓ Payment completed privately</b>}
              {latest.state === 3 && <b>⏸ Payment held for approval</b>}
              {latest.state === 4 && <b>⛔ Payment blocked — treasury protected</b>}
              {(latest.state === 5 || latest.state === 6) && <b>Request {latest.state === 5 ? 'cancelled' : 'expired'}</b>}
              <span className="mono muted">#{String(latest.id)}</span>
            </div>
            <div className="r-rows">
              {lastAmount && <div className="r-row"><span>Amount</span><span><b>{lastAmount} cUSDC</b> → {vName} <i className="muted">(visible only to you)</i></span></div>}
              {!lastAmount && <div className="r-row"><span>Paid to</span><span>{vName} <span className="mono muted">{short(latest.recipient)}</span></span></div>}
              <div className="r-row"><span>Policy result</span><span>{latest.state === 2 ? (confirmedApproval === 'approve' ? 'Committee approved the policy exception' : missionOf === 'routine' ? 'Within mandate' : 'Executed · path evidence indexing') : latest.state === 3 ? 'Committee sign-off required' : latest.state === 4 ? 'Blocked by the confidential policy' : latest.state === 5 ? (confirmedApproval === 'reject' ? 'Committee rejected the policy exception' : 'Cancelled and refunded; no user Reject is claimed') : '—'}</span></div>
              {latest.state === 3 && <div className="r-row"><span>Funds</span><span className="ok-text">reserved in escrow — nothing moves without the 2-of-2</span></div>}
              {latest.state === 4 && <div className="r-row"><span>Funds</span><span className="ok-text">untouched — budget intact, cooldown armed</span></div>}
              {latest.state === 5 && <div className="r-row"><span>Funds</span><span className="ok-text">returned from escrow · delegated budget restored</span></div>}
              {latest.state === 4 && (
                <div className="r-row"><span>Private reason</span>
                  <span>{reasonVal ? <b className="value">{reasonVal}</b> : <i className="muted">encrypted — only you can open it</i>}</span>
                </div>
              )}
              {confirmedApproval === 'approve' && latest.state === 2 && (
                <div className="r-row"><span>Committee</span>
                  <span className="ok-text">✓ approved by a real Safe 2-of-2{txs.get(String(latest.id))?.approval && <> · <a className="alink mono" href={scanTx(txs.get(String(latest.id))!.approval!)} target="_blank" rel="noopener">view approval ↗</a></>}</span>
                </div>
              )}
              <div className="r-row"><span>Publicly visible</span><span>outcome only — never the number</span></div>
            </div>

            {escalated && (() => {
              const demoReq = isDemoAddr(latest.delegate);
              return (
                <div className="committee-decision" data-tour="committee-decision">
                  <div className="decision-copy">
                    <div className="cl-row done"><span className="cl-dot">✓</span><span>Funds reserved in confidential escrow</span></div>
                    <div className="cl-row active"><span className="cl-dot">2</span>
                      <span>{demoReq ? 'Choose the demo committee outcome' : 'Awaiting the Safe owners'}</span>
                      {demoReq && <span className="mono muted cl-age">server-enforced · 3 min</span>}
                    </div>
                    <p className="muted">
                      {demoReq
                        ? 'Your click selects one tightly-scoped demo action. Both current Safe owner keys stay server-side; the resulting 2-of-2 transaction is real and inspectable.'
                        : 'A connected Safe owner may approve or reject this reserved request. Unapproved requests are cancelled after the disclosed deadline.'}
                    </p>
                  </div>
                  {demoReq ? (
                    <div className="sticky-decision-bar">
                      <button className="btn danger" disabled={!!decisionBusy} onClick={() => decideEscalation('reject')}>
                        {decisionBusy === 'reject' ? <><span className="spin" /> Returning funds…</> : 'Reject & return funds'}
                      </button>
                      <button className="btn primary" disabled={!!decisionBusy} onClick={() => decideEscalation('approve')}>
                        {decisionBusy === 'approve' ? <><span className="spin" /> Executing 2-of-2…</> : 'Approve payment'}
                      </button>
                    </div>
                  ) : <button className="btn primary" onClick={() => goTab('Signer')}>Open approval workspace →</button>}
                  {decisionError && <div className="inline-alert bad" role="alert">{decisionError} · Refresh or retry; escrow remains recoverable.</div>}
                </div>
              );
            })()}

            {terminal && (
              <PrivacyLens
                authorized={[
                  { label: 'Amount', value: `${lastAmount || latestStory?.amount || 'Encrypted value'} cUSDC` },
                  { label: 'Recipient', value: vName },
                  { label: 'Purpose', value: latestStory?.purpose ?? 'Private payment memo' },
                  { label: 'Outcome', value: latest.state === 2 ? 'Executed' : latest.state === 4 ? 'Blocked' : latest.state === 5 ? 'Rejected · funds returned' : 'Expired' },
                  ...(latest.state === 4 ? [{ label: 'Reason', value: reasonVal ?? 'Encrypted · decrypt to inspect' }] : []),
                ]}
                publicView={[
                  { label: 'Amount', value: <span className="enc">Encrypted handle</span> },
                  { label: 'Recipient', value: <span className="mono">{short(latest.recipient)}</span> },
                  { label: 'Memo', value: <span className="mono">{short(latest.memoHash)}</span> },
                  { label: 'Outcome', value: latest.state === 2 ? 'EXECUTED' : latest.state === 4 ? 'BLOCKED' : latest.state === 5 ? 'CANCELLED' : 'EXPIRED' },
                  { label: 'Policy values', value: <span className="enc">Protected</span> },
                ]}
              />
            )}

            {!escalated && (
              <div className="r-cta">
                {latest.state === 4 && !reasonVal
                  ? <button className="btn primary" disabled={reasonBusy} onClick={decryptReason}>{reasonBusy ? <><span className="spin" /> Decrypting…</> : '🔓 Decrypt the private reason'}</button>
                  : <button className="btn primary" disabled={!!busy} onClick={primaryNext().act}>{primaryNext().label}</button>}
                <details className="more-menu">
                  <summary>More actions ▾</summary>
                  <div className="mm-body">
                    <button className="mm-item" onClick={() => { setTrackId(null); setReasonVal(null); }}>Send another payment</button>
                    <button className="mm-item" onClick={() => loadScenario(amount || '25', 'Custom payment')}>Enter a custom amount</button>
                    {lastTx && <a className="mm-item" href={scanTx(lastTx)} target="_blank" rel="noopener">View transaction proof ↗</a>}
                    <button className="mm-item" onClick={() => goTab('Dashboard')}>See it in the evidence table</button>
                  </div>
                </details>
              </div>
            )}

            <details className="privacy-acc slim">
              <summary>Why was this private? ▾</summary>
              <p className="muted" style={{ fontSize: 13 }}>
                Your amount was encrypted in the browser. Nox evaluated the confidential policy inside a TEE —
                budget, balance and reserve rules, all on ciphertext. Only the coarse outcome became public,
                and the payout (if any) moved as an ERC-7984 confidential transfer.
              </p>
            </details>
          </div>
        )}

        {/* ---- payment inbox + selected request detail ---- */}
        <section className="workbench payment-workbench" aria-labelledby="payment-inbox-title">
          <div className="object-list">
            <div className="object-list-head">
              <div><h2 id="payment-inbox-title">Payment Inbox</h2><p>Launch Day Treasury Shift</p></div>
              <span className="object-count">{DEMO_SCENARIOS.length}</span>
            </div>
            {DEMO_SCENARIOS.map((scenario) => {
              const done = missions[scenario.key];
              const locked = !unlocked[scenario.key];
              return (
                <button key={scenario.key} type="button"
                  className={`object-row ${selectedScenario === scenario.key ? 'selected' : ''}`}
                  onClick={() => setSelectedScenario(scenario.key)}
                  aria-pressed={selectedScenario === scenario.key}
                  data-tour={`scenario-${scenario.key}`}>
                  <span className={`object-avatar ${done ? 'ok' : locked ? 'muted' : ''}`}>{scenario.vendor.slice(0, 1)}</span>
                  <span className="object-row-copy">
                    <b>{scenario.vendor}</b>
                    <small>{scenario.purpose}</small>
                    {scenario.urgency && <em>{scenario.urgency}</em>}
                  </span>
                  <span className="object-row-end">
                    <b>{scenario.amount} cUSDC</b>
                    <small>{done ? 'Complete' : locked ? 'Finish prior invoice' : 'Ready to review'}</small>
                  </span>
                </button>
              );
            })}
          </div>

          <article className="detail-pane" aria-label={`${selectedStory.vendor} payment detail`}>
            <header className="detail-header">
              <div>
                <span className="detail-kicker">Payment request · {selectedStory.urgency ?? 'Launch day'}</span>
                <h2>{selectedStory.vendor}</h2>
                <p>{selectedStory.purpose}</p>
              </div>
              <span className={missions[selectedStory.key] ? 'status-badge ok' : 'status-badge'}>
                {missions[selectedStory.key] ? 'Completed' : 'Draft'}
              </span>
            </header>

            <dl className="data-list">
              <div><dt>Amount</dt><dd>{selectedStory.amount} cUSDC <span className="privacy-note">visible to Delegate</span></dd></div>
              <div><dt>Recipient</dt><dd>{selectedStory.vendor}<span className="mono muted">{short(selectedStory.recipient)}</span></dd></div>
              <div><dt>Mandate</dt><dd className="mono">#{String(selectedStory.isolatedDelegate ? violationMandate?.id ?? 'provisioning' : myMandate.id)}</dd></div>
              <div><dt>Public memo</dt><dd>Only a run-bound hash is published</dd></div>
            </dl>

            <div className="policy-evaluation" aria-label="Confidential policy checks">
              <h3>Private policy evaluation</h3>
              <p>The result remains unknown until Nox evaluates all three checks on ciphertext.</p>
              <div className="evaluation-grid">
                {['Per-payment auto-limit', 'Delegated budget', 'Treasury reserve floor'].map((label) => (
                  <div key={label}><span>{label}</span><b className="enc">Protected</b></div>
                ))}
              </div>
            </div>

            {selectedOperationActive && flow && <PaymentProgress flow={flow} isDemo={isDemo} />}

            <div className="detail-actions">
              {!unlocked[selectedStory.key] ? (
                <div className="inline-alert">Complete the previous invoice before submitting this one.</div>
              ) : (
                <button
                  className={`btn primary ${selectedOperationActive ? 'is-busy' : ''}`}
                  disabled={!!busy || submissionLock.current || !!flow || (!!blockingRequest && selectedStory.key !== 'violation')}
                  aria-busy={selectedOperationActive}
                  onClick={() => void runScenario(selectedStory.key)}
                >
                  {selectedOperationActive
                    ? <><span className="spin" aria-hidden="true" /> {flow?.phase === 'preflight' ? 'Checking readiness…' : flow?.phase === 'encrypting' ? 'Encrypting payment…' : flow?.phase === 'recovering' ? 'Recovering request…' : 'Payment in progress…'}</>
                    : missions[selectedStory.key] ? 'Run this invoice again' : 'Submit confidential payment'}
                </button>
              )}
              <span className="muted">Review first, then submit. The policy never reveals its thresholds.</span>
            </div>
            {selectedStory.key === 'violation' && isDemo && violationCoolLeft > 0 && (
              <div className="inline-alert">The isolated stress-test delegate is cooling down. A verified recent block can be reviewed now; a fresh run is available in {mmss(violationCoolLeft)}.</div>
            )}
          </article>
        </section>

        {/* ---- free play (demo: own sandboxed delegate; collapsed until missions done) ---- */}
        <details className="card prog-acc" data-tour="submit" ref={freeFormRef as any}
          {...(!isDemo || allCollected ? { open: true } : {})}>
          <summary><h3 style={{ display: 'inline' }}>Free play <small>your own amount — the outcome is unknown until the TEE evaluates it</small></h3></summary>
          {isDemo && (
            <p className="muted" style={{ fontSize: 12.5, margin: '6px 0 10px' }}>
              Free play runs on its own sandboxed delegate — experiment freely, the guided missions can never be frozen by it.
            </p>
          )}
          {(isDemo ? freeplayCoolLeft : mainCoolLeft) > 0 && (
            <div className="cooldown-bar">
              ⏳ <b>Anti-probing cooldown</b> — a blocked payment freezes this delegate for 10 minutes so the
              secret limits can't be binary-searched. Ready in <b className="mono">{mmss(isDemo ? freeplayCoolLeft : mainCoolLeft)}</b>.
            </div>
          )}
          <label>Pay to</label>
          {myMandate.recipients.length > 1 ? (
            <select value={recipient || myMandate.recipients[0]} onChange={(e) => setRecipient(e.target.value)}>
              {myMandate.recipients.map((r) => <option key={r} value={r}>{vendorName(r) ?? short(r)} · {short(r)}</option>)}
            </select>
          ) : (
            <div className="vendor-card">
              <div><b>{vendorName(myMandate.recipients[0]) ?? 'Approved recipient'}</b>
                <span className="mono muted"> {short(myMandate.recipients[0])}</span></div>
              <button className="btn small ghost" onClick={() => { navigator.clipboard?.writeText(myMandate.recipients[0]); toast('Address copied'); }}>copy</button>
            </div>
          )}
          <label>Amount (cUSDC) — encrypted in your browser before it leaves</label>
          <input ref={amountRef} value={amount} onChange={(e) => setAmount(e.target.value)} type="number" min="0" step="0.01" />
          <label>Memo (only its hash goes on-chain)</label>
          <input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="invoice #… (optional)" />
          {freePlayOperationActive && flow && <PaymentProgress flow={flow} isDemo={isDemo} />}
          <div style={{ marginTop: 14 }}>
            <button
              className={`btn primary ${freePlayOperationActive ? 'is-busy' : ''}`}
              disabled={!!busy || submissionLock.current || !!flow || !amount || (isDemo ? (!!freeplayBlocking || freeplayCoolLeft > 0) : (!!blockingRequest || mainCoolLeft > 0))}
              aria-busy={freePlayOperationActive}
              onClick={() => void runFreePlay()}
            >
              {freePlayOperationActive ? <><span className="spin" aria-hidden="true" /> Payment in progress…</> : 'Submit confidential payment'}
            </button>
            {(isDemo ? freeplayBlocking : blockingRequest) && <p className="muted" style={{ fontSize: 12, marginTop: 7 }}>A payment is in flight — it clears automatically in under a minute.</p>}
          </div>
        </details>

        <details className="card prog-acc" {...(!isDemo || allCollected ? { open: true } : {})}>
          <summary><h3 style={{ display: 'inline' }}>My payments</h3></summary>
          <div className="tbl"><table>
            <thead><tr><th>ID</th><th>To</th><th>Outcome</th><th>Reason</th></tr></thead>
            <tbody>
              {myRequests.slice(0, 10).map((r) => (
                <tr key={String(r.id)} className={flashIds.has(String(r.id)) ? 'row-flash' : ''}>
                  <td className="mono">#{String(r.id)}</td>
                  <td>{vendorName(r.recipient) ?? short(r.recipient)}</td>
                  <td><RequestPill state={r.state} decisionReady={r.decisionReady} /></td>
                  <td>{r.state === 4 ? <ReasonCell r={r} /> : <span className="muted">—</span>}</td>
                </tr>
              ))}
              {!myRequests.length && <tr><td colSpan={4} className="muted">No payments yet — run the first scenario above.</td></tr>}
            </tbody>
          </table></div>
        </details>
      </div>

      {/* ---------------- mission panel ---------------- */}
      <aside className="mission-panel">
        <div className="card mp-card">
          <h3>Your mission</h3>
          {!allCollected ? (
            <p className="mp-goal">{MISSIONS.find((m) => !missions[m.key])?.goal}</p>
          ) : !missions.audit ? (
            <p className="mp-goal">All three outcomes collected — create the run-bound disclosure bundle.</p>
          ) : (
            <p className="mp-goal ok-text">Demo completed — you've seen the whole confidential loop.</p>
          )}
          <div className="mp-list">
            {MISSIONS.map((m) => (
              <div key={m.key} className={`mp-row ${missions[m.key] ? 'done' : ''}`}>
                <span className="mp-dot">{missions[m.key] ? '✓' : '○'}</span>
                <span>{m.title}</span>
                <span className="mp-out muted">{m.outcome}</span>
              </div>
            ))}
            <div className={`mp-row ${missions.audit ? 'done' : ''}`}>
              <span className="mp-dot">{missions.audit ? '✓' : '○'}</span>
              <span>Create and audit the packet</span>
              <span className="mp-out muted">selective disclosure</span>
            </div>
          </div>

          {allCollected && !missions.audit && (
            <button className="btn primary wide" style={{ marginTop: 12 }} onClick={() => { window.location.hash = formatAppRoute({ page: 'disclosure-builder' }); }}>
              Build the Launch Day disclosure bundle →
            </button>
          )}
          {demoComplete && (
            <div className="mp-doneblock">
              <div className="mp-donetitle">Demo completed</div>
              {['Confidential state', 'Confidential computation', 'Confidential execution', 'Safe 2-of-2 governance', 'Selective disclosure'].map((t) => (
                <div key={t} className="mp-row done"><span className="mp-dot">✓</span><span>{t}</span></div>
              ))}
              <button className="btn primary wide" style={{ marginTop: 10 }} onClick={() => goTab('Verify')}>Verify every step on Sepolia →</button>
            </div>
          )}
        </div>

        <div className="card mp-card">
          <h3>Privacy checks <small>live on every payment</small></h3>
          <div className="mp-priv">
            <div className="mp-row"><span>Per-payment auto-limit</span><span className="enc">🔒 hidden</span></div>
            <div className="mp-row"><span>Delegated budget</span><span className="enc">🔒 hidden</span></div>
            <div className="mp-row"><span>Treasury reserve floor</span><span className="enc">🔒 hidden</span></div>
            <div className="mp-row"><span>Your amounts</span><span className="enc">🔒 encrypted</span></div>
          </div>
          <p className="muted" style={{ fontSize: 12, marginTop: 9 }}>
            The TEE checks every rule on ciphertext — you never see the numbers, they never see daylight.
          </p>
        </div>
      </aside>
    </div>
  );
}

/** Reason decryptor bound to the ROW's delegate identity (demo keys sign locally). */
function ReasonCell({ r }: { r: SpendRequest }) {
  const { toast } = useApp();
  const [v, setV] = useState<string>();
  const [b, setB] = useState(false);
  if (v) return <span className="value">{v}</span>;
  return (
    <button className="btn small ghost" disabled={b} onClick={async () => {
      setB(true);
      try {
        const c = await handleClientFor(r.delegate);
        const { value } = await c.decrypt(r.blockedReason as any);
        const n = Number(value);
        setV(`${n} · ${REASONS[n] ?? 'unknown'}`);
      } catch (e: any) { toast(`Decrypt refused: ${e?.message ?? e}`.slice(0, 200), true); }
      finally { setB(false); }
    }}>{b ? <span className="spin" /> : '🔓 Reason'}</button>
  );
}

/**
 * Sponsored onboarding: a connected wallet asks the server-side provisioner
 * (which holds the admin + Safe-owner keys, never the browser) to propose and
 * 2-of-2 activate a small capped mandate for THIS address. Afterwards the user
 * submits requestSpend with their own wallet and gas.
 */
function ProvisionMe({ account }: { account: `0x${string}` }) {
  const { refresh, toast, startDemo, openRolePicker } = useApp();
  const [busy, setBusy] = useState(false);

  const provision = async () => {
    setBusy(true);
    try {
      const res = await fetch(PROVISION_API, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: account }),
        signal: AbortSignal.timeout(120_000),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'provisioning failed');
      toast(`✓ Your wallet is now a delegate on mandate #${data.mandateId}. Submit an encrypted request below — you'll need a little Sepolia ETH for gas (see 💧 Get test funds).`);
      setTimeout(refresh, 2500);
    } catch (e: any) {
      toast(`Provisioning failed: ${e?.message ?? e}`, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="norole">
      <h3>Use your own wallet as a delegate</h3>
      <p className="muted" style={{ fontSize: 13.5, maxWidth: 660 }}>
        The module only accepts the delegate address fixed in a mandate — so to act as a delegate with{' '}
        <b>your own wallet</b> (<span className="mono">{short(account)}</span>), the treasury has to grant it one.
        Click below and the sponsored provisioner will propose an encrypted mandate for your address and activate
        it with a <b>real 2-of-2 Safe multisig</b> (two distinct owner signatures, threshold 2 — produced here by the demo's own keys, not a multi-party approval queue). Then you submit
        requests yourself, signing with your own wallet.
      </p>
      <div className="row" style={{ marginTop: 14 }}>
        <button className="btn primary" disabled={busy} onClick={provision}>
          {busy ? <><span className="spin" /> Provisioning (2-of-2 activation, ~30s)…</> : '🔑 Provision my wallet as a delegate'}
        </button>
        <button className="btn" onClick={() => startDemo('delegate')}>or use the shared demo delegate</button>
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
        Onboarding is sponsored (the treasury pays the two governance txs); you then sign requests with your own wallet and gas. The capped demo policy remains encrypted; only its terminal outcomes are public ·
        one per address per hour. You'll need a little Sepolia ETH to submit requests —{' '}
        <button className="btn small ghost" onClick={openRolePicker} style={{ display: 'none' }}>x</button>
        grab some from 💧 Get test funds.
      </p>
    </div>
  );
}
