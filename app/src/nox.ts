import {
  createPublicClient,
  createWalletClient,
  custom,
  fallback,
  http,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { sepolia } from 'viem/chains';
import { createViemHandleClient, type HandleClient } from '@iexec-nox/handle';
import { GATEWAY, RPC_URL } from './config';
import { demoWalletByAddress } from './demo';
import type { Eip1193Provider } from './wallet';

/** The injected provider chosen at connect time (EIP-6963), or the legacy default. */
let activeProvider: Eip1193Provider | undefined;
export function setActiveProvider(p: Eip1193Provider | undefined) { activeProvider = p; }
export function getActiveProvider(): Eip1193Provider | undefined {
  return activeProvider ?? (window as any).ethereum;
}

const RPCS = [
  'https://sepolia.drpc.org',
  'https://gateway.tenderly.co/public/sepolia',
  // PublicNode supports browser CORS but intermittently rate-limits bursty
  // dashboard reads with 403. Keep it as a tertiary fallback rather than
  // allowing latency ranking to promote it ahead of the stable endpoints.
  RPC_URL,
];

export const publicClient: PublicClient = createPublicClient({
  chain: sepolia,
  // JSON-RPC request batching per endpoint + Multicall3 aggregation: the dashboard's
  // ~20 getMandate/getRequest reads collapse into a single aggregate eth_call, so a
  // 10s poll no longer blows through free-tier rate limits.
  transport: fallback(RPCS.map((u) => http(u, { batch: true })), { retryCount: 2 }),
  batch: { multicall: { wait: 24 } },
  // receipt waits poll at this cadence — the default 4s adds needless perceived
  // latency on a 12s-block testnet
  pollingInterval: 1_500,
}) as PublicClient;

export function makeWalletClient(account: `0x${string}`): WalletClient {
  // Demo-mode accounts sign locally (no wallet popups); everyone else goes
  // through the injected EIP-1193 provider.
  const demo = demoWalletByAddress(account);
  if (demo) return demo;
  return createWalletClient({
    account,
    chain: sepolia,
    transport: custom(getActiveProvider() as any),
  });
}

const clientCache = new Map<string, Promise<HandleClient>>();

/**
 * Handle client bound to the connected account. Pins `getAddresses` to that
 * account so encrypt-proof identity and decrypt signatures always agree
 * (workaround for the SDK deriving identity from `getAddresses()[0]`).
 */
export function handleClientFor(account: `0x${string}`): Promise<HandleClient> {
  let cached = clientCache.get(account);
  if (!cached) {
    const wallet = makeWalletClient(account);
    cached = createViemHandleClient(
      { ...wallet, getAddresses: async () => [account] } as any,
    );
    clientCache.set(account, cached);
  }
  return cached;
}

export async function handlesResolved(handles: string[]): Promise<boolean> {
  try {
    const res = await fetch(`${GATEWAY}/v0/public/handles/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handles }),
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) return false;
    const data = await res.json();
    const map = new Map<string, boolean>(
      data.payload.statuses.map((s: any) => [s.handle.toLowerCase(), s.resolved]),
    );
    return handles.every((h) => map.get(h.toLowerCase()) === true);
  } catch {
    return false;
  }
}

export async function waitResolved(handles: string[], timeoutMs = 180_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await handlesResolved(handles)) return;
    await new Promise((r) => setTimeout(r, 2500));
  }
  throw new Error('TEE did not resolve the handles in time');
}
