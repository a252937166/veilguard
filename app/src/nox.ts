import {
  createPublicClient,
  createWalletClient,
  custom,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { sepolia } from 'viem/chains';
import { createViemHandleClient, type HandleClient } from '@iexec-nox/handle';
import { GATEWAY } from './config';
import { demoWalletByAddress } from './demo';
import { sepoliaReadTransport } from './rpc';
import type { Eip1193Provider } from './wallet';

/** The injected provider chosen at connect time (EIP-6963), or the legacy default. */
let activeProvider: Eip1193Provider | undefined;
const clientCache = new Map<string, Promise<HandleClient>>();
export function setActiveProvider(p: Eip1193Provider | undefined) {
  if (activeProvider !== p) clientCache.clear();
  activeProvider = p;
}
export function getActiveProvider(): Eip1193Provider | undefined {
  return activeProvider ?? (window as any).ethereum;
}

export const publicClient: PublicClient = createPublicClient({
  chain: sepolia,
  // JSON-RPC request batching per endpoint + Multicall3 aggregation: the dashboard's
  // ~20 getMandate/getRequest reads collapse into a single aggregate eth_call, so a
  // 10s poll no longer blows through free-tier rate limits.
  transport: sepoliaReadTransport,
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

/**
 * Handle client bound to the connected account. Pins `getAddresses` to that
 * account so encrypt-proof identity and decrypt signatures always agree
 * (workaround for the SDK deriving identity from `getAddresses()[0]`).
 */
export function handleClientFor(account: `0x${string}`): Promise<HandleClient> {
  const key = account.toLowerCase();
  let cached = clientCache.get(key);
  if (!cached) {
    const wallet = makeWalletClient(account);
    cached = createViemHandleClient(
      { ...wallet, getAddresses: async () => [account] } as any,
    );
    clientCache.set(key, cached);
    cached.catch(() => {
      // Provider denial, a transient RPC fault or SDK bootstrap failure must
      // remain retryable. Never pin a rejected Promise for the whole session.
      if (clientCache.get(key) === cached) clientCache.delete(key);
    });
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
