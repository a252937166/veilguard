import { createPublicClient, http, parseAbiItem } from 'viem';
import { sepolia } from 'viem/chains';
import { ADDR } from './config';
import { publicClient } from './nox';

/** Module deploy block (2026-07-17) — logs are fetched from here in ≤9.5k-block
 *  chunks because public Sepolia RPCs cap eth_getLogs ranges. publicnode rejects
 *  archive getLogs without a token, so log queries use dedicated log-friendly
 *  endpoints. All six event signatures share one OR-filtered request per chunk;
 *  issuing one request per event exhausts public browser rate limits on reload. */
const DEPLOY_BLOCK = 11_295_790n;
const CHUNK = 9_500n;
const LOG_RPCS = ['https://gateway.tenderly.co/public/sepolia', 'https://sepolia.drpc.org'];
const logClients = LOG_RPCS.map((u) => createPublicClient({ chain: sepolia, transport: http(u) }));

async function getLogsRobust(params: any): Promise<any[]> {
  let err: unknown;
  for (const c of logClients) {
    try { return await c.getLogs(params); } catch (e) { err = e; }
  }
  throw err;
}

const EVENTS = {
  requested: parseAbiItem('event SpendRequested(uint256 indexed requestId, uint256 indexed mandateId, address indexed delegate, address recipient, bytes32 decisionHandle)'),
  executed: parseAbiItem('event SpendExecuted(uint256 indexed requestId)'),
  blocked: parseAbiItem('event SpendBlocked(uint256 indexed requestId)'),
  escalated: parseAbiItem('event EscalationReady(uint256 indexed requestId)'),
  approved: parseAbiItem('event EscalationExecuted(uint256 indexed requestId)'),
  rejected: parseAbiItem('event EscalationCancelled(uint256 indexed requestId)'),
} as const;
const REQUEST_EVENTS = Object.values(EVENTS);

export const requestLogQuery = (fromBlock: bigint, toBlock: bigint) => ({
  address: ADDR.VeilGuardModule,
  events: REQUEST_EVENTS,
  fromBlock,
  toBlock,
});

export type RequestTxs = {
  request?: `0x${string}`;
  finalize?: `0x${string}`;
  approval?: `0x${string}`;
  cancellation?: `0x${string}`;
  outcomePath?: 'direct' | 'approval' | 'blocked';
  safeAction?: 'approve' | 'reject';
};

/** The event proves a cancellation transaction, never a user-selected Reject. */
export const ESCALATION_CANCELLATION_EVIDENCE = Object.freeze({ outcomePath: 'approval' as const });

let cache: Map<string, RequestTxs> | null = null;
let inflight: Promise<Map<string, RequestTxs>> | null = null;

/** requestId -> {request, finalize, approval} tx hashes, fetched once per session.
 *  Pass force=true to re-scan (e.g. right after a new finalize/approval landed). */
export function fetchRequestTxs(force = false): Promise<Map<string, RequestTxs>> {
  if (force) cache = null;
  if (cache) return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = (async () => {
    const map = new Map<string, RequestTxs>();
    const upsert = (id: bigint, k: 'request' | 'finalize' | 'approval' | 'cancellation', tx: `0x${string}`) => {
      const cur = map.get(String(id)) ?? {};
      cur[k] = tx;
      map.set(String(id), cur);
    };
    const annotate = (id: bigint, patch: Pick<RequestTxs, 'outcomePath' | 'safeAction'>) => {
      map.set(String(id), { ...(map.get(String(id)) ?? {}), ...patch });
    };
    const latest = await publicClient.getBlockNumber();
    for (let from = DEPLOY_BLOCK; from <= latest; from += CHUNK) {
      const toBlock = from + CHUNK - 1n > latest ? latest : from + CHUNK - 1n;
      const logs = await getLogsRobust(requestLogQuery(from, toBlock));
      for (const log of logs) {
        const id = log.args?.requestId as bigint | undefined;
        if (id === undefined) continue;
        switch (log.eventName) {
          case 'SpendRequested':
            upsert(id, 'request', log.transactionHash);
            break;
          case 'SpendExecuted':
            upsert(id, 'finalize', log.transactionHash);
            annotate(id, { outcomePath: 'direct' });
            break;
          case 'SpendBlocked':
            upsert(id, 'finalize', log.transactionHash);
            annotate(id, { outcomePath: 'blocked' });
            break;
          case 'EscalationReady':
            upsert(id, 'finalize', log.transactionHash);
            annotate(id, { outcomePath: 'approval' });
            break;
          case 'EscalationExecuted':
            upsert(id, 'approval', log.transactionHash);
            annotate(id, { outcomePath: 'approval', safeAction: 'approve' });
            break;
          case 'EscalationCancelled':
            upsert(id, 'cancellation', log.transactionHash);
            annotate(id, ESCALATION_CANCELLATION_EVIDENCE);
            break;
        }
      }
    }
    cache = map;
    return map;
  })().finally(() => { inflight = null; });
  return inflight;
}
