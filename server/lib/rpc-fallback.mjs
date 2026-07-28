import { createTransport, fallback, http, keccak256 } from 'viem';

const BROADCAST_METHODS = new Set([
  'eth_sendRawTransaction',
  'eth_sendTransaction',
  'eth_sendUserOperation',
  'wallet_sendCalls',
]);

export class RpcBroadcastError extends Error {
  constructor(message, { cause, transactionHash } = {}) {
    super(message, { cause });
    this.name = 'RpcBroadcastError';
    this.transactionHash = transactionHash;
    // Consumers may safely monitor this deterministic hash, but must not
    // broadcast the transaction again merely because the RPC response failed.
    this.broadcastUncertain = true;
  }
}

function values(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  return value.split(',');
}

/**
 * Produce a validated, ordered, de-duplicated RPC list without ever including
 * a credential-bearing URL in an error message.
 */
export function parseRpcUrls(primary, fallbackUrls, defaults = []) {
  const candidates = [...values(primary), ...values(fallbackUrls), ...values(defaults)]
    .map((value) => String(value).trim())
    .filter(Boolean);
  const urls = [];
  for (let index = 0; index < candidates.length; index++) {
    let parsed;
    try { parsed = new URL(candidates[index]); }
    catch { throw new Error(`RPC URL #${index + 1} is invalid`); }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error(`RPC URL #${index + 1} must use http or https`);
    }
    if (!urls.includes(candidates[index])) urls.push(candidates[index]);
  }
  if (!urls.length) throw new Error('at least one RPC URL is required');
  return urls;
}

function transactionHash(method, params) {
  if (method !== 'eth_sendRawTransaction') return undefined;
  const serialized = params?.[0];
  if (typeof serialized !== 'string' || !/^0x[0-9a-fA-F]+$/.test(serialized)) return undefined;
  try { return keccak256(serialized); }
  catch { return undefined; }
}

/**
 * Read calls use viem's ordered fallback transport. Broadcasts deliberately do
 * not: a chain-id probe chooses one healthy endpoint, then the signed payload
 * is sent to that endpoint exactly once. An ambiguous transport failure is
 * surfaced with the locally derivable transaction hash and is never retried on
 * a second provider.
 */
export function createGuardedRpcFallback({
  urls,
  chainId,
  timeoutMs = 10_000,
  quarantineMs = 30_000,
  chainCheckTtlMs = 60_000,
  now = () => Date.now(),
  transportFactory = (url, options) => http(url, options),
} = {}) {
  if (!Array.isArray(urls) || urls.length < 1) throw new Error('RPC URL list is required');
  if (!Number.isInteger(Number(chainId)) || Number(chainId) < 1) throw new Error('expected chain id is required');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error('RPC timeout must be positive');
  if (!Number.isFinite(quarantineMs) || quarantineMs < 0) throw new Error('RPC quarantine must be non-negative');
  if (!Number.isFinite(chainCheckTtlMs) || chainCheckTtlMs < 1) throw new Error('RPC chain check TTL must be positive');

  const expectedChainId = BigInt(chainId);
  const quarantineUntil = new Map();
  const readChainVerifiedUntil = new Map();
  let lastBroadcastIndex = null;

  const transport = (clientConfig) => {
    const rawTransports = urls.map((url) => transportFactory(url, {
      retryCount: 0,
      timeout: timeoutMs,
    }));
    const direct = rawTransports.map((candidate) => candidate({
      ...clientConfig,
      retryCount: 0,
      timeout: timeoutMs,
    }));
    const readTransports = rawTransports.map((candidate, index) => (config) => {
      const endpoint = candidate({
        ...config,
        retryCount: 0,
        timeout: timeoutMs,
      });
      return createTransport({
        key: `veilguard-chain-guard-${index}`,
        name: `VeilGuard chain guard #${index + 1}`,
        type: 'chain-guard',
        retryCount: 0,
        timeout: timeoutMs,
        async request(request) {
          let actual;
          if ((readChainVerifiedUntil.get(index) ?? 0) <= now() || request.method === 'eth_chainId') {
            actual = BigInt(await endpoint.request({ method: 'eth_chainId' }));
            if (actual !== expectedChainId) {
              quarantineUntil.set(index, Number.POSITIVE_INFINITY);
              throw new Error('RPC endpoint is on the wrong chain');
            }
            readChainVerifiedUntil.set(index, now() + chainCheckTtlMs);
          }
          if (request.method === 'eth_chainId') {
            return `0x${(actual ?? expectedChainId).toString(16)}`;
          }
          return endpoint.request(request);
        },
      });
    });
    const readFallback = fallback(readTransports, { retryCount: 0 })({
      ...clientConfig,
      retryCount: 0,
      timeout: timeoutMs,
    });

    const selectBroadcastEndpoint = async () => {
      let lastError;
      for (let index = 0; index < direct.length; index++) {
        if ((quarantineUntil.get(index) ?? 0) > now()) continue;
        try {
          const actual = BigInt(await direct[index].request({ method: 'eth_chainId' }));
          if (actual !== expectedChainId) {
            quarantineUntil.set(index, Number.POSITIVE_INFINITY);
            lastError = new Error('RPC endpoint is on the wrong chain');
            continue;
          }
          return { endpoint: direct[index], index };
        } catch (error) {
          quarantineUntil.set(index, now() + quarantineMs);
          lastError = error;
        }
      }
      throw new RpcBroadcastError('no healthy RPC endpoint is available for a single broadcast', {
        cause: lastError,
      });
    };

    return createTransport({
      key: 'veilguard-guarded-rpc-fallback',
      name: 'VeilGuard guarded RPC fallback',
      type: 'guarded-fallback',
      retryCount: 0,
      timeout: timeoutMs,
      async request({ method, params }) {
        if (!BROADCAST_METHODS.has(method)) {
          return readFallback.request({ method, params });
        }

        const { endpoint, index } = await selectBroadcastEndpoint();
        lastBroadcastIndex = index;
        try {
          return await endpoint.request({ method, params });
        } catch (cause) {
          quarantineUntil.set(index, now() + quarantineMs);
          throw new RpcBroadcastError(
            'RPC broadcast response failed; the signed transaction was not retried on another provider',
            { cause, transactionHash: transactionHash(method, params) },
          );
        }
      },
    }, {
      endpointCount: urls.length,
      broadcastStrategy: 'single-endpoint-no-retry',
    });
  };

  return {
    transport,
    status() {
      const at = now();
      return {
        endpointCount: urls.length,
        fallbackConfigured: urls.length > 1,
        broadcastStrategy: 'single-endpoint-no-retry',
        quarantinedEndpoints: [...quarantineUntil.values()].filter((until) => until > at).length,
        hasBroadcastEndpoint: lastBroadcastIndex !== null,
      };
    },
  };
}
