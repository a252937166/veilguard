import { useEffect, useMemo, useRef, useState } from 'react';
import { encodeAbiParameters, keccak256 } from 'viem';
import { Workbench, WorkbenchDetail, WorkbenchList, WorkbenchTabs } from '../components/workbench';
import { ADDR, CHAIN_ID, fmt, moduleAbi, scan, scanTx, short } from '../config';
import { handleClientFor, publicClient, waitResolved } from '../nox';
import { fetchRequestTxs, type RequestTxs } from '../txlog';
import { useApp } from '../App';
import { completeMission } from '../missions';
import { loadDemoSession } from '../demo-session';
import { formatAppRoute, parseAppHash } from '../routes';
import { NoRole, RequestPill } from '../ui';

type Packet = {
  id: bigint;
  auditor: `0x${string}`;
  mandateId: bigint;
  policyVersion: number;
  manifestHash: `0x${string}`;
  createdAt: bigint;
  requestIds: bigint[];
  snapshotHandles: `0x${string}`[];
};

type AuditTab = 'Overview' | 'Requests' | 'Verification' | 'Export';
type ReviewDisposition = 'reviewed' | 'flagged';
type ReviewMap = Record<string, ReviewDisposition>;
type StoredReviews = Record<string, ReviewMap>;

const REVIEW_STORAGE_KEY = 'vg_audit_reviews_v1';
const TERMINAL_REQUEST_STATES = new Set([2, 4, 5, 6]);

function reviewStorageKey(account: string, packetId: bigint) {
  return `${CHAIN_ID}:${ADDR.VeilGuardModule.toLowerCase()}:${account.toLowerCase()}:${packetId}`;
}

function loadStoredReviews(key: string): ReviewMap {
  try {
    const all = JSON.parse(localStorage.getItem(REVIEW_STORAGE_KEY) ?? '{}') as StoredReviews;
    return all[key] ?? {};
  } catch {
    return {};
  }
}

function saveStoredReviews(key: string, reviews: ReviewMap) {
  try {
    const all = JSON.parse(localStorage.getItem(REVIEW_STORAGE_KEY) ?? '{}') as StoredReviews;
    localStorage.setItem(REVIEW_STORAGE_KEY, JSON.stringify({ ...all, [key]: reviews }));
  } catch {
    // Review state is a local workflow aid. Chain data remains the source of truth.
  }
}

function rawValue(value: unknown): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return BigInt(value).toString();
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  throw new Error('The gateway returned an unsupported decrypted value.');
}

function reasonLabel(value: string) {
  const reason = Number(value);
  return reason === 0 ? 'No blocked reason' : ({ 1: 'Policy budget', 2: 'Treasury balance', 3: 'Treasury reserve' }[reason] ?? `Reason code ${reason}`);
}

function packetManifest(packet: Packet) {
  try {
    return keccak256(encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'uint256' },
        { type: 'uint32' },
        { type: 'uint256[]' },
        { type: 'bytes32[]' },
      ],
      [packet.auditor, packet.mandateId, packet.policyVersion, packet.requestIds, packet.snapshotHandles],
    ));
  } catch {
    return undefined;
  }
}

function packetIdFromHash() {
  if (typeof window === 'undefined') return null;
  const route = parseAppHash(window.location.hash);
  if (route?.page !== 'audit-detail' || !/^\d+$/.test(route.packetId)) return null;
  return BigInt(route.packetId);
}

function TxLink({ hash, label = 'View' }: { hash?: `0x${string}`; label?: string }) {
  return hash ? (
    <a className="mono alink" href={scanTx(hash)} target="_blank" rel="noopener noreferrer">
      {label} · {hash.slice(0, 8)}…
    </a>
  ) : <span className="muted">Not indexed</span>;
}

