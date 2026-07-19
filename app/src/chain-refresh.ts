export type RequestSnapshotLike = { id: string | number | bigint; state: number; decisionReady?: boolean };
export type MandateSnapshotLike = { id: string | number | bigint; state: number; version: number };

export function requestStateSnapshot(requests: readonly RequestSnapshotLike[]): Map<string, string> {
  return new Map(requests.map((request) => [
    String(request.id),
    `${request.state}:${request.decisionReady === true ? 'ready' : 'pending'}`,
  ]));
}

export function changedRequestIds(previous: ReadonlyMap<string, string>, current: ReadonlyMap<string, string>): string[] {
  return [...new Set([
    ...[...current.entries()].filter(([id, value]) => previous.get(id) !== value).map(([id]) => id),
    ...[...previous.keys()].filter((id) => !current.has(id)),
  ])];
}

export function chainSnapshotFingerprint(input: {
  mandates: readonly MandateSnapshotLike[];
  requests: ReadonlyMap<string, string>;
  owners: readonly string[];
  financeAdmin?: string;
  paused: boolean;
}): string {
  return JSON.stringify({
    mandates: input.mandates.map((mandate) => [String(mandate.id), mandate.state, mandate.version]),
    requests: [...input.requests.entries()],
    owners: input.owners.map((owner) => owner.toLowerCase()),
    financeAdmin: input.financeAdmin?.toLowerCase() ?? null,
    paused: input.paused,
  });
}
