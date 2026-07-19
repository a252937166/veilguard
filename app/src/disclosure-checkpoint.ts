export const ADMIN_DISCLOSURE_CHECKPOINT_VERSION = 1 as const;

export type AdminDisclosureGroupCheckpoint = {
  mandateId: number;
  requestIds: string[];
  /** Wallet prompt opened but no transaction hash has been observed yet. */
  signaturePendingAt?: number;
  signatureStartBlock?: string;
  transactionHash?: `0x${string}`;
  packetId?: number;
  manifestHash?: `0x${string}`;
};

export type AdminDisclosureCheckpoint = {
  version: typeof ADMIN_DISCLOSURE_CHECKPOINT_VERSION;
  runKey: string;
  account: `0x${string}`;
  auditor: `0x${string}`;
  scopeKey: string;
  selectedRequestIds: string[];
  groups: Record<string, AdminDisclosureGroupCheckpoint>;
  updatedAt: number;
};

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

// Keeps a known broadcast pointer alive across SPA route unmounts even if the
// browser starts rejecting durable-storage writes after the wallet prompt.
// Durable localStorage remains mandatory before the first signature.
const volatileCheckpoints = new Map<string, string>();

const storageOrUndefined = (): StorageLike | undefined => {
  // A broadcast transaction can outlive the current tab and demo session.
  // Keep its recovery pointer in durable origin storage so closing the tab or
  // starting another guided run cannot make the pending hash disappear.
  try { return typeof localStorage === 'undefined' ? undefined : localStorage; }
  catch { return undefined; }
};

const normalizedIds = (ids: readonly string[]) => [...new Set(ids)].sort((a, b) => {
  try {
    const left = BigInt(a);
    const right = BigInt(b);
    return left === right ? 0 : left < right ? -1 : 1;
  } catch {
    return a.localeCompare(b);
  }
});

export function adminDisclosureCheckpointKey(runKey: string, account: string): string {
  return `vg_admin_disclosure_v1:${encodeURIComponent(runKey)}:${account.toLowerCase()}`;
}

export function adminDisclosureScopeKey(
  auditor: string,
  groups: ReadonlyMap<string, readonly string[]> | Record<string, readonly string[]>,
): string {
  const entries = groups instanceof Map ? [...groups.entries()] : Object.entries(groups);
  return `${auditor.toLowerCase()}|${entries
    .map(([mandateId, requestIds]) => [mandateId, normalizedIds(requestIds)] as const)
    .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
    .map(([mandateId, requestIds]) => `${mandateId}:${requestIds.join(',')}`)
    .join('|')}`;
}

export function createAdminDisclosureCheckpoint(options: {
  runKey: string;
  account: `0x${string}`;
  auditor: `0x${string}`;
  groups: ReadonlyMap<string, readonly string[]> | Record<string, readonly string[]>;
  now?: number;
}): AdminDisclosureCheckpoint {
  const entries = options.groups instanceof Map ? [...options.groups.entries()] : Object.entries(options.groups);
  const groups = Object.fromEntries(entries.map(([mandateId, requestIds]) => [mandateId, {
    mandateId: Number(mandateId),
    requestIds: normalizedIds(requestIds),
  } satisfies AdminDisclosureGroupCheckpoint]));
  return {
    version: ADMIN_DISCLOSURE_CHECKPOINT_VERSION,
    runKey: options.runKey,
    account: options.account,
    auditor: options.auditor,
    scopeKey: adminDisclosureScopeKey(options.auditor, options.groups),
    selectedRequestIds: normalizedIds(entries.flatMap(([, requestIds]) => [...requestIds])),
    groups,
    updatedAt: options.now ?? Date.now(),
  };
}

const isHexHash = (value: unknown): value is `0x${string}` =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);