export function AuditorView() {
  const { account, toast, requests } = useApp();
  const [packets, setPackets] = useState<Packet[]>([]);
  const [packetsLoading, setPacketsLoading] = useState(true);
  const [packetsError, setPacketsError] = useState(false);
  const [selected, setSelected] = useState<bigint | null>(packetIdFromHash);
  const [tab, setTab] = useState<AuditTab>('Overview');
  const [txs, setTxs] = useState<Map<string, RequestTxs>>(new Map());
  const [values, setValues] = useState<Record<string, string>>({});
  const [reviews, setReviews] = useState<ReviewMap>({});
  const [bulk, setBulk] = useState(false);
  const [bulkDone, setBulkDone] = useState(0);
  const [unlockingHandle, setUnlockingHandle] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const completedGate = useRef(new Set<string>());

  useEffect(() => {
    fetchRequestTxs().then(setTxs).catch(() => { /* Transaction links remain explicitly unavailable. */ });
  }, []);

  useEffect(() => {
    const onHashChange = () => setSelected(packetIdFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setPacketsLoading(true);
    setPacketsError(false);
    (async () => {
      try {
        const next = await publicClient.readContract({
          address: ADDR.VeilGuardModule,
          abi: moduleAbi,
          functionName: 'nextPacketId',
        }) as bigint;
        const ids = Array.from({ length: Math.max(0, Number(next) - 1) }, (_, index) => BigInt(index + 1));
        const raw = await Promise.all(ids.map((id) => publicClient.readContract({
          address: ADDR.VeilGuardModule,
          abi: moduleAbi,
          functionName: 'getAuditPacket',
          args: [id],
        }) as Promise<any[]>));
        const loaded = raw.map((packet, index): Packet => ({
          id: ids[index],
          auditor: packet[0],
          mandateId: packet[1],
          policyVersion: Number(packet[2]),
          manifestHash: packet[3],
          createdAt: packet[4],
          requestIds: packet[5] as bigint[],
          snapshotHandles: packet[6] as `0x${string}`[],
        }));
        if (!cancelled) setPackets(loaded);
      } catch (error) {
        console.error('audit packets', error);
        if (!cancelled) setPacketsError(true);
      } finally {
        if (!cancelled) setPacketsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [account]);

  const mine = useMemo(
    () => packets.filter((packet) => account && packet.auditor.toLowerCase() === account.toLowerCase()),
    [packets, account],
  );
  const packet = useMemo(
    () => mine.find((candidate) => candidate.id === selected) ?? mine[mine.length - 1],
    [mine, selected],
  );
  const storageKey = account && packet ? reviewStorageKey(account, packet.id) : '';

  useEffect(() => {
    setReviews(storageKey ? loadStoredReviews(storageKey) : {});
  }, [storageKey]);

  const requestRows = useMemo(() => {
    if (!packet) return [];
    return packet.requestIds.map((requestId) => ({
      requestId,
      request: requests.find((candidate) => candidate.id === requestId),
      tx: txs.get(String(requestId)),
    }));
  }, [packet, requests, txs]);

  const expectedHandleCount = packet ? 3 + packet.requestIds.length * 2 : 0;
  const handleShapeValid = !!packet && packet.snapshotHandles.length === expectedHandleCount;
  const computedManifest = useMemo(() => packet ? packetManifest(packet) : undefined, [packet]);
  const manifestMatches = !!packet && !!computedManifest && computedManifest.toLowerCase() === packet.manifestHash.toLowerCase();
  const packetUnlocked = !!packet && packet.snapshotHandles.every((handle) => values[handle] !== undefined);
  const terminalReconciled = requestRows.every(({ request }) => !!request && TERMINAL_REQUEST_STATES.has(request.state));
  const allDispositioned = !!packet && packet.requestIds.every((requestId) => !!reviews[String(requestId)]);
  const hasRequestScope = !!packet && packet.requestIds.length > 0;
  const gateReady = packetUnlocked && handleShapeValid && manifestMatches && terminalReconciled && allDispositioned && hasRequestScope;
  const reviewedCount = packet?.requestIds.filter((id) => reviews[String(id)] === 'reviewed').length ?? 0;
  const flaggedCount = packet?.requestIds.filter((id) => reviews[String(id)] === 'flagged').length ?? 0;

  const session = loadDemoSession();
  const demoRequestIds = session
    ? [session.missions.routine.requestId, session.missions.approval.requestId, session.missions.violation.requestId].filter((id): id is string => !!id)
    : [];
  const boundPacketIds = session?.missions.audit.packetIds ?? [];
  const runBundleExpected = demoRequestIds.length === 3;
  const activeBundle = runBundleExpected
    ? boundPacketIds
      .map((id) => mine.find((candidate) => String(candidate.id) === id))
      .filter((candidate): candidate is Packet => !!candidate)
    : packet ? [packet] : [];
  const bundleRequestIds = runBundleExpected
    ? session?.missions.audit.includedRequestIds ?? []
    : packet?.requestIds.map(String) ?? [];
  const boundPacketsResolved = !runBundleExpected
    || (boundPacketIds.length > 0 && activeBundle.length === boundPacketIds.length);
  const activeRequestIds = [...new Set(activeBundle.flatMap((candidate) => candidate.requestIds.map(String)))];
  const bundleCoverage = bundleRequestIds.length > 0
    && bundleRequestIds.every((id) => activeBundle.some((candidate) => candidate.requestIds.some((requestId) => String(requestId) === id)));
  const bundleScopeExact = !runBundleExpected
    || (activeRequestIds.length === bundleRequestIds.length
      && activeRequestIds.every((id) => bundleRequestIds.includes(id)));
  const demoStoryReady = !session || (runBundleExpected && boundPacketsResolved && bundleScopeExact);
  const bundleChecks = activeBundle.map((candidate) => {
    const candidateReviews = candidate.id === packet?.id
      ? reviews
      : account ? loadStoredReviews(reviewStorageKey(account, candidate.id)) : {};
    const expected = 3 + candidate.requestIds.length * 2;
    const computed = packetManifest(candidate);
    const unlocked = candidate.snapshotHandles.every((handle) => values[handle] !== undefined);
    const terminal = candidate.requestIds.every((requestId) => {
      const publicRequest = requests.find((request) => request.id === requestId);
      return !!publicRequest && TERMINAL_REQUEST_STATES.has(publicRequest.state);
    });
    const dispositioned = candidate.requestIds.every((requestId) => !!candidateReviews[String(requestId)]);
    return {
      packet: candidate,
      reviews: candidateReviews,
      ready: unlocked
        && candidate.snapshotHandles.length === expected
        && !!computed
        && computed.toLowerCase() === candidate.manifestHash.toLowerCase()
        && terminal
        && dispositioned
        && candidate.requestIds.length > 0,
    };
  });
  const bundleGateReady = demoStoryReady
    && boundPacketsResolved
    && bundleScopeExact
    && bundleCoverage
    && bundleChecks.length > 0
    && bundleChecks.every((check) => check.ready);

  useEffect(() => {
    if (!account || !packet || !bundleGateReady) return;
    const key = `${account.toLowerCase()}:${activeBundle.map((candidate) => candidate.id).join(',')}`;
    if (completedGate.current.has(key)) return;
    completedGate.current.add(key);
    const includedRequestIds = [...new Set(activeBundle.flatMap((candidate) => candidate.requestIds.map(String)))]
      .filter((id) => !demoRequestIds.length || demoRequestIds.includes(id));
    const reviewedRequestIds: string[] = [];
    const flaggedRequestIds: string[] = [];
    for (const check of bundleChecks) {
      for (const requestId of check.packet.requestIds.map(String)) {
        if (check.reviews[requestId] === 'reviewed') reviewedRequestIds.push(requestId);
        if (check.reviews[requestId] === 'flagged') flaggedRequestIds.push(requestId);
      }
    }
    completeMission('audit', {
      packetIds: activeBundle.map((candidate) => candidate.id),
      includedRequestIds,
      reviewedRequestIds,
      flaggedRequestIds,
      packetUnlocked: true,
      integrityVerified: true,
      runId: session?.runId,
    });
    toast(`${activeBundle.length > 1 ? `Review bundle (${activeBundle.length} packets)` : `Packet #${packet.id}`} complete — scope unlocked, manifests verified and every request dispositioned.`);
  }, [account, activeBundle, bundleChecks, bundleGateReady, demoRequestIds, packet, session?.runId, toast]);

  if (!account) {
    return (
      <NoRole
        demo="auditor"
        title="Act as an Auditor"
        body="An auditor can unlock only immutable snapshots explicitly granted by the finance admin. The live policy, future versions and unrelated requests remain inaccessible."
      />
    );
  }

  const decryptHandle = async (handle: `0x${string}`) => {
    const client = await handleClientFor(account);
    await waitResolved([handle]);
    const decrypted = await client.decrypt(handle as any);
    const value = rawValue(decrypted.value);
    setValues((current) => ({ ...current, [handle]: value }));
    return value;
  };

  const unlockPacket = async () => {
    if (!packet) return;
    setBulk(true);
    setBulkDone(0);
    try {
      const client = await handleClientFor(account);
      await waitResolved(packet.snapshotHandles);
      for (const handle of packet.snapshotHandles) {
        if (values[handle] === undefined) {
          const decrypted = await client.decrypt(handle as any);
          setValues((current) => ({ ...current, [handle]: rawValue(decrypted.value) }));
        }
        setBulkDone((done) => done + 1);
      }
      toast(`Packet #${packet.id} unlocked. Review each included request before export.`);
    } catch (error: any) {
      toast(`Unlock failed: ${error?.message ?? error}`, true);
    } finally {
      setBulk(false);
    }
  };

  const inspectHandle = async (handle: `0x${string}`) => {
    setUnlockingHandle(handle);
    try {
      await decryptHandle(handle);
    } catch (error: any) {
      toast(`Decrypt refused: ${error?.message ?? error}`, true);
    } finally {
      setUnlockingHandle(null);
    }
  };

  const setDisposition = (requestId: bigint, disposition: ReviewDisposition) => {
    if (!storageKey || !packetUnlocked) return;
    const next = { ...reviews, [String(requestId)]: disposition };
    setReviews(next);
    saveStoredReviews(storageKey, next);
  };

  const selectPacket = (packetId: bigint) => {
    setSelected(packetId);
    setTab('Overview');
    window.location.hash = formatAppRoute({ page: 'audit-detail', packetId: String(packetId) });
  };

  const displaySnapshot = (handle: `0x${string}`, kind: 'amount' | 'reason' = 'amount') => {
    const value = values[handle];
    if (value === undefined) return <span className="audit-encrypted">Encrypted snapshot</span>;
    return <span className="value">{kind === 'reason' ? reasonLabel(value) : `${fmt(BigInt(value))} cUSDC`}</span>;
  };

  const exportPacket = () => {
    if (!packet || !gateReady || !computedManifest) return;
    setDownloading(true);
    try {
      const requestData = packet.requestIds.map((requestId, index) => {
        const publicRequest = requests.find((candidate) => candidate.id === requestId);
        const requestTx = txs.get(String(requestId));
        return {
          requestId: Number(requestId),
          publicState: publicRequest?.state,
          recipient: publicRequest?.recipient,
          amount: Number(values[packet.snapshotHandles[3 + index * 2]]) / 1e6,
          blockedReason: Number(values[packet.snapshotHandles[4 + index * 2]]),
          disposition: reviews[String(requestId)],
          transactions: requestTx ?? {},
        };
      });
      const document = {
        packetId: Number(packet.id),
        mandateId: Number(packet.mandateId),
        policyVersion: packet.policyVersion,
        auditor: packet.auditor,
        createdAt: new Date(Number(packet.createdAt) * 1000).toISOString(),
        disclosureSchema: 'VeilGuardModule v1 fixed scope',
        policy: {
          autoLimit: Number(values[packet.snapshotHandles[0]]) / 1e6,
          budgetLeftAtPacketTime: Number(values[packet.snapshotHandles[1]]) / 1e6,
          reserveFloor: Number(values[packet.snapshotHandles[2]]) / 1e6,
        },
        requests: requestData,
        integrity: {
          manifestHash: packet.manifestHash,
          recomputedManifestHash: computedManifest,
          matches: true,
          snapshotHandleCount: packet.snapshotHandles.length,
        },
        note: 'Authorised selective-disclosure snapshot. Cross-check public states and transaction hashes on Ethereum Sepolia.',
      };
      const blob = new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = window.document.createElement('a');
      anchor.href = url;
      anchor.download = `veilguard-audit-packet-${packet.id}.json`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      toast(`Packet #${packet.id} exported with its verified manifest and review dispositions.`);
    } catch (error: any) {
      toast(`Export failed: ${error?.message ?? error}`, true);
    } finally {
      setDownloading(false);
    }
  };

  const tabs = [
    { id: 'Overview', label: 'Overview' },
    { id: 'Requests', label: 'Requests', count: packet?.requestIds.length },
    { id: 'Verification', label: 'Verification' },
    { id: 'Export', label: 'Export' },
  ] as const;

  return (
    <>
      <div className="dash-head audit-page-head">
        <div>
          <h1 className="dash-title">Audit packet review</h1>
          <p className="dash-sub">Unlock the granted scope, reconcile every public outcome, then export a manifest-verified review.</p>
        </div>
      </div>

      <div className="notice audit-scope-notice">
        <b>Fixed v1 disclosure schema.</b> Every packet contains the policy auto-limit, budget remaining and reserve floor,
        plus amount and blocked-reason snapshots for each selected request. These are immutable snapshots, not access to live policy state.
      </div>

      {packetsLoading && (
        <div className="card audit-loading" role="status">
          <span className="spin" /> Loading packet manifests from Sepolia…
        </div>
      )}
      {packetsError && !packetsLoading && (
        <div className="notice" role="alert"><b>Packet index unavailable.</b> The public RPC could not load audit packets. No local fallback data is shown.</div>
      )}
      {!packetsLoading && !packetsError && !mine.length && (
        <div className="card audit-empty">
          <h3>No packets granted to this auditor</h3>
          <p className="muted">The finance admin must create an on-chain packet for <span className="mono">{short(account)}</span>. This workspace does not synthesize sample packets.</p>
        </div>
      )}

      {packet && (
        <Workbench className="audit-workbench">
          <WorkbenchList title="Audit packets" description={`${mine.length} granted to ${short(account)}`}>
            <div className="object-list">
              {mine.slice().reverse().map((candidate) => (
                <button
                  type="button"
                  key={String(candidate.id)}
                  className={`object-list-item ${candidate.id === packet.id ? 'active' : ''}`}
                  aria-current={candidate.id === packet.id ? 'true' : undefined}
                  onClick={() => selectPacket(candidate.id)}
                >
                  <span className="object-list-title">Packet #{String(candidate.id)}</span>
                  <span className="object-list-meta">Mandate #{String(candidate.mandateId)} · v{candidate.policyVersion}</span>
                  <span className="object-list-meta">{candidate.requestIds.length} request{candidate.requestIds.length === 1 ? '' : 's'} · {new Date(Number(candidate.createdAt) * 1000).toLocaleDateString()}</span>
                  {activeBundle.some((bundlePacket) => bundlePacket.id === candidate.id) && activeBundle.length > 1 && <span className="object-list-badge">LAUNCH DAY BUNDLE</span>}
                </button>
              ))}
            </div>
          </WorkbenchList>

          <WorkbenchDetail labelledBy="audit-packet-title">
            <header className="workbench-detail-head" data-tour="packets">
              <div>
                <div className="workbench-kicker">Mandate #{String(packet.mandateId)} · Policy v{packet.policyVersion}</div>
                <h2 id="audit-packet-title">Packet #{String(packet.id)}</h2>
                <p>Created {new Date(Number(packet.createdAt) * 1000).toLocaleString()}</p>
              </div>
              <div className="workbench-actions">
                <span className={`pill ${gateReady ? 'ok' : packetUnlocked ? 'warn' : 'dim'}`}>
                  {gateReady ? 'REVIEW COMPLETE' : packetUnlocked ? 'REVIEW IN PROGRESS' : 'LOCKED'}
                </span>
                <button type="button" className="btn primary" disabled={bulk || packetUnlocked} onClick={unlockPacket}>
                  {bulk ? <><span className="spin" /> Unlocking {bulkDone}/{packet.snapshotHandles.length}</> : packetUnlocked ? 'Values unlocked' : 'Unlock disclosed values'}
                </button>
              </div>
            </header>

            <WorkbenchTabs tabs={tabs} active={tab} onChange={setTab} label={`Packet ${packet.id} sections`} idPrefix={`audit-${packet.id}`} />

            <div id={`audit-${packet.id}-panel`} className="workbench-panel" role="tabpanel" aria-labelledby={`audit-${packet.id}-tab-${tab.toLowerCase()}`}>
              {tab === 'Overview' && (
                <div className="audit-overview">
                  {activeBundle.length > 1 && (
                    <section className="audit-bundle" aria-labelledby="audit-bundle-title">
                      <div className="audit-summary-head">
                        <div>
                          <h3 id="audit-bundle-title">Launch Day Review bundle</h3>
                          <p>{activeBundle.length} separate on-chain packets cover requests that belong to different mandates. This grouping is a UI review aid, not a synthetic on-chain packet.</p>
                        </div>
                        <span className={`pill ${bundleGateReady ? 'ok' : bundleCoverage ? 'warn' : 'bad'}`}>{bundleGateReady ? 'BUNDLE COMPLETE' : bundleCoverage ? 'REVIEW IN PROGRESS' : 'SCOPE INCOMPLETE'}</span>
                      </div>
                      <div className="audit-bundle-packets">
                        {bundleChecks.map((check) => (
                          <button type="button" key={String(check.packet.id)} className={check.packet.id === packet.id ? 'active' : ''} onClick={() => selectPacket(check.packet.id)}>
                            <span>Packet #{String(check.packet.id)}</span>
                            <small>Mandate #{String(check.packet.mandateId)} · {check.packet.requestIds.length} request{check.packet.requestIds.length === 1 ? '' : 's'}</small>
                            <span className={`pill ${check.ready ? 'ok' : 'dim'}`}>{check.ready ? 'REVIEWED' : 'PENDING'}</span>
                          </button>
                        ))}
                      </div>
                    </section>
                  )}

                  <section className="audit-summary" aria-labelledby="audit-scope-title">
                    <div className="audit-summary-head">
                      <div>
                        <h3 id="audit-scope-title">Granted disclosure scope</h3>
                        <p>One immutable packet, bound to the exact handles below.</p>
                      </div>
                      <span className="pill dim">V1 FIXED SCHEMA</span>
                    </div>
                    <dl className="audit-facts">
                      <div><dt>Auditor</dt><dd className="mono">{short(packet.auditor)}</dd></div>
                      <div><dt>Requests</dt><dd>{packet.requestIds.length}</dd></div>
                      <div><dt>Snapshot handles</dt><dd>{packet.snapshotHandles.length}</dd></div>
                      <div><dt>Manifest</dt><dd className={manifestMatches ? 'audit-good' : 'audit-bad'}>{manifestMatches ? 'Recomputed match' : 'Mismatch'}</dd></div>
                    </dl>
                  </section>

                  <section className="audit-policy-values" aria-labelledby="policy-snapshots-title">
                    <h3 id="policy-snapshots-title">Disclosed policy snapshots</h3>
                    <div className="kv">
                      <div className="kv-row"><span>Auto-limit</span>{displaySnapshot(packet.snapshotHandles[0])}</div>
                      <div className="kv-row"><span>Budget left at packet time</span>{displaySnapshot(packet.snapshotHandles[1])}</div>
                      <div className="kv-row"><span>Reserve floor</span>{displaySnapshot(packet.snapshotHandles[2])}</div>
                    </div>
                  </section>

                  <section className="audit-review-progress" aria-labelledby="review-progress-title">
                    <h3 id="review-progress-title">Review progress</h3>
                    <div className="audit-progress-row">
                      <span><b>{reviewedCount}</b> reviewed</span>
                      <span><b>{flaggedCount}</b> follow-up</span>
                      <span><b>{packet.requestIds.length - reviewedCount - flaggedCount}</b> pending</span>
                    </div>
                    <button type="button" className="btn" onClick={() => setTab('Requests')}>Review included requests</button>
                  </section>
                </div>
              )}

              {tab === 'Requests' && (
                <section className="audit-requests" aria-labelledby="included-requests-title">
                  <div className="section-head">
                    <div>
                      <h3 id="included-requests-title">Included requests</h3>
                      <p className="muted">Disposition is stored locally for this auditor and packet; public states and transactions remain chain-derived.</p>
                    </div>
                  </div>
                  <div className="tbl">
                    <table>
                      <thead>
                        <tr><th>Request</th><th>Public outcome</th><th>Disclosed values</th><th>Transactions</th><th>Review disposition</th></tr>
                      </thead>
                      <tbody>
                        {requestRows.map(({ requestId, request, tx }, index) => {
                          const disposition = reviews[String(requestId)];
                          return (
                            <tr key={String(requestId)}>
                              <td>
                                <b className="mono">#{String(requestId)}</b>
                                <span className="audit-recipient">{request ? short(request.recipient) : 'Syncing public request…'}</span>
                              </td>
                              <td>{request ? <RequestPill state={request.state} /> : <span className="pill dim">SYNCING</span>}</td>
                              <td>
                                <div className="audit-disclosed-values">
                                  <span>Amount {displaySnapshot(packet.snapshotHandles[3 + index * 2])}</span>
                                  <span>Reason {displaySnapshot(packet.snapshotHandles[4 + index * 2], 'reason')}</span>
                                </div>
                              </td>
                              <td>
                                <div className="audit-tx-links">
                                  <TxLink hash={tx?.request} label="Request" />
                                  <TxLink hash={tx?.approval ?? tx?.cancellation ?? tx?.finalize} label={tx?.approval || tx?.cancellation ? 'Safe decision' : 'Finalize'} />
                                </div>
                              </td>
                              <td>
                                <div className="audit-review-actions" role="group" aria-label={`Review request ${requestId}`}>
                                  <button
                                    type="button"
                                    className={`btn small ${disposition === 'reviewed' ? 'audit-choice-active' : 'ghost'}`}
                                    aria-pressed={disposition === 'reviewed'}
                                    disabled={!packetUnlocked}
                                    onClick={() => setDisposition(requestId, 'reviewed')}
                                  >Reviewed</button>
                                  <button
                                    type="button"
                                    className={`btn small ${disposition === 'flagged' ? 'audit-choice-flagged' : 'ghost'}`}
                                    aria-pressed={disposition === 'flagged'}
                                    disabled={!packetUnlocked}
                                    onClick={() => setDisposition(requestId, 'flagged')}
                                  >Flag follow-up</button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                        {!requestRows.length && <tr><td colSpan={5} className="muted">This policy-only packet cannot complete the review mission.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                  {!packetUnlocked && <p className="audit-action-hint">Unlock the full disclosed scope before assigning review dispositions.</p>}
                </section>
              )}

              {tab === 'Verification' && (
                <section className="audit-verification" aria-labelledby="packet-verification-title">
                  <div className="section-head">
                    <div>
                      <h3 id="packet-verification-title">Packet integrity checklist</h3>
                      <p className="muted">Completion is derived from these checks. Decryption alone is not sufficient.</p>
                    </div>
                    <span className={`pill ${gateReady ? 'ok' : 'warn'}`}>{gateReady ? 'VALID' : 'ACTION REQUIRED'}</span>
                  </div>
                  <AuditChecklist checks={[
                    { passed: packetUnlocked, title: 'Disclosure scope unlocked', detail: `${Object.keys(values).filter((handle) => packet.snapshotHandles.includes(handle as `0x${string}`)).length}/${packet.snapshotHandles.length} snapshot values available` },
                    { passed: handleShapeValid, title: 'V1 handle schema matches', detail: `${packet.snapshotHandles.length} received · ${expectedHandleCount} expected` },
                    { passed: manifestMatches, title: 'Manifest binds the exact scope', detail: 'Recomputed from auditor, mandate, policy version, request IDs and snapshot handles' },
                    { passed: terminalReconciled, title: 'Every request is terminal on-chain', detail: `${requestRows.filter(({ request }) => request && TERMINAL_REQUEST_STATES.has(request.state)).length}/${requestRows.length} reconciled` },
                    { passed: allDispositioned && hasRequestScope, title: 'Every request has a disposition', detail: `${reviewedCount} reviewed · ${flaggedCount} flagged · ${packet.requestIds.length - reviewedCount - flaggedCount} pending` },
                  ]} />
                  <div className="audit-proof-hashes">
                    <div><span>On-chain manifest</span><code>{packet.manifestHash}</code></div>
                    <div><span>Recomputed manifest</span><code>{computedManifest ?? 'Unable to encode packet'}</code></div>
                    <div><span>Module</span><a href={scan(ADDR.VeilGuardModule)} target="_blank" rel="noopener noreferrer" className="mono alink">{ADDR.VeilGuardModule}</a></div>
                  </div>

                  <details className="audit-advanced">
                    <summary>Advanced: inspect individual ciphertext snapshots</summary>
                    <p className="muted">Individual inspection supports investigation, but review completion still requires the entire granted scope.</p>
                    <div className="audit-handle-list">
                      {packet.snapshotHandles.map((handle, index) => (
                        <div key={handle} className="audit-handle-row">
                          <span>{index === 0 ? 'Policy auto-limit' : index === 1 ? 'Policy budget left' : index === 2 ? 'Policy reserve floor' : `Request snapshot ${index - 2}`}</span>
                          <code title={handle}>{short(handle)}</code>
                          {values[handle] !== undefined ? <span className="pill ok">UNLOCKED</span> : (
                            <button type="button" className="btn small ghost" disabled={!!unlockingHandle} onClick={() => inspectHandle(handle)}>
                              {unlockingHandle === handle ? <><span className="spin" /> Unlocking</> : 'Inspect'}
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </details>
                </section>
              )}

              {tab === 'Export' && (
                <section className="audit-export" aria-labelledby="packet-export-title">
                  <h3 id="packet-export-title">Export the reviewed packet</h3>
                  <p>
                    The JSON contains authorised plaintext snapshots, public request states, transaction hashes,
                    local review dispositions and both manifest hashes. Treat it as sensitive audit material.
                  </p>
                  <div className="audit-export-readiness">
                    <span className={`pill ${gateReady ? 'ok' : 'warn'}`}>{gateReady ? 'READY TO EXPORT' : 'REVIEW INCOMPLETE'}</span>
                    <span>{reviewedCount + flaggedCount}/{packet.requestIds.length} requests dispositioned</span>
                    <span>{manifestMatches ? 'Manifest verified' : 'Manifest not verified'}</span>
                  </div>
                  <button type="button" className="btn primary" disabled={!gateReady || downloading} onClick={exportPacket}>
                    {downloading ? <><span className="spin" /> Preparing export…</> : 'Download verified JSON'}
                  </button>
                  {!gateReady && <button type="button" className="btn ghost" onClick={() => setTab('Verification')}>Open remaining checks</button>}
                </section>
              )}
            </div>
          </WorkbenchDetail>
        </Workbench>
      )}
    </>
  );
}

export type AuditCheck = { passed: boolean; title: string; detail: string };

export function AuditChecklist({ checks }: { checks: AuditCheck[] }) {
  return <ul className="verification-list" aria-label="Audit packet integrity checklist">{checks.map((check) => <VerificationItem key={check.title} {...check} />)}</ul>;
}

function VerificationItem({ passed, title, detail }: AuditCheck) {
  return (
    <li className={passed ? 'passed' : 'pending'}>
      <span className="verification-mark" aria-hidden="true">{passed ? '✓' : '·'}</span>
      <span><b>{title}</b><small>{detail}</small></span>
      <span className={`pill ${passed ? 'ok' : 'dim'}`}>{passed ? 'PASS' : 'PENDING'}</span>
    </li>
  );
}
