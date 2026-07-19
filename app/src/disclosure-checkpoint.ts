export const ADMIN_DISCLOSURE_CHECKPOINT_VERSION = 1 as const;

export type AdminDisclosureGroupCheckpoint = {
  mandateId: number;
  requestIds: string[];
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

const storageOrUndefined = (): StorageLike | undefined => {
  try { return typeof sessionStorage === 'undefined' ? undefined : sessionStorage; }
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
  if (!storage) return null;
  try {
    const encoded = storage.getItem(adminDisclosureCheckpointKey(runKey, account));
    return encoded ? hydrateCheckpoint(JSON.parse(encoded), runKey, account) : null;
  } catch {
    return null;
  }
}

export function saveAdminDisclosureCheckpoint(
  checkpoint: AdminDisclosureCheckpoint,
  storage: StorageLike | undefined = storageOrUndefined(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(
      adminDisclosureCheckpointKey(checkpoint.runKey, checkpoint.account),
      JSON.stringify({ ...checkpoint, updatedAt: Date.now() }),
    );
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
  if (!storage) return false;
  try {
    storage.removeItem(adminDisclosureCheckpointKey(runKey, account));
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
