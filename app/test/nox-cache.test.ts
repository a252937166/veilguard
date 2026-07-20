import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createHandleClient: vi.fn(),
  createWalletClient: vi.fn(() => ({ transport: 'wallet' })),
}));

vi.mock('viem', () => ({
  createPublicClient: vi.fn(() => ({})),
  createWalletClient: mocks.createWalletClient,
  custom: vi.fn(() => 'custom-transport'),
}));
vi.mock('viem/chains', () => ({ sepolia: { id: 11155111 } }));
vi.mock('@iexec-nox/handle', () => ({ createViemHandleClient: mocks.createHandleClient }));
vi.mock('../src/demo', () => ({ demoWalletByAddress: vi.fn(() => undefined) }));
vi.mock('../src/rpc', () => ({ sepoliaReadTransport: 'read-fallback' }));

import { handleClientFor, setActiveProvider } from '../src/nox';

const account = '0x1111111111111111111111111111111111111111' as const;

beforeEach(() => {
  mocks.createHandleClient.mockReset();
  mocks.createWalletClient.mockClear();
  setActiveProvider({ request: vi.fn() });
});

test('a rejected Nox handle client bootstrap is evicted and can be retried', async () => {
  mocks.createHandleClient
    .mockRejectedValueOnce(new Error('provider temporarily unavailable'))
    .mockResolvedValueOnce({ id: 'retry-ok' });

  await expect(handleClientFor(account)).rejects.toThrow('temporarily unavailable');
  await expect(handleClientFor(account)).resolves.toEqual({ id: 'retry-ok' });
  expect(mocks.createHandleClient).toHaveBeenCalledTimes(2);
});

test('switching the injected provider invalidates account-bound handle clients', async () => {
  mocks.createHandleClient
    .mockResolvedValueOnce({ id: 'provider-a' })
    .mockResolvedValueOnce({ id: 'provider-b' });
  const providerA = { request: vi.fn() };
  const providerB = { request: vi.fn() };

  setActiveProvider(providerA);
  await expect(handleClientFor(account)).resolves.toEqual({ id: 'provider-a' });
  setActiveProvider(providerB);
  await expect(handleClientFor(account)).resolves.toEqual({ id: 'provider-b' });

  expect(mocks.createHandleClient).toHaveBeenCalledTimes(2);
});
