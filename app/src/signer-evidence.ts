import type { DemoRequestIdentity } from './demo-scenarios';
import { trustedDemoScenarioForRequest } from './demo-scenarios';
import type { RequestTxs } from './txlog';

export type SignerRequestIdentity = {
  trusted: boolean;
  vendor: string;
  purpose: string;
};

const UNKNOWN_IDENTITY: SignerRequestIdentity = Object.freeze({
  trusted: false,
  vendor: 'Recipient identity unavailable',
  purpose: 'Private memo unavailable',
});

/**
 * Business labels are Demo input metadata, not public-chain facts. Only attach
 * them when the request is cryptographically bound to the active Demo run.
 */
export function signerRequestIdentity(
  runId: string | undefined,
  isDemoMode: boolean,
  request: DemoRequestIdentity | undefined,
): SignerRequestIdentity {
  const scenario = isDemoMode ? trustedDemoScenarioForRequest(runId, request) : undefined;
  return scenario
    ? { trusted: true, vendor: scenario.vendor, purpose: scenario.purpose }
    : UNKNOWN_IDENTITY;
}

function hasIndexedSafeDecision(
  requestId: DemoRequestIdentity['id'],
  transactions: ReadonlyMap<string, RequestTxs>,
): boolean {
  const evidence = transactions.get(String(requestId));
  return Boolean(evidence?.approval || evidence?.cancellation);
}

/**
 * Connected Safe owners see every terminal exception supported by an indexed
 * approval/cancellation event, regardless of recipient. Demo history remains
 * scoped to the active run-bound ShieldOps scenario.
 */
export function signerDecisionHistory<T extends DemoRequestIdentity>(
  requests: readonly T[],
  transactions: ReadonlyMap<string, RequestTxs>,
  options: { runId?: string; isDemoMode: boolean; limit?: number },
): T[] {
  const { runId, isDemoMode, limit = 5 } = options;
  return requests
    .filter((request) => (request.state === 2 || request.state === 5)
      && (isDemoMode
        ? trustedDemoScenarioForRequest(runId, request)?.key === 'approval'
        : hasIndexedSafeDecision(request.id, transactions)))
    .sort((a, b) => {
      const left = BigInt(String(a.id));
      const right = BigInt(String(b.id));
      return left === right ? 0 : left > right ? -1 : 1;
    })
    .slice(0, limit);
}
