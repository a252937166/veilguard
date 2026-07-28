import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensureAccountOnSepolia: vi.fn(),
  readContract: vi.fn(),
}));

vi.mock('../src/nox', () => ({
  ensureAccountOnSepolia: mocks.ensureAccountOnSepolia,
  publicClient: { readContract: mocks.readContract },
}));

import { governance2of2 } from '../src/safe-browser';

const owner = '0x1111111111111111111111111111111111111111' as const;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ensureAccountOnSepolia.mockResolvedValue(11155111);
});

afterEach(() => vi.unstubAllGlobals());

test('wrong wallet network blocks Safe nonce reads, typed-data signatures and API execution', async () => {
  const signTypedData = vi.fn();
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  mocks.ensureAccountOnSepolia.mockRejectedValueOnce(new Error('switch to Sepolia first'));

  await expect(governance2of2({
    account: { address: owner },
    signTypedData,
  } as any, 'activateMandate', [1n])).rejects.toThrow('switch to Sepolia first');

  expect(mocks.ensureAccountOnSepolia).toHaveBeenCalledWith(owner);
  expect(mocks.readContract).not.toHaveBeenCalled();
  expect(signTypedData).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
});
