import type { Transport } from 'viem';

export class RpcBroadcastError extends Error {
  transactionHash?: `0x${string}`;
  broadcastUncertain: true;
}

export function parseRpcUrls(
  primary?: string | string[],
  fallbackUrls?: string | string[],
  defaults?: readonly string[],
): string[];

export function createGuardedRpcFallback(options: {
  urls: string[];
  chainId: bigint | number;
  timeoutMs?: number;
  quarantineMs?: number;
  chainCheckTtlMs?: number;
}): {
  transport: Transport;
  status(): {
    endpointCount: number;
    fallbackConfigured: boolean;
    broadcastStrategy: 'single-endpoint-no-retry';
    quarantinedEndpoints: number;
    hasBroadcastEndpoint: boolean;
  };
};
