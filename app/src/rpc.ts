import { fallback, http } from 'viem';
import { RPC_URL } from './config';

/**
 * Browser-safe Sepolia endpoints, ordered by observed CORS and availability.
 * PublicNode leads because dRPC's free browser pool can return bursts of 429s;
 * dRPC remains a last-resort fallback instead of polluting healthy page loads.
 * Keep reads and writes on the same pool so a local Demo signer does not
 * become a single-RPC action path while the dashboard appears healthy.
 */
export const BROWSER_RPC_URLS = [
  RPC_URL,
  'https://gateway.tenderly.co/public/sepolia',
  'https://sepolia.drpc.org',
] as const;

export const sepoliaReadTransport = fallback(
  BROWSER_RPC_URLS.map((url) => http(url, { batch: true })),
  { retryCount: 2 },
);

export const sepoliaWriteTransport = fallback(
  BROWSER_RPC_URLS.map((url) => http(url)),
  { retryCount: 2 },
);
