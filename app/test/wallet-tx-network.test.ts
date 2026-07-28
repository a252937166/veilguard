import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensureAccountOnSepolia: vi.fn(),
  estimateContractGas: vi.fn(),
  writeContract: vi.fn(),
}));

vi.mock('../src/nox', () => ({
  ensureAccountOnSepolia: mocks.ensureAccountOnSepolia,
  publicClient: {
    estimateContractGas: mocks.estimateContractGas,
  },
  makeWalletClient: () => ({
    account: { address: '0x1111111111111111111111111111111111111111' },
    chain: { id: 11155111 },
    writeContract: mocks.writeContract,
  }),
}));

import { walletWrite } from '../src/walletTx';

const account = '0x1111111111111111111111111111111111111111' as const;
const contract = '0x2222222222222222222222222222222222222222' as const;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ensureAccountOnSepolia.mockResolvedValue(11155111);
  mocks.estimateContractGas.mockResolvedValue(100_000n);
  mocks.writeContract.mockResolvedValue(`0x${'a'.repeat(64)}`);
});

test('network failure blocks gas estimation, wallet opening and recovery markers', async () => {
  const onRequestStarted = vi.fn();
  mocks.ensureAccountOnSepolia.mockRejectedValue(new Error('switch to Sepolia first'));

  await expect(walletWrite({
    account,
    address: contract,
    abi: [],
    functionName: 'write',
    args: [],
    onRequestStarted,
  })).rejects.toThrow('switch to Sepolia first');

  expect(mocks.ensureAccountOnSepolia).toHaveBeenCalledWith(account);
  expect(mocks.estimateContractGas).not.toHaveBeenCalled();
  expect(onRequestStarted).not.toHaveBeenCalled();
  expect(mocks.writeContract).not.toHaveBeenCalled();
});

test('opens the wallet only after the live account passes the Sepolia guard', async () => {
  const onRequestStarted = vi.fn();

  await expect(walletWrite({
    account,
    address: contract,
    abi: [],
    functionName: 'write',
    args: [],
    onRequestStarted,
  })).resolves.toBe(`0x${'a'.repeat(64)}`);

  expect(mocks.ensureAccountOnSepolia).toHaveBeenCalledWith(account);
  expect(mocks.estimateContractGas).toHaveBeenCalledTimes(1);
  expect(onRequestStarted).toHaveBeenCalledTimes(1);
  expect(mocks.writeContract).toHaveBeenCalledTimes(1);
  expect(mocks.ensureAccountOnSepolia.mock.invocationCallOrder[0])
    .toBeLessThan(mocks.estimateContractGas.mock.invocationCallOrder[0]);
  expect(mocks.estimateContractGas.mock.invocationCallOrder[0])
    .toBeLessThan(onRequestStarted.mock.invocationCallOrder[0]);
});
