import { decodeEventLog, keccak256, parseAbiItem, stringToBytes, type TransactionReceipt } from 'viem';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SpendRequest } from '../App';
import { useApp } from '../App';
import { ADDR, REQUEST_STATES, ROLES, isAddress, moduleAbi, scanTx, short, vendorName } from '../config';
import { scenarioByKey, trustedDemoScenarioForRequest, type DemoScenario, type DemoScenarioKey } from '../demo-scenarios';
import {
  completedAdminDisclosureGroups,
  createAdminDisclosureCheckpoint,
  loadAdminDisclosureCheckpoint,
  removeAdminDisclosureCheckpoint,
  saveAdminDisclosureCheckpoint,
  updateAdminDisclosureGroup,
  type AdminDisclosureGroupCheckpoint,
  type AdminDisclosureCheckpoint,
} from '../disclosure-checkpoint';
import { loadDemoSession } from '../demo-session';
import { advanceGuidedMission, completeMission } from '../missions';
import { publicClient } from '../nox';
import { formatAppRoute } from '../routes';
import { walletWrite } from '../walletTx';

type BuilderStep = 'select' | 'review' | 'create';
type DisclosureMode = 'guided-facilitated' | 'admin-wallet' | 'observer';
type ScopeEntry = {
  id: string;
  mission?: DemoScenarioKey;
  scenario?: DemoScenario;
  request?: SpendRequest;
  identityError?: string;
};
type PacketResult = {
  bundleId: `0x${string}`;
  bundleKind: 'ui-aggregate';
  onchainObject: false;
  packets: Array<{
    packetId: number;
    mandateId: number;
    requestIds: number[];
    manifestHash: `0x${string}`;
    tx?: `0x${string}`;
    reused: boolean;
  }>;
  fixedPolicyFields: string[];
};

const TERMINAL_STATES = new Set([2, 4, 5, 6]);
const ADMIN_DISCLOSURE_RUN_KEY = `wallet:${ADDR.VeilGuardModule.toLowerCase()}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type AuditPacketCreatedArgs = {
  packetId: bigint;
  auditor: `0x${string}`;
  mandateId: bigint;
  manifestHash: `0x${string}`;
};

type AuditPacketRead = readonly [
  `0x${string}`,
  bigint,
  number,
  `0x${string}`,
  bigint,
  readonly bigint[],
  readonly `0x${string}`[],
];

const auditPacketCreatedEvent = parseAbiItem(
  'event AuditPacketCreated(uint256 indexed packetId, address indexed auditor, uint256 indexed mandateId, bytes32 manifestHash)',
);

const sameAddress = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
const sameHash = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
const normalizedBigIntIds = (ids: readonly (string | bigint)[]) => ids
  .map((id) => BigInt(id))
  .sort((left, right) => left === right ? 0 : left < right ? -1 : 1);
const sameRequestIds = (left: readonly (string | bigint)[], right: readonly (string | bigint)[]) => {
  if (left.length !== right.length) return false;
  const a = normalizedBigIntIds(left);
  const b = normalizedBigIntIds(right);
  return a.every((id, index) => id === b[index]);
};

async function verifyAdminDisclosureGroup(options: {
  auditor: `0x${string}`;
  group: AdminDisclosureGroupCheckpoint;
  receipt: TransactionReceipt;
}): Promise<{ packetId: number; manifestHash: `0x${string}` }> {
  const { auditor, group, receipt } = options;
  if (receipt.status !== 'success') {
    throw new Error(`Mandate #${group.mandateId} recovery transaction did not succeed on-chain.`);
  }

  const created = receipt.logs.flatMap((log) => {
    if (!sameAddress(log.address, ADDR.VeilGuardModule)) return [];
    try {
      const decoded = decodeEventLog({ abi: moduleAbi, data: log.data, topics: log.topics }) as unknown as {
        eventName: string;
        args: AuditPacketCreatedArgs;
      };
      return decoded.eventName === 'AuditPacketCreated' ? [decoded.args] : [];
    } catch { return []; }
  });
  if (created.length !== 1) {
    throw new Error(`Mandate #${group.mandateId} recovery receipt does not contain exactly one AuditPacketCreated event.`);
  }

  const event = created[0];
  if (!sameAddress(event.auditor, auditor)
    || event.mandateId !== BigInt(group.mandateId)
    || (group.packetId != null && event.packetId !== BigInt(group.packetId))
    || (!!group.manifestHash && !sameHash(event.manifestHash, group.manifestHash))) {
    throw new Error(`Mandate #${group.mandateId} recovery event does not match the selected auditor, mandate, packet and manifest.`);
  }
  if (event.packetId > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Mandate #${group.mandateId} packet ID exceeds the supported browser range.`);
  }

  const packet = await publicClient.readContract({
    address: ADDR.VeilGuardModule,
    abi: moduleAbi,
    functionName: 'getAuditPacket',
    args: [event.packetId],
  }) as AuditPacketRead;
  if (!sameAddress(packet[0], auditor)
    || packet[1] !== BigInt(group.mandateId)
    || !sameHash(packet[3], event.manifestHash)
    || !sameRequestIds(packet[5], group.requestIds)) {
    throw new Error(`Mandate #${group.mandateId} on-chain Audit Packet does not match the recovered auditor, mandate, manifest and request scope.`);
  }

  return { packetId: Number(event.packetId), manifestHash: event.manifestHash };
}