function hydrateCheckpoint(value: unknown, runKey: string, account: string): AdminDisclosureCheckpoint | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<AdminDisclosureCheckpoint>;
  if (raw.version !== ADMIN_DISCLOSURE_CHECKPOINT_VERSION
    || raw.runKey !== runKey
    || raw.account?.toLowerCase() !== account.toLowerCase()
    || typeof raw.auditor !== 'string'
    || typeof raw.scopeKey !== 'string'
    || !raw.groups || typeof raw.groups !== 'object') return null;

  const groups: Record<string, AdminDisclosureGroupCheckpoint> = {};
  for (const [key, candidate] of Object.entries(raw.groups)) {
    if (!candidate || typeof candidate !== 'object') return null;
    const group = candidate as Partial<AdminDisclosureGroupCheckpoint>;
    if (!Number.isSafeInteger(group.mandateId)
      || !Array.isArray(group.requestIds)
      || group.requestIds.some((id) => typeof id !== 'string')) return null;
    groups[key] = {
      mandateId: group.mandateId!,
      requestIds: normalizedIds(group.requestIds as string[]),
      ...(typeof group.signaturePendingAt === 'number' && Number.isFinite(group.signaturePendingAt)
        ? { signaturePendingAt: group.signaturePendingAt } : {}),
      ...(typeof group.signatureStartBlock === 'string' && /^\d+$/.test(group.signatureStartBlock)
        ? { signatureStartBlock: group.signatureStartBlock } : {}),
      ...(isHexHash(group.transactionHash) ? { transactionHash: group.transactionHash } : {}),
      ...(Number.isSafeInteger(group.packetId) ? { packetId: group.packetId } : {}),
      ...(isHexHash(group.manifestHash) ? { manifestHash: group.manifestHash } : {}),
    };
  }

  const checkpoint: AdminDisclosureCheckpoint = {
    version: ADMIN_DISCLOSURE_CHECKPOINT_VERSION,
    runKey,
    account: raw.account as `0x${string}`,
    auditor: raw.auditor as `0x${string}`,
    scopeKey: raw.scopeKey,
    selectedRequestIds: normalizedIds(Object.values(groups).flatMap(({ requestIds }) => requestIds)),
    groups,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
  };
  return checkpoint.scopeKey === adminDisclosureScopeKey(
    checkpoint.auditor,
    Object.fromEntries(Object.entries(groups).map(([key, group]) => [key, group.requestIds])),
  ) ? checkpoint : null;
}

export function loadAdminDisclosureCheckpoint(
  runKey: string,
  account: string,
  storage: StorageLike | undefined = storageOrUndefined(),
): AdminDisclosureCheckpoint | null {
  const key = adminDisclosureCheckpointKey(runKey, account);
  const candidates: AdminDisclosureCheckpoint[] = [];
  const addCandidate = (encoded: string | null | undefined) => {
    if (!encoded) return;
    try {
      const hydrated = hydrateCheckpoint(JSON.parse(encoded), runKey, account);
      if (hydrated) candidates.push(hydrated);
    } catch { /* ignore malformed recovery data */ }
  };
  addCandidate(volatileCheckpoints.get(key));
  try {
    if (storage) addCandidate(storage.getItem(key));
  } catch { /* volatile candidate remains available */ }
  // A second tab may have persisted a broadcast after this tab cached the
  // pre-sign checkpoint. Never let the older volatile value hide the newer
  // durable hash.
  const evidenceWeight = (checkpoint: AdminDisclosureCheckpoint) => Object.values(checkpoint.groups)
    .reduce((weight, group) => weight
      + (group.transactionHash ? 16 : 0)
      + (group.signaturePendingAt ? 8 : 0)
      + (group.packetId != null ? 2 : 0)
      + (group.manifestHash ? 1 : 0), 0);
  return candidates.sort((left, right) =>
    (right.updatedAt - left.updatedAt) || (evidenceWeight(right) - evidenceWeight(left)))[0] ?? null;
}

export function saveAdminDisclosureCheckpoint(
  checkpoint: AdminDisclosureCheckpoint,
  storage: StorageLike | undefined = storageOrUndefined(),
): boolean {
  const key = adminDisclosureCheckpointKey(checkpoint.runKey, checkpoint.account);
  const encoded = JSON.stringify({ ...checkpoint, updatedAt: Date.now() });
  volatileCheckpoints.set(key, encoded);
  if (!storage) return false;
  try {
    storage.setItem(key, encoded);
    return true;
  } catch {
    return false;
  }
}

export function removeAdminDisclosureCheckpoint(
  runKey: string,
  account: string,
  storage: StorageLike | undefined = storageOrUndefined(),
): boolean {
  const key = adminDisclosureCheckpointKey(runKey, account);
  if (!storage) return false;
  try {
    storage.removeItem(key);
    volatileCheckpoints.delete(key);
    return true;
  } catch {
    return false;
  }
}

export function updateAdminDisclosureGroup(
  checkpoint: AdminDisclosureCheckpoint,
  mandateId: string,
  patch: Partial<AdminDisclosureGroupCheckpoint>,
  now = Date.now(),
): AdminDisclosureCheckpoint {
  const current = checkpoint.groups[mandateId];
  if (!current) return checkpoint;
  return {
    ...checkpoint,
    groups: { ...checkpoint.groups, [mandateId]: { ...current, ...patch } },
    updatedAt: now,
  };
}

export function completedAdminDisclosureGroups(checkpoint: AdminDisclosureCheckpoint): number {
  return Object.values(checkpoint.groups).filter((group) =>
    group.packetId != null && !!group.manifestHash && !!group.transactionHash).length;
}

export function isAdminDisclosureCheckpointComplete(checkpoint: AdminDisclosureCheckpoint): boolean {
  // Local completeness only means every recovery pointer field is present. It
  // is never evidence that a transaction or Audit Packet exists on-chain.
  const groups = Object.values(checkpoint.groups);
  return groups.length > 0 && completedAdminDisclosureGroups(checkpoint) === groups.length;
}
