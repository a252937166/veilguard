import { createPublicClient, http, parseAbiItem } from 'viem';
import { sepolia } from 'viem/chains';
import { ADDR } from './config';
import { publicClient } from './nox';

/** Module deploy block (2026-07-17) — logs are fetched from here in ≤9.5k-block
 *  chunks because public Sepolia RPCs cap eth_getLogs ranges. publicnode rejects
 *  ranged getLogs outright (deterministic error, so the fallback transport won't
 *  rotate), so log queries use dedicated log-friendly endpoints. */
const DEPLOY_BLOCK = 11_295_790n;
const CHUNK = 9_500n;
const LOG_RPCS = ['https://sepolia.drpc.org', 'https://ethereum-sepolia.blockpi.network/v1/rpc/public'];
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

export type RequestTxs = {
  request?: `0x${string}`;
  finalize?: `0x${string}`;
  approval?: `0x${string}`;
  cancellation?: `0x${string}`;
  outcomePath?: 'direct' | 'approval' | 'blocked';
  safeAction?: 'approve' | 'reject';
};

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
      const [req, exe, blk, esc, app, rej] = await Promise.all([
        getLogsRobust({ address: ADDR.VeilGuardModule, event: EVENTS.requested, fromBlock: from, toBlock }),
        getLogsRobust({ address: ADDR.VeilGuardModule, event: EVENTS.executed, fromBlock: from, toBlock }),
        getLogsRobust({ address: ADDR.VeilGuardModule, event: EVENTS.blocked, fromBlock: from, toBlock }),
        getLogsRobust({ address: ADDR.VeilGuardModule, event: EVENTS.escalated, fromBlock: from, toBlock }),
        getLogsRobust({ address: ADDR.VeilGuardModule, event: EVENTS.approved, fromBlock: from, toBlock }),
        getLogsRobust({ address: ADDR.VeilGuardModule, event: EVENTS.rejected, fromBlock: from, toBlock }),
      ]);
      req.forEach((l) => upsert(l.args.requestId!, 'request', l.transactionHash));
      exe.forEach((l) => { upsert(l.args.requestId!, 'finalize', l.transactionHash); annotate(l.args.requestId!, { outcomePath: 'direct' }); });
      blk.forEach((l) => { upsert(l.args.requestId!, 'finalize', l.transactionHash); annotate(l.args.requestId!, { outcomePath: 'blocked' }); });
      esc.forEach((l) => { upsert(l.args.requestId!, 'finalize', l.transactionHash); annotate(l.args.requestId!, { outcomePath: 'approval' }); });
      app.forEach((l) => { upsert(l.args.requestId!, 'approval', l.transactionHash); annotate(l.args.requestId!, { outcomePath: 'approval', safeAction: 'approve' }); });
      rej.forEach((l) => { upsert(l.args.requestId!, 'cancellation', l.transactionHash); annotate(l.args.requestId!, { outcomePath: 'approval', safeAction: 'reject' }); });
    }
    cache = map;
    return map;
  })().finally(() => { inflight = null; });
  return inflight;
}
