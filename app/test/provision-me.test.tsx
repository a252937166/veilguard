// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  app: { current: {} as any },
  availability: vi.fn(),
  provision: vi.fn(),
}));

vi.mock('../src/App', () => ({ useApp: () => mocks.app.current }));
vi.mock('../src/provisioning', () => ({
  fetchProvisionAvailability: mocks.availability,
  provisionConnectedWallet: mocks.provision,
}));

import { ProvisionMe } from '../src/components/ProvisionMe';

const account = '0x1111111111111111111111111111111111111111' as const;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('keeps self-service disabled on missing/degraded health and routes to the shared demo', async () => {
  const startDemo = vi.fn();
  mocks.app.current = {
    refresh: vi.fn(),
    toast: vi.fn(),
    startDemo,
  };
  mocks.availability.mockResolvedValue({
    operational: false,
    detail: 'Self-service onboarding is closed; use the pre-funded shared demo delegate',
  });

  render(<ProvisionMe account={account} />);

  expect(await screen.findByText(/pre-funded shared demo delegate/i)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /provision my wallet/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /self-service onboarding/i })).not.toBeInTheDocument();
  expect(mocks.provision).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'Use the shared demo delegate' }));
  expect(startDemo).toHaveBeenCalledWith('delegate');
});