async function recoverUnknownAdminSignature(options: {
  account: `0x${string}`;
  auditor: `0x${string}`;
  group: AdminDisclosureGroupCheckpoint;
}): Promise<`0x${string}` | null> {
  const { account, auditor, group } = options;
  if (!group.signatureStartBlock) return null;
  const latest = await publicClient.getBlockNumber();
  const start = BigInt(group.signatureStartBlock);
  if (start > latest) return null;
  const matches: `0x${string}`[] = [];
  const chunk = 9_000n;
  for (let fromBlock = start; fromBlock <= latest; fromBlock += chunk) {
    const toBlock = fromBlock + chunk - 1n > latest ? latest : fromBlock + chunk - 1n;
    const logs = await publicClient.getLogs({
      address: ADDR.VeilGuardModule,
      event: auditPacketCreatedEvent,
      args: { auditor, mandateId: BigInt(group.mandateId) },
      fromBlock,
      toBlock,
    });
    for (const log of logs) {
      if (log.args.packetId == null || !log.transactionHash) continue;
      const packet = await publicClient.readContract({
        address: ADDR.VeilGuardModule,
        abi: moduleAbi,
        functionName: 'getAuditPacket',
        args: [log.args.packetId],
      }) as AuditPacketRead;
      if (!sameAddress(packet[0], auditor)
        || packet[1] !== BigInt(group.mandateId)
        || !sameRequestIds(packet[5], group.requestIds)) continue;
      const transaction = await publicClient.getTransaction({ hash: log.transactionHash });
      if (sameAddress(transaction.from, account)) matches.push(log.transactionHash);
    }
  }
  const uniqueMatches = [...new Set(matches.map((hash) => hash.toLowerCase()))];
  if (uniqueMatches.length > 1) {
    throw new Error(`Mandate #${group.mandateId} has multiple matching Audit Packet transactions after the unknown wallet prompt. Manual chain review is required before any new signature.`);
  }
  return matches[0] ?? null;
}

const guidedScope = (session: ReturnType<typeof loadDemoSession>, requests: SpendRequest[]): ScopeEntry[] => {
  if (!session) return [];
  return (['routine', 'approval', 'violation'] as const).flatMap((mission) => {
    const id = session.missions[mission].requestId;
    if (!id) return [];
    const request = requests.find((candidate) => String(candidate.id) === id);
    const trustedScenario = trustedDemoScenarioForRequest(session.runId, request);
    const expectedScenario = scenarioByKey(mission);
    const identityError = request && trustedScenario?.key !== mission
      ? `Request #${id} does not match the ${expectedScenario.vendor} run identity (recipient, mandate, delegate and domain-separated memo).`
      : undefined;
    return [{
      id,
      mission,
      scenario: trustedScenario?.key === mission ? trustedScenario : undefined,
      request,
      identityError,
    }];
  });
};

const terminal = (entry: ScopeEntry) => !!entry.request && TERMINAL_STATES.has(entry.request.state);
const guidedSelectable = (entry: ScopeEntry) => terminal(entry) && !entry.identityError && !!entry.scenario;

const packetResultFromCheckpoint = (
  checkpoint: AdminDisclosureCheckpoint,
  reusedMandates = new Set(Object.keys(checkpoint.groups)),
): PacketResult => {
  const packets = Object.values(checkpoint.groups)
    .filter((group) => group.packetId != null && !!group.manifestHash && !!group.transactionHash)
    .map((group) => ({
      packetId: group.packetId!,
      mandateId: group.mandateId,
      requestIds: group.requestIds.map(Number),
      manifestHash: group.manifestHash!,
      tx: group.transactionHash!,
      reused: reusedMandates.has(String(group.mandateId)),
    }));
  return {
    bundleId: keccak256(stringToBytes(`veilguard-ui-bundle:${packets.map(({ tx }) => tx).join(':')}`)),
    bundleKind: 'ui-aggregate',
    onchainObject: false,
    packets,
    fixedPolicyFields: ['autoLimit', 'budgetLeft', 'reserveFloor'],
  };
};

