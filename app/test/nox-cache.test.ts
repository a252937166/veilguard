import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createHandleClient: vi.fn(),
  createWalletClient: vi.fn(() => ({ transport: 'wallet' })),
  demoWalletByAddress: vi.fn(() => undefined as any),
  ensureSepoliaNetwork: vi.fn(),
}));

vi.mock('viem', () => ({
  createPublicClient: vi.fn(() => ({})),
  createWalletClient: mocks.createWalletClient,
  custom: vi.fn(() => 'custom-transport'),
}));
vi.mock('viem/chains', () => ({ sepolia: { id: 11155111 } }));
vi.mock('@iexec-nox/handle', () => ({ createViemHandleClient: mocks.createHandleClient }));
vi.mock('../src/demo', () => ({ demoWalletByAddress: mocks.demoWalletByAddress }));
vi.mock('../src/rpc', () => ({ sepoliaReadTransport: 'read-fallback' }));
vi.mock('../src/wallet-network', () => ({ ensureSepoliaNetwork: mocks.ensureSepoliaNetwork }));

import { handleClientFor, setActiveProvider } from '../src/nox';

const account = '0x1111111111111111111111111111111111111111' as const;

beforeEach(() => {
  mocks.createHandleClient.mockReset();
  mocks.createWalletClient.mockClear();
  mocks.demoWalletByAddress.mockReset();
  mocks.demoWalletByAddress.mockReturnValue(undefined);
  mocks.ensureSepoliaNetwork.mockReset();
  mocks.ensureSepoliaNetwork.mockResolvedValue(11155111);
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

test('network failure prevents injected Nox signatures and client creation', async () => {
  mocks.ensureSepoliaNetwork.mockRejectedValueOnce(new Error('wrong wallet network'));

  await expect(handleClientFor(account)).rejects.toThrow('wrong wallet network');
  expect(mocks.createHandleClient).not.toHaveBeenCalled();
  expect(mocks.createWalletClient).not.toHaveBeenCalled();
});

test('demo accounts bypass the injected provider network guard', async () => {
  mocks.demoWalletByAddress.mockReturnValue({ transport: 'demo-wallet' });
  mocks.createHandleClient.mockResolvedValueOnce({ id: 'demo' });

  await expect(handleClientFor(account)).resolves.toEqual({ id: 'demo' });
  expect(mocks.ensureSepoliaNetwork).not.toHaveBeenCalled();
  expect(mocks.createWalletClient).not.toHaveBeenCalled();
});
