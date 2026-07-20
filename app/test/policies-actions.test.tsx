// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROLES } from '../src/config';

const appContext = vi.hoisted(() => ({ current: {} as any }));
vi.mock('../src/App', () => ({ useApp: () => appContext.current }));

import { PoliciesView, formatMandateStart } from '../src/views/PoliciesView';

const owner = '0x1111111111111111111111111111111111111111' as const;
const liveFinanceAdmin = '0x4444444444444444444444444444444444444444' as const;
const handle = `0x${'1'.repeat(64)}` as const;
const mandate = {
  id: 7n,
  delegate: '0x2222222222222222222222222222222222222222' as const,
  validFrom: 1_700_000_000n,
  validUntil: 1_900_000_000n,
  version: 7,
  state: 2,
  autoLimit: handle,
  budgetLeft: handle,
  reserveFloor: handle,
  recipients: ['0x3333333333333333333333333333333333333333' as const],
};

function renderPolicies(
  account?: `0x${string}`,
  owners: `0x${string}`[] = [],
  options: { mandates?: Array<typeof mandate>; requests?: any[]; route?: string; financeAdmin?: `0x${string}` } = {},
) {
  appContext.current = {
    account,
    financeAdmin: options.financeAdmin ?? liveFinanceAdmin,
    owners,
    mandates: options.mandates ?? [mandate],
    requests: options.requests ?? [],
    paused: false,
    run: vi.fn(),
    busy: null,
    refresh: vi.fn(),
    toast: vi.fn(),
  };
  const router = createMemoryRouter([{ path: '*', element: <PoliciesView /> }], { initialEntries: [options.route ?? '/policies/7'] });
  render(<RouterProvider router={router} />);
  fireEvent.click(screen.getByRole('tab', { name: /Governance/i }));
}

afterEach(cleanup);

describe('Policies action authority', () => {
  it('keeps observers read-only while explaining the required authority', () => {
    renderPolicies();
    expect(screen.getByRole('button', { name: 'New confidential mandate' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Propose new version' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Retire 2-of-2' })).toBeDisabled();
    expect(screen.getByText(/Connect the authorised wallet/i)).toBeInTheDocument();
  });

  it('gives Finance Admin proposal and emergency-tightening controls only', () => {
    renderPolicies(liveFinanceAdmin);
    expect(screen.getByRole('button', { name: 'New confidential mandate' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Propose new version' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Pause module' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Retire 2-of-2' })).toBeDisabled();
  });

  it('gives a current Safe owner threshold retirement but not Finance Admin actions', () => {
    renderPolicies(owner, [owner]);
    expect(screen.getByRole('button', { name: 'New confidential mandate' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Pause module' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Retire 2-of-2' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Managed through Safe operations' })).toBeDisabled();
  });

  it('uses the live on-chain Finance Admin instead of stale deployment metadata', () => {
    renderPolicies(ROLES.financeAdmin);
    expect(screen.getByRole('button', { name: 'New confidential mandate' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Pause module' })).toBeDisabled();
  });

  it('blocks activating a replacement while the active mandate still owns an in-flight request', () => {
    const draft = { ...mandate, id: 8n, version: 8, state: 1 };
    renderPolicies(owner, [owner], {
      mandates: [mandate, draft],
      requests: [{
        id: 41n,
        mandateId: mandate.id,
        delegate: mandate.delegate,
        recipient: mandate.recipients[0],
        memoHash: handle,
        createdAt: 1n,
        state: 3,
        amount: handle,
        decision: handle,
        blockedReason: handle,
      }],
      route: '/policies/8',
    });

    expect(screen.getByRole('button', { name: 'Activate 2-of-2' })).toBeDisabled();
    expect(screen.getByText(/active mandate's in-flight request.*Request #41 is still AwaitingSafeApproval/i)).toBeInTheDocument();
  });

  it('describes a zero start timestamp as immediate activation', () => {
    expect(formatMandateStart(0n)).toBe('Immediately on activation');
  });
});
