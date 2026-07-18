import { nox } from '@iexec-nox/nox-hardhat-plugin';
import { createViemHandleClient, type HandleClient } from '@iexec-nox/handle';

/** Deterministic address where the plugin etches NoxCompute on chain 31337. */
export const NOX_COMPUTE_ADDRESS = '0x75C6AF4430cc474b1bb9b8540b7E46D6f8e1C685' as const;

export function gatewayUrl(): `http://${string}` {
  const port = process.env.NOX_HANDLE_GATEWAY_HOST_PORT;
  if (!port) throw new Error('Nox handle gateway port not set — is the stack up?');
  return `http://127.0.0.1:${port}`;
}

/**
 * Handle client bound to a specific test wallet (encrypt/decrypt as that actor).
 *
 * Workaround for an SDK sharp edge: the viem adapter derives the actor identity
 * from `walletClient.getAddresses()[0]`, which on a Hardhat node always returns
 * account #0 regardless of `walletClient.account` — while signatures use
 * `walletClient.account`. We pin `getAddresses` to the wallet's own account so
 * identity and signature agree.
 */
export async function clientFor(walletClient: any): Promise<HandleClient> {
  const pinned = {
    ...walletClient,
    getAddresses: async () => [walletClient.account.address],
  };
  return createViemHandleClient(pinned, {
    smartContractAddress: NOX_COMPUTE_ADDRESS,
    gatewayUrl: gatewayUrl(),
    subgraphUrl: 'https://example.com/subgraphs/id/none',
  });
}

/** Waits until the offchain runner has resolved all given handles. */
export async function waitResolved(handles: string[], timeoutMs = 60_000): Promise<void> {
  const url = `${gatewayUrl()}/v0/public/handles/status`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handles }),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          payload: { statuses: { handle: string; resolved: boolean }[] };
        };
        const byHandle = new Map(
          data.payload.statuses.map((s) => [s.handle.toLowerCase(), s.resolved]),
        );
        if (handles.every((h) => byHandle.get(h.toLowerCase()) === true)) return;
      }
    } catch {
      // gateway briefly unavailable — retry
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`handles not resolved within ${timeoutMs}ms: ${handles.join(', ')}`);
}

/** Public-decrypts a handle with resolution wait + retry (TEE latency tolerant). */
export async function publicDecryptWithRetry(handle: string) {
  await waitResolved([handle]);
  return nox.publicDecrypt(handle as any);
}

export const D_EXECUTE = 1;
export const D_ESCALATE = 2;
export const D_BLOCKED = 3;
export const R_BUDGET = 1;
export const R_RESERVE = 3;

/** USDC-style 6-decimals helper. */
export const usdc = (n: number) => BigInt(Math.round(n * 1e6));
