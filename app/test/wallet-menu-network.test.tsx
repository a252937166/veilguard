// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('../src/nox', () => ({
  publicClient: {
    getBalance: vi.fn(async () => 0n),
    readContract: vi.fn(async () => 0n),
  },
}));

import { WalletMenu } from '../src/WalletMenu';

const account = '0x1111111111111111111111111111111111111111' as const;

afterEach(cleanup);

test('wrong-network control exposes progress and blocks duplicate switch requests', () => {
  const onSwitchChain = vi.fn();
  const props = {
    account,
    roleChips: ['DELEGATE'],
    chainOk: false,
    wallet: { uuid: 'okx', name: 'OKX Wallet', icon: '⬛', provider: { request: vi.fn() } },
    onConnect: vi.fn(),
    onSwitchChain,
    onSwitchAccount: vi.fn(),
    onDisconnect: vi.fn(),
  };
  const { rerender } = render(<WalletMenu {...props} />);

  const ready = screen.getByRole('button', { name: /wrong network — switch to sepolia/i });
  expect(ready).toBeEnabled();
  fireEvent.click(ready);
  expect(onSwitchChain).toHaveBeenCalledTimes(1);

  rerender(<WalletMenu {...props} switchingChain />);
  const switching = screen.getByRole('button', { name: /switching to sepolia/i });
  expect(switching).toBeDisabled();
  expect(switching).toHaveAttribute('aria-busy', 'true');
  fireEvent.click(switching);
  expect(onSwitchChain).toHaveBeenCalledTimes(1);
});
