// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  app: { current: {} as any },
  readContract: vi.fn(async () => 0n),
}));

vi.mock('../src/App', () => ({ useApp: () => mocks.app.current }));
vi.mock('../src/nox', () => ({
  publicClient: {
    readContract: mocks.readContract,
    waitForTransactionReceipt: vi.fn(),
  },
}));
vi.mock('../src/walletTx', () => ({ walletWrite: vi.fn() }));

import { FaucetView } from '../src/views/FaucetView';

const account = '0x1111111111111111111111111111111111111111' as const;

afterEach(() => {
  cleanup();
  mocks.readContract.mockClear();
});

test('faucet writes stay disabled off Sepolia and re-enable on Sepolia', () => {
  mocks.app.current = {
    account,
    run: vi.fn(),
    busy: null,
    toast: vi.fn(),
    demoRole: undefined,
    chainOk: false,
  };

  const view = render(<FaucetView />);
  const claim = screen.getByRole('button', { name: 'Claim TestUSDC' });
  const wrap = screen.getByRole('button', { name: /Wrap 1000.*Safe treasury/ });

  expect(claim).toBeDisabled();
  expect(wrap).toBeDisabled();
  expect(screen.getByText(/Switch the connected wallet to Ethereum Sepolia first/i)).toBeInTheDocument();

  mocks.app.current = { ...mocks.app.current, chainOk: true };
  view.rerender(<FaucetView />);

  expect(claim).toBeEnabled();
  expect(wrap).toBeEnabled();
});
