import { expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createWalletClient: vi.fn((options: unknown) => options),
  sharedWriteTransport: { name: 'shared-sepolia-write-fallback' },
}));

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return { ...actual, createWalletClient: mocks.createWalletClient };
});
vi.mock('../src/rpc', () => ({ sepoliaWriteTransport: mocks.sharedWriteTransport }));

import { demoWallet, freeplayWallet, violationWallet } from '../src/demo';

test('main, violation and Free Play demo signers share the multi-RPC write transport', () => {
  demoWallet('delegate');
  violationWallet();
  freeplayWallet();

  expect(mocks.createWalletClient).toHaveBeenCalledTimes(3);
  for (const [options] of mocks.createWalletClient.mock.calls) {
    expect(options).toMatchObject({ transport: mocks.sharedWriteTransport });
  }
});
