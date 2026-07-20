import { fallback, http } from 'viem';
import { RPC_URL } from './config';

/**
 * Browser-safe Sepolia endpoints, ordered by observed CORS and availability.
 * Keep reads and writes on the same pool so a local Demo signer does not
 * become a single-RPC action path while the dashboard appears healthy.
 */
export const BROWSER_RPC_URLS = [
  'https://sepolia.drpc.org',
  'https://gateway.tenderly.co/public/sepolia',
  RPC_URL,
] as const;

export const sepoliaReadTransport = fallback(
  BROWSER_RPC_URLS.map((url) => http(url, { batch: true })),
  { retryCount: 2 },
);

export const sepoliaWriteTransport = fallback(
  BROWSER_RPC_URLS.map((url) => http(url)),
  { retryCount: 2 },
);
