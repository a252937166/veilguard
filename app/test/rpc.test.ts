import { expect, test } from 'vitest';
import { BROWSER_RPC_URLS } from '../src/rpc';

test('browser RPC fallback contains only the verified CORS-capable Sepolia endpoints', () => {
  expect(BROWSER_RPC_URLS).toEqual([
    'https://ethereum-sepolia-rpc.publicnode.com',
    'https://gateway.tenderly.co/public/sepolia',
    'https://sepolia.drpc.org',
  ]);
  expect(BROWSER_RPC_URLS.join(' ')).not.toMatch(/blockpi|omnia|rpc\.sepolia\.org/i);
});