export function DisclosureView() {
  const { account, financeAdmin, demoRole, requests, run, startDemo, toast } = useApp();
  const [step, setStep] = useState<BuilderStep>('select');
  const [session, setSession] = useState(loadDemoSession);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [auditor, setAuditor] = useState<string>(ROLES.auditor);
  const [busy, setBusy] = useState(false);
  const createLock = useRef(false);
  const initializedScope = useRef('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<PacketResult | null>(null);
  const [adminCheckpoint, setAdminCheckpoint] = useState<AdminDisclosureCheckpoint | null>(null);
  const adminSignaturePendingGroups = adminCheckpoint
    ? Object.values(adminCheckpoint.groups).filter((group) => !!group.signaturePendingAt)
    : [];
  const adminCheckpointHasLockedPointers = !!adminCheckpoint
    && Object.values(adminCheckpoint.groups).some((group) => !!group.transactionHash || !!group.signaturePendingAt);

  const mode: DisclosureMode = demoRole === 'delegate' && !!session
    ? 'guided-facilitated'
    : account && financeAdmin && account.toLowerCase() === financeAdmin.toLowerCase()
      ? 'admin-wallet'
      : 'observer';

  useEffect(() => {
    const update = () => setSession(loadDemoSession());
    window.addEventListener('vg-demo-session', update);
    window.addEventListener('vg-missions', update);
    return () => {
      window.removeEventListener('vg-demo-session', update);
      window.removeEventListener('vg-missions', update);
    };
  }, []);

  const scope = useMemo<ScopeEntry[]>(() => {
    if (mode === 'guided-facilitated') return guidedScope(session, requests);
    if (mode === 'admin-wallet') {
      return requests
        .filter((request) => TERMINAL_STATES.has(request.state))
        .sort((a, b) => a.id > b.id ? -1 : 1)
        .map((request) => ({ id: String(request.id), request }));
    }
    return [];
  }, [mode, requests, session]);

  // Browser-wallet packets are independent from guided demo runs. A stable
  // module namespace prevents Restart/new-run state from hiding a broadcast.
  const adminRunKey = ADMIN_DISCLOSURE_RUN_KEY;

  const scopeKey = `${mode}:${scope.map(({ id, request, identityError }) =>
    `${id}:${request?.state ?? 'loading'}:${request?.memoHash ?? 'none'}:${identityError ? 'mismatch' : 'trusted'}`).join(',')}`;
  useEffect(() => {
    if (!scopeKey || initializedScope.current === scopeKey) return;
    initializedScope.current = scopeKey;
    setError('');
    if (mode === 'guided-facilitated') {
      const covered = new Set(session?.missions.audit.includedRequestIds ?? []);
      setSelected(new Set(scope
        .filter((entry) => !covered.has(entry.id) && guidedSelectable(entry))
        .map(({ id }) => id)));
      setAdminCheckpoint(null);
    } else if (mode === 'admin-wallet' && account) {
      const checkpoint = loadAdminDisclosureCheckpoint(adminRunKey, account);
      const scopeIds = new Set(scope.map(({ id }) => id));
      const restorable = checkpoint
        && checkpoint.selectedRequestIds.length > 0
        && checkpoint.selectedRequestIds.every((id) => scopeIds.has(id));
      if (restorable) {
        setAuditor(checkpoint.auditor);
        setSelected(new Set(checkpoint.selectedRequestIds));
        setAdminCheckpoint(checkpoint);
        const pointers = Object.values(checkpoint.groups).filter((group) => !!group.transactionHash).length;
        const unknownPrompts = Object.values(checkpoint.groups).filter((group) => !!group.signaturePendingAt).length;
        setError(unknownPrompts
          ? `Recovered ${unknownPrompts} wallet request${unknownPrompts === 1 ? '' : 's'} with an unknown outcome and ${pointers} transaction pointer${pointers === 1 ? '' : 's'}. Resolve the original wallet prompt before any new signature.`
          : `Recovered ${pointers}/${Object.keys(checkpoint.groups).length} local transaction pointers. Continue to verify every receipt, event and Audit Packet on-chain before reuse.`);
        setResult(null);
        setStep('review');
        return;
      } else {
        setSelected(new Set());
        setAdminCheckpoint(null);
      }
    } else {
      setSelected(new Set());
      setAdminCheckpoint(null);
    }
    setStep('select');
    setResult(null);
  }, [account, adminRunKey, mode, scope, scopeKey, session?.missions.audit.includedRequestIds]);

  const selectedEntries = useMemo(
    () => scope.filter(({ id }) => selected.has(id)),
    [scope, selected],
  );
  const selectedIds = selectedEntries.map(({ id }) => id);
  const requiredIds = mode === 'guided-facilitated' ? scope.map(({ id }) => id) : [];
  const coveredIds = mode === 'guided-facilitated' ? session?.missions.audit.includedRequestIds ?? [] : [];
  const effectiveCoveredIds = result && mode === 'guided-facilitated'
    ? [...new Set([...coveredIds, ...selectedIds])]
    : coveredIds;
  const coveredCount = requiredIds.filter((id) => effectiveCoveredIds.includes(id)).length;
  const guidedCoverageComplete = mode === 'guided-facilitated'
    && !!session
    && (session.missions.audit.packetIds.length > 0 || !!result?.packets.length)
    && requiredIds.length === 3
    && scope.length === 3
    && scope.every(guidedSelectable)
    && requiredIds.every((id) => effectiveCoveredIds.includes(id));
  const allGuidedTerminal = scope.length === 3 && scope.every(terminal);
  const identityMismatches = mode === 'guided-facilitated'
    ? scope.filter(({ identityError }) => !!identityError)
    : [];
  const selectionValid = selectedEntries.length > 0
    && selectedEntries.length <= 8
    && selectedEntries.every(terminal)
    && (mode !== 'guided-facilitated' || selectedEntries.every(guidedSelectable))
    && (mode !== 'guided-facilitated' || allGuidedTerminal)
    && (mode !== 'admin-wallet' || isAddress(auditor));

  const toggle = (id: string) => {
    const entry = scope.find((candidate) => candidate.id === id);
    if (!entry || !terminal(entry) || (mode === 'guided-facilitated' && !guidedSelectable(entry))) return;
    if (mode === 'admin-wallet' && adminCheckpointHasLockedPointers) {
      setError('The selected scope is locked because a wallet request may still be pending or an Audit Packet transaction was broadcast. Resolve or verify every pointer before changing the scope.');
      return;
    }
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else if (next.size >= 8) toast('A disclosure operation may include at most 8 requests.', true);
      else next.add(id);
      return next;
    });
  };

  const reviewSelection = () => {
    if (mode === 'guided-facilitated') {
      const invalid = selectedEntries.filter((entry) => !guidedSelectable(entry));
      if (invalid.length) {
        setError(`Cannot review request${invalid.length === 1 ? '' : 's'} ${invalid.map(({ id }) => `#${id}`).join(', ')}: the live recipient/memo identity is not bound to this run.`);
        return;
      }
    }
    setError('');
    setStep('review');
  };

  const createFacilitatedPackets = async (): Promise<PacketResult> => {
    if (!session) throw new Error('Start or resume the Launch Day demo before requesting facilitated disclosure.');
    const body = { runId: session.runId, requestIds: selectedIds };
    for (let attempt = 0; attempt < 45; attempt++) {
      const response = await fetch('/api/demo-audit-packet', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 202) { await sleep(2_000); continue; }
      if (!response.ok) throw new Error(data.error ?? `packet service returned ${response.status}`);
      return data as PacketResult;
    }
    throw new Error('Packet creation is still processing; retry to resume it.');
  };

  const createAdminPackets = async (): Promise<PacketResult> => {
    if (!account || !financeAdmin || account.toLowerCase() !== financeAdmin.toLowerCase()) {
      throw new Error('Connect the current on-chain Finance Admin wallet.');
    }
    const groups = new Map<string, ScopeEntry[]>();
    for (const entry of selectedEntries) {
      const key = String(entry.request!.mandateId);
      groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
    const groupEntries = [...groups].sort(([left], [right]) => {
      const a = BigInt(left);
      const b = BigInt(right);
      return a === b ? 0 : a < b ? -1 : 1;
    });
    const groupIds = new Map(groupEntries.map(([mandateId, entries]) => [mandateId, entries.map(({ id }) => id)]));
    const freshCheckpoint = createAdminDisclosureCheckpoint({
      runKey: adminRunKey,
      account,
      auditor: auditor as `0x${string}`,
      groups: groupIds,
    });
    let checkpoint = loadAdminDisclosureCheckpoint(adminRunKey, account);
    if (!checkpoint || checkpoint.scopeKey !== freshCheckpoint.scopeKey) {
      const broadcastGroups = checkpoint
        ? Object.values(checkpoint.groups).filter((group) => !!group.transactionHash || !!group.signaturePendingAt)
        : [];
      if (broadcastGroups.length > 0) {
        throw new Error(`A previous Audit Packet operation has ${broadcastGroups.length} locked wallet or transaction pointer${broadcastGroups.length === 1 ? '' : 's'}. Restore its original auditor and request scope, then resolve every wallet prompt and receipt before starting a different operation.`);
      }
      checkpoint = freshCheckpoint;
      setAdminCheckpoint(checkpoint);
      if (!saveAdminDisclosureCheckpoint(checkpoint)) {
        throw new Error('Durable recovery storage is unavailable. No wallet request was opened; enable site storage before creating Audit Packets.');
      }
    }
    const recoveredMandates = new Set<string>();

    for (const [mandateId] of groupEntries) {
      const savedGroup = checkpoint.groups[mandateId];
      let recoveredPointer = !!savedGroup.transactionHash;
      let hash = savedGroup.transactionHash;
      let receipt: TransactionReceipt;
      if (!hash && savedGroup.signaturePendingAt) {
        const recoveredHash = await recoverUnknownAdminSignature({
          account,
          auditor: auditor as `0x${string}`,
          group: savedGroup,
        });
        if (!recoveredHash) {
          throw new Error(`Mandate #${mandateId} has a wallet request with an unknown outcome. Return to the original wallet prompt and approve or reject it, then retry recovery. If that prompt no longer exists, manual chain reconciliation is required; VeilGuard will not request another signature.`);
        }
        checkpoint = updateAdminDisclosureGroup(checkpoint, mandateId, {
          signaturePendingAt: undefined,
          signatureStartBlock: undefined,
          transactionHash: recoveredHash,
        });
        setAdminCheckpoint(checkpoint);
        if (!saveAdminDisclosureCheckpoint(checkpoint)) {
          throw new Error(`Recovered Audit Packet transaction ${recoveredHash}, but durable storage could not save its hash. Keep this tab open; retry will use the in-memory pointer.`);
        }
        hash = recoveredHash;
        recoveredPointer = true;
      }
      if (!hash) {
        // Re-check durable storage immediately before every wallet prompt. A
        // failed preflight may leave only an in-memory draft; it must never
        // become signable on a later click until cross-tab storage succeeds.
        if (!saveAdminDisclosureCheckpoint(checkpoint)) {
          throw new Error('Durable recovery storage is unavailable. No wallet request was opened; enable site storage before creating Audit Packets.');
        }
        const signatureStartBlock = await publicClient.getBlockNumber();
        try {
          hash = await walletWrite({
            account,
            address: ADDR.VeilGuardModule,
            abi: moduleAbi,
            functionName: 'createAuditPacket',
            args: [auditor as `0x${string}`, BigInt(mandateId), savedGroup.requestIds.map((id) => BigInt(id))],
            onHint: (message) => toast(message),
            onRequestStarted: () => {
              const currentCheckpoint = checkpoint;
              if (!currentCheckpoint) {
                throw new Error('Audit Packet recovery checkpoint disappeared before the wallet request. No signature request was opened.');
              }
              checkpoint = updateAdminDisclosureGroup(currentCheckpoint, mandateId, {
                signaturePendingAt: Date.now(),
                signatureStartBlock: signatureStartBlock.toString(),
              });
              setAdminCheckpoint(checkpoint);
              if (!saveAdminDisclosureCheckpoint(checkpoint)) {
                // The callback runs before wallet_writeContract. Roll back the
                // volatile marker and abort so no untracked prompt can open.
                checkpoint = updateAdminDisclosureGroup(checkpoint, mandateId, {
                  signaturePendingAt: undefined,
                  signatureStartBlock: undefined,
                });
                saveAdminDisclosureCheckpoint(checkpoint);
                setAdminCheckpoint(checkpoint);
                throw new Error('Durable recovery storage became unavailable before the wallet prompt. No signature request was opened.');
              }
            },
            // Never release the global wallet lease while an injected-wallet
            // request can still be approved. The user must approve or reject it.
            timeoutMs: 0,
          });
        } catch (reason: any) {
          const signaturePending = !!checkpoint.groups[mandateId]?.signaturePendingAt;
          const explicitlyRejected = reason?.code === 4001 || /user rejected|user denied/i.test(`${reason?.message ?? reason}`);
          if (signaturePending && explicitlyRejected) {
            checkpoint = updateAdminDisclosureGroup(checkpoint, mandateId, {
              signaturePendingAt: undefined,
              signatureStartBlock: undefined,
            });
            setAdminCheckpoint(checkpoint);
            if (!saveAdminDisclosureCheckpoint(checkpoint)) {
              throw new Error(`The mandate #${mandateId} wallet request was rejected, but durable recovery storage could not record that result. Keep this tab open and restore site storage before retrying.`);
            }
            throw new Error(`The mandate #${mandateId} wallet request was explicitly rejected. It is safe to retry when ready.`);
          }
          if (signaturePending) {
            throw new Error(`The mandate #${mandateId} wallet request outcome is unknown. VeilGuard kept its recovery marker and will not request a second signature.`);
          }
          throw reason;
        }
        // Persist the broadcast hash before waiting. Reloads and RPC timeouts
        // resume this exact transaction instead of creating a duplicate packet.
        checkpoint = updateAdminDisclosureGroup(checkpoint, mandateId, {
          signaturePendingAt: undefined,
          signatureStartBlock: undefined,
          transactionHash: hash,
        });
        setAdminCheckpoint(checkpoint);
        if (!saveAdminDisclosureCheckpoint(checkpoint)) {
          throw new Error(`Audit Packet transaction ${hash} was broadcast, but durable recovery storage became unavailable. Keep this tab open; retry here will recover the in-memory hash and will not request another signature.`);
        }
        receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
      } else if (savedGroup.packetId != null && savedGroup.manifestHash) {
        // A complete local record is still only an untrusted recovery pointer.
        // Fetch its receipt immediately, then verify its event and contract
        // object before it may be reused or rendered as a successful packet.
        receipt = await publicClient.getTransactionReceipt({ hash });
      } else {
        // The broadcast was persisted before confirmation. Resume waiting for
        // that exact transaction instead of signing a duplicate packet.
        receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
      }

      if (receipt.status !== 'success') {
        checkpoint = updateAdminDisclosureGroup(checkpoint, mandateId, {
          signaturePendingAt: undefined,
          signatureStartBlock: undefined,
          transactionHash: undefined,
          packetId: undefined,
          manifestHash: undefined,
        });
        setAdminCheckpoint(checkpoint);
        if (!saveAdminDisclosureCheckpoint(checkpoint)) {
          throw new Error(`Mandate #${mandateId} packet transaction reverted, but recovery storage could not record the cleared pointer. Keep this tab open and retry after restoring site storage.`);
        }
        throw new Error(`Mandate #${mandateId} packet transaction reverted. Retry will sign only this unfinished group.`);
      }

      const verified = await verifyAdminDisclosureGroup({
        auditor: auditor as `0x${string}`,
        group: savedGroup,
        receipt,
      });
      checkpoint = updateAdminDisclosureGroup(checkpoint, mandateId, {
        packetId: verified.packetId,
        manifestHash: verified.manifestHash,
      });
      setAdminCheckpoint(checkpoint);
      if (!saveAdminDisclosureCheckpoint(checkpoint)) {
        throw new Error(`Mandate #${mandateId} was verified on-chain, but its durable recovery metadata could not be saved. Keep this tab open and resume verification; no new signature is required.`);
      }
      if (recoveredPointer) recoveredMandates.add(mandateId);
    }
    const verifiedResult = packetResultFromCheckpoint(checkpoint, recoveredMandates);
    // Every group has now passed receipt + unique event + getAuditPacket.
    // Archive the active recovery operation so a future, different scope can
    // start without discarding an unverified broadcast pointer.
    if (!removeAdminDisclosureCheckpoint(adminRunKey, account)) {
      throw new Error('All Audit Packets were verified, but the active recovery checkpoint could not be archived. Restore site storage and resume once more; no new signature is required.');
    }
    setAdminCheckpoint(null);
    return verifiedResult;
  };

  const createCoordinatedAdminPackets = async (): Promise<PacketResult> => {
    if (!account) throw new Error('Connect the current on-chain Finance Admin wallet.');
    const executeWithAppCoordinator = async (): Promise<PacketResult> => {
      let output: PacketResult | undefined;
      let failure: unknown;
      const operation = await run({
        key: 'audit-packet-create',
        label: 'Create audit packets',
        resources: [`wallet:${account.toLowerCase()}`],
        feedback: 'inline',
      }, async () => {
        try {
          output = await createAdminPackets();
        } catch (reason) {
          failure = reason;
          throw reason;
        }
      });
      if (!operation.accepted) {
        throw new Error(`${operation.blocker.label} is using this wallet. Return to that operation before creating Audit Packets.`);
      }
      if (operation.status === 'failed') {
        throw failure instanceof Error ? failure : new Error('Audit Packet creation failed before its evidence could be verified.');
      }
      if (!output) throw new Error('Audit Packet creation finished without a verified result. Resume the operation to recover its evidence.');
      return output;
    };

    // The in-app coordinator owns the complete multi-mandate lease. Web Locks
    // extends the same wallet resource across tabs, closing the last race where
    // two tabs could both prompt before either persisted its broadcast hash.
    const lockManager = typeof navigator === 'undefined' ? undefined : navigator.locks;
    if (!lockManager) return executeWithAppCoordinator();
    let acquired = false;
    let output: PacketResult | undefined;
    await lockManager.request(
      `veilguard:audit-packet-create:${ADDR.VeilGuardModule.toLowerCase()}:${account.toLowerCase()}`,
      { mode: 'exclusive', ifAvailable: true },
      async (lock) => {
        if (!lock) return;
        acquired = true;
        output = await executeWithAppCoordinator();
      },
    );
    if (!acquired) {
      throw new Error('Create audit packets is already using this Finance Admin wallet in another tab. Return to that tab and recover the active operation.');
    }
    if (!output) throw new Error('The cross-tab wallet operation ended without verified Audit Packet evidence.');
    return output;
  };

  const create = async () => {
    if (!selectionValid || mode === 'observer' || createLock.current) return;
    if (mode === 'guided-facilitated' && selectedEntries.some((entry) => !guidedSelectable(entry))) {
      setError('The selected on-chain request identity no longer matches this demo run. Return to selection and refresh chain state.');
      setStep('select');
      return;
    }
    createLock.current = true;
    setBusy(true);
    setError('');
    try {
      const output = mode === 'guided-facilitated'
        ? await createFacilitatedPackets()
        : await createCoordinatedAdminPackets();
      setResult(output);
      setStep('create');
      if (mode === 'guided-facilitated' && session) {
        completeMission('audit', {
          packetIds: output.packets.map((packet) => packet.packetId),
          includedRequestIds: selectedIds,
          runId: session.runId,
        });
      } else if (mode === 'admin-wallet' && session) {
        const runRequestIds = new Set([
          session.missions.routine.requestId,
          session.missions.approval.requestId,
          session.missions.violation.requestId,
        ].filter((id): id is string => !!id));
        const belongsToRun = selectedEntries.every((entry) =>
          runRequestIds.has(entry.id) && !!trustedDemoScenarioForRequest(session.runId, entry.request));
        if (belongsToRun) {
          completeMission('audit', {
            packetIds: output.packets.map((packet) => packet.packetId),
            includedRequestIds: selectedIds,
            runId: session.runId,
          });
        }
      }
      toast(`${output.packets.length} on-chain audit packet${output.packets.length === 1 ? '' : 's'} created for the selected scope.`);
    } catch (reason: any) {
      setError(reason?.message ?? String(reason));
    } finally {
      setBusy(false);
      createLock.current = false;
    }
  };

  const discardAdminRecovery = () => {
    if (mode !== 'admin-wallet' || !account) return;
    if (adminCheckpointHasLockedPointers) {
      setError('Pending wallet requests and broadcast recovery pointers cannot be discarded. Resolve the original prompt, then verify each receipt; only a wallet rejection observed by this page before reload or a confirmed reverted receipt may clear its pointer.');
      return;
    }
    removeAdminDisclosureCheckpoint(adminRunKey, account);
    setAdminCheckpoint(null);
    setResult(null);
    setError('Local recovery pointers discarded. The selected scope is unchanged; retry will request fresh wallet signatures.');
  };

  const addRemaining = () => {
    const remaining = scope
      .filter((entry) => !effectiveCoveredIds.includes(entry.id) && guidedSelectable(entry))
      .map(({ id }) => id);
    setSelected(new Set(remaining));
    setResult(null);
    setStep('select');
  };

  const openAudit = () => {
    const first = session?.missions.audit.packetIds[0] ?? result?.packets[0]?.packetId;
    if (mode === 'guided-facilitated') {
      const route = { page: 'audit-packets' } as const;
      // Commit the tour step, target role, route and selected packet together
      // before changing the shell role/hash. The drawer never observes the
      // transient Delegate-on-Audit mismatch that previously paused the run.
      advanceGuidedMission({
        step: 5,
        route,
        role: 'auditor',
        selected: first ? { packetId: String(first) } : {},
      });
      startDemo('auditor');
      window.location.hash = formatAppRoute(route);
      return;
    }
    window.location.hash = formatAppRoute(first ? { page: 'audit-detail', packetId: String(first) } : { page: 'audit-packets' });
  };

  const boundary = mode === 'guided-facilitated'
    ? {
      title: 'Facilitated Finance Admin action',
      body: 'You choose the disclosure scope as the Delegate. The bounded demo service verifies the run-bound requests and performs the on-chain grant as Finance Admin. No Admin key enters the browser.',
    }
    : mode === 'admin-wallet'
      ? {
        title: 'Finance Admin wallet action',
        body: 'Your authorised wallet selects the auditor and signs createAuditPacket directly. The service does not substitute its demo key for this operation.',
      }
      : {
        title: 'Finance Admin action',
        body: 'Inspect the fixed disclosure boundary here. Connect the current on-chain Finance Admin, or enter the guided Delegate mission for a tightly bounded facilitated run.',
      };

  return (
    <>
      <div className="dash-head" data-tour="disclosure-builder">
        <div>
          <p className="workspace-kicker">Selective disclosure</p>
          <h1 className="dash-title">Launch Day Review</h1>
          <p className="dash-sub">Choose the smallest real request scope, review the irreversible v1 fields, then create mandate-scoped packets.</p>
        </div>
        <span className="pill tee">V1 FIXED SCHEMA</span>
      </div>

      <div className={`inline-alert ${mode === 'observer' ? 'warning' : 'neutral'}`} role="note" aria-label="Disclosure actor boundary">
        <b>{boundary.title}.</b> {boundary.body}
      </div>

      {mode === 'observer' ? (
        <section className="card empty-state" role="status">
          <h2>Authorised execution required</h2>
          <p className="muted">The deployed contract always includes three policy snapshots. An authorised Finance Admin chooses 1–8 terminal requests and the auditor; the public observer cannot grant access.</p>
        </section>
      ) : <>
        <ol className="builder-steps" aria-label="Disclosure builder progress">
          <li className={step === 'select' ? 'active' : 'complete'}><span>1</span><div><b>Select</b><small>Terminal requests</small></div></li>
          <li className={step === 'review' ? 'active' : step === 'create' ? 'complete' : ''}><span>2</span><div><b>Review</b><small>Irreversible scope</small></div></li>
          <li className={step === 'create' ? 'active' : ''}><span>3</span><div><b>Create</b><small>On-chain packets</small></div></li>
        </ol>

        {step === 'select' && (
          <section className="card disclosure-builder" aria-labelledby="select-scope-title">
            <div className="section-heading">
              <div>
                <h3 id="select-scope-title">Select terminal requests</h3>
                <p>{mode === 'guided-facilitated'
                  ? <>Requests are bound to run <span className="mono">{session?.runId}</span>; repeat the builder to cover a deliberately omitted request.</>
                  : 'Up to eight terminal requests may be selected; requests are grouped into one packet per mandate.'}</p>
              </div>
              <span className={`pill ${mode === 'guided-facilitated' && !allGuidedTerminal ? 'warn' : 'ok'}`}>
                {mode === 'guided-facilitated' ? `${scope.filter(terminal).length}/3 TERMINAL` : `${scope.length} ELIGIBLE`}
              </span>
            </div>
            {mode === 'admin-wallet' && (
              <div className="review-scope-facts">
                <div><dt>Auditor address</dt><dd><input aria-label="Auditor address" className="mono" value={auditor} disabled={adminCheckpointHasLockedPointers} onChange={(event) => setAuditor(event.target.value)} /></dd></div>
                <div><dt>Authority</dt><dd>Connected Finance Admin wallet</dd></div>
              </div>
            )}
            {identityMismatches.length > 0 && (
              <div className="inline-alert error" role="alert">
                <b>Run identity check failed.</b> {identityMismatches.map(({ identityError }) => identityError).join(' ')} These objects cannot be selected or disclosed through the guided run.
              </div>
            )}
            <div className="disclosure-request-list">
              {scope.map(({ id, mission, scenario, request, identityError }) => (
                <label key={id} className={`disclosure-request ${selected.has(id) ? 'selected' : ''}`}>
                  <input type="checkbox" checked={selected.has(id)} disabled={!request || !TERMINAL_STATES.has(request.state) || !!identityError || (mode === 'admin-wallet' && adminCheckpointHasLockedPointers)} onChange={() => toggle(id)} />
                  <span>
                    <b>{scenario?.vendor ?? (identityError && mission ? `Unverified ${scenarioByKey(mission).vendor} binding` : vendorName(request?.recipient) ?? `Request #${id}`)}</b>
                    <small>{scenario ? `${scenario.amount} cUSDC · ` : request ? `Mandate #${request.mandateId} · ${short(request.recipient)} · ` : ''}Request #{id}</small>
                  </span>
                  <span className={`pill ${identityError ? 'bad' : request?.state === 2 ? 'ok' : request?.state === 4 || request?.state === 5 ? 'bad' : 'warn'}`}>
                    {identityError ? 'IDENTITY MISMATCH' : request ? (REQUEST_STATES[request.state] ?? `STATE ${request.state}`).replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase() : 'LOADING'}
                  </span>
                </label>
              ))}
              {!scope.length && <div className="empty-state"><h3>No eligible request objects</h3><p className="muted">Complete the three payment missions, or connect an Admin wallet after terminal requests exist.</p></div>}
            </div>
            <div className="sticky-actions">
              <span className="muted">{selectedIds.length} selected{mode === 'guided-facilitated' ? ` · ${coveredCount}/3 already covered` : ' · maximum 8'}</span>
              {mode === 'guided-facilitated' && guidedCoverageComplete
                ? <button type="button" className="btn primary" onClick={openAudit}>Continue as Auditor</button>
                : <button type="button" className="btn primary" disabled={!selectionValid} onClick={reviewSelection}>Review selected scope</button>}
            </div>
          </section>
        )}

        {step === 'review' && (
          <section className="card disclosure-review" aria-labelledby="review-scope-title">
            <div className="section-heading">
              <div><h3 id="review-scope-title">Review the irreversible snapshot scope</h3><p>{mode === 'guided-facilitated' ? 'You confirm the scope; the facilitated Admin service validates and submits it.' : 'Your Finance Admin wallet will submit this exact scope.'}</p></div>
              <span className="pill warn">ON-CHAIN ACTION</span>
            </div>
            <div className="fixed-scope">
              <div><span className="pill tee">FIXED</span><b>Policy snapshot fields</b><p>Auto-limit · Budget left · Reserve floor</p></div>
              <div><span className="pill tee">PER REQUEST</span><b>Request snapshot fields</b><p>Amount · Blocked reason</p></div>
            </div>
            <div className="inline-alert warning"><b>VeilGuardModule v1 limitation.</b> The three policy values are always included by the deployed contract. The selected request list is the only variable disclosure scope.</div>
            <dl className="review-scope-facts">
              <div><dt>Selected requests</dt><dd>{selectedIds.map((id) => `#${id}`).join(', ')}</dd></div>
              <div><dt>Mandate groups</dt><dd>{new Set(selectedEntries.map(({ request }) => String(request?.mandateId))).size}</dd></div>
              <div><dt>Auditor</dt><dd>{mode === 'guided-facilitated' ? 'Fixed Demo Auditor' : <span className="mono">{short(auditor)}</span>}</dd></div>
              <div><dt>Executing actor</dt><dd>{mode === 'guided-facilitated' ? 'Facilitated Finance Admin' : 'Connected Finance Admin'}</dd></div>
            </dl>
            {error && <div className="inline-alert error" role="alert">{error}</div>}
            {mode === 'admin-wallet' && adminCheckpoint && (
              <div className="inline-alert neutral" role="status">
                <b>{completedAdminDisclosureGroups(adminCheckpoint)}/{Object.keys(adminCheckpoint.groups).length} local recovery pointers contain packet metadata.</b> Every stored receipt, event and Audit Packet is revalidated on-chain before reuse. {adminCheckpointHasLockedPointers && 'Wallet or broadcast pointers remain locked until the prompt, receipt and packet are classified.'}
                {adminSignaturePendingGroups.length > 0 && (
                  <span className="inline-confirm" role="alert">
                    An unknown wallet outcome cannot be cleared from this recovered page. Resolve the original prompt and retry chain recovery; if the prompt was lost, use manual chain reconciliation. No duplicate signature will be requested.
                  </span>
                )}
                <button type="button" className="btn ghost small" disabled={busy || adminCheckpointHasLockedPointers} onClick={discardAdminRecovery}>{adminCheckpointHasLockedPointers ? 'Recovery pointers locked' : 'Discard recovery pointers'}</button>
              </div>
            )}
            <div className="sticky-actions">
              <button type="button" className="btn ghost" disabled={busy} onClick={() => setStep('select')}>Back to selection</button>
              <button type="button" className="btn primary" disabled={busy || !selectionValid} onClick={create}>{busy ? <><span className="spin" /> Creating or resuming packets…</> : mode === 'guided-facilitated' ? 'Request facilitated packet creation' : 'Create packets with Admin wallet'}</button>
            </div>
          </section>
        )}

        {step === 'create' && result && (
          <section className="card disclosure-created" aria-labelledby="created-title">
            <div className="section-heading">
              <div><p className="workspace-kicker">Created successfully</p><h3 id="created-title">Review Bundle updated</h3><p>Bundle <span className="mono">{result.bundleId.slice(0, 12)}…</span> is a UI grouping, not a new on-chain object.</p></div>
              <span className="pill ok">{result.packets.length} PACKET{result.packets.length === 1 ? '' : 'S'}</span>
            </div>
            <div className="packet-result-list">
              {result.packets.map((packet) => (
                <div key={packet.packetId}>
                  <span><b>Packet #{packet.packetId}</b><small>Mandate #{packet.mandateId} · Requests {packet.requestIds.map((id) => `#${id}`).join(', ')}{packet.tx && <> · <a href={scanTx(packet.tx)} target="_blank" rel="noopener noreferrer">transaction ↗</a></>}</small></span>
                  <span className={`pill ${packet.reused ? 'dim' : 'ok'}`}>{packet.reused ? 'REUSED' : 'CREATED'}</span>
                </div>
              ))}
            </div>
            {mode === 'guided-facilitated' && (
              <div className={`inline-alert ${guidedCoverageComplete ? 'neutral' : 'warning'}`}>
                <b>{coveredCount}/3 Launch Day requests covered.</b> {guidedCoverageComplete
                  ? 'The Auditor can now review every request required by the mission.'
                  : 'This selective operation was real. Add the remaining request scope before handing off to the Auditor.'}
              </div>
            )}
            {mode === 'admin-wallet' && <div className="inline-alert neutral">The Auditor must unlock every snapshot and verify the immutable manifest before relying on this packet.</div>}
            <div className="sticky-actions">
              {mode === 'guided-facilitated' && !guidedCoverageComplete && <button type="button" className="btn primary" onClick={addRemaining}>Add remaining disclosure</button>}
              {(mode === 'admin-wallet' || guidedCoverageComplete) && <button type="button" className="btn primary" onClick={openAudit}>{mode === 'guided-facilitated' ? 'Continue as Auditor' : 'Open Audit Packets'}</button>}
            </div>
          </section>
        )}
      </>}
    </>
  );
}
