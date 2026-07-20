// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import { createDemoSession, demoSessionReducer, saveDemoSession } from '../src/demo-session';
import { DEMO_RECIPIENTS, demoMemoHash } from '../src/demo-scenarios';
import { VIOLATION_DELEGATE } from '../src/demo';

const mocks = vi.hoisted(() => ({
  app: { current: {} as any },
  walletWrite: vi.fn(),
  readContract: vi.fn(async () => 0n),
}));

vi.mock('../src/App', () => ({ useApp: () => mocks.app.current }));
vi.mock('../src/walletTx', () => ({ walletWrite: mocks.walletWrite }));
vi.mock('../src/txlog', () => ({ fetchRequestTxs: () => Promise.resolve(new Map()) }));
vi.mock('../src/nox', () => ({
  publicClient: {
    readContract: mocks.readContract,
    waitForTransactionReceipt: vi.fn(),
  },
  handleClientFor: vi.fn(),
}));

import { DelegateView } from '../src/views/DelegateView';

const delegate = '0x17ee5ad7e4b40cadafad27c5f68f74d02c7fd532' as const;
const handle = `0x${'1'.repeat(64)}` as const;

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  mocks.walletWrite.mockReset();
  mocks.readContract.mockClear();
});

test('completed invoice CTA opens its frozen request with zero wallet writes', async () => {
  const runId = 'launch-completed-cta';
  let session = createDemoSession({ runId, route: { page: 'payment-inbox' } });
  session = demoSessionReducer(session, {
    type: 'ROUTINE_EXECUTED', runId, requestId: '35', at: 2,
  });
  saveDemoSession(session);

  const requestDemoRestart = vi.fn();
  mocks.app.current = {
    account: delegate,
    mandates: [{
      id: 9n,
      delegate,
      validFrom: 1_700_000_000n,
      validUntil: 1_900_000_000n,
      version: 4,
      state: 2,
      autoLimit: handle,
      budgetLeft: handle,
      reserveFloor: handle,
      recipients: [DEMO_RECIPIENTS.cloudNode, DEMO_RECIPIENTS.shieldOps],
    }],
    requests: [{
      id: 35n,
      mandateId: 9n,
      delegate,
      recipient: DEMO_RECIPIENTS.cloudNode,
      memoHash: demoMemoHash(runId, 'routine', 9n, delegate),
      createdAt: 1_800_000_000n,
      state: 2,
      amount: handle,
      decision: handle,
      blockedReason: handle,
    }],
    run: vi.fn(),
    busy: null,
    refresh: vi.fn(async () => ({ status: 'unchanged', checkedAt: Date.now(), changedRequestIds: [] })),
    toast: vi.fn(),
    goTab: vi.fn(),
    startDemo: vi.fn(),
    requestDemoRestart,
    demoRole: 'delegate',
    lastUpdated: Date.now(),
    loadError: false,
  };

  const router = createMemoryRouter([{ path: '*', element: <DelegateView /> }], {
    initialEntries: ['/payments'],
  });
  render(<RouterProvider router={router} />);

  const open = await screen.findByRole('button', { name: 'Open completed request' });
  fireEvent.click(open);
  await waitFor(() => expect(router.state.location.pathname).toBe('/payments/35'));
  expect(mocks.walletWrite).not.toHaveBeenCalled();

  await router.navigate('/payments');
  fireEvent.click(await screen.findByRole('button', { name: 'Start a new demo run' }));
  expect(requestDemoRestart).toHaveBeenCalledTimes(1);
  expect(mocks.walletWrite).not.toHaveBeenCalled();
});

test('a run-bound broadcast pointer restores recovery instead of submitting again', async () => {
  const runId = 'launch-broadcast-recovery';
  const transactionHash = `0x${'a'.repeat(64)}` as const;
  saveDemoSession(createDemoSession({ runId, route: { page: 'payment-inbox' } }));
  sessionStorage.setItem('vg_track', JSON.stringify({
    mission: 'routine',
    amount: '25',
    tx: transactionHash,
    delegate,
    at: Date.now(),
    runId,
  }));
  mocks.app.current = {
    account: delegate,
    mandates: [{
      id: 9n,
      delegate,
      validFrom: 1_700_000_000n,
      validUntil: 1_900_000_000n,
      version: 4,
      state: 2,
      autoLimit: handle,
      budgetLeft: handle,
      reserveFloor: handle,
      recipients: [DEMO_RECIPIENTS.cloudNode, DEMO_RECIPIENTS.shieldOps],
    }],
    requests: [],
    run: vi.fn(),
    busy: null,
    refresh: vi.fn(async () => ({ status: 'unchanged', checkedAt: Date.now(), changedRequestIds: [] })),
    toast: vi.fn(),
    goTab: vi.fn(),
    startDemo: vi.fn(),
    requestDemoRestart: vi.fn(),
    demoRole: 'delegate',
    lastUpdated: Date.now(),
    loadError: false,
  };

  const router = createMemoryRouter([{ path: '*', element: <DelegateView /> }], {
    initialEntries: ['/payments'],
  });
  render(<RouterProvider router={router} />);

  expect(await screen.findByText(/recovering the broadcast request from sepolia/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /recovering request/i })).toBeDisabled();
  expect(mocks.walletWrite).not.toHaveBeenCalled();
  expect(mocks.app.current.run).not.toHaveBeenCalled();
});

test('guided Atlas preparation selects the complete preset and performs zero writes', async () => {
  const runId = 'launch-atlas-prepare';
  let session = createDemoSession({ runId, route: { page: 'payment-inbox' }, tourActive: true });
  session = demoSessionReducer(session, {
    type: 'ROUTINE_EXECUTED', runId, requestId: '35', at: 2,
  });
  session = demoSessionReducer(session, {
    type: 'APPROVAL_DECISION_CONFIRMED', runId, requestId: '36', decision: 'approve', at: 3,
  });
  session = demoSessionReducer(session, {
    type: 'APPROVAL_SETTLED', runId, requestId: '36', decision: 'approve', at: 4,
  });
  session = demoSessionReducer(session, {
    type: 'TOUR_STEP', runId, step: 3, route: { page: 'payment-inbox' },
    role: 'delegate', selected: { scenarioKey: 'violation' }, at: 5,
  });
  saveDemoSession(session);

  const run = vi.fn();
  mocks.app.current = {
    account: delegate,
    mandates: [{
      id: 9n,
      delegate,
      validFrom: 1_700_000_000n,
      validUntil: 1_900_000_000n,
      version: 4,
      state: 2,
      autoLimit: handle,
      budgetLeft: handle,
      reserveFloor: handle,
      recipients: [DEMO_RECIPIENTS.cloudNode, DEMO_RECIPIENTS.shieldOps],
    }, {
      id: 10n,
      delegate: VIOLATION_DELEGATE.address,
      validFrom: 1_700_000_000n,
      validUntil: 1_900_000_000n,
      version: 4,
      state: 2,
      autoLimit: handle,
      budgetLeft: handle,
      reserveFloor: handle,
      recipients: [DEMO_RECIPIENTS.atlas],
    }],
    requests: [],
    run,
    busy: null,
    refresh: vi.fn(async () => ({ status: 'unchanged', checkedAt: Date.now(), changedRequestIds: [] })),
    toast: vi.fn(),
    goTab: vi.fn(),
    startDemo: vi.fn(),
    requestDemoRestart: vi.fn(),
    demoRole: 'delegate',
    lastUpdated: Date.now(),
    loadError: false,
  };

  const router = createMemoryRouter([{ path: '*', element: <DelegateView guidedScenarioKey="violation" /> }], {
    initialEntries: ['/payments'],
  });
  render(<RouterProvider router={router} />);

  const atlasRow = await screen.findByRole('button', { name: /atlas contractor.*600 cusdc/i });
  await waitFor(() => expect(atlasRow).toHaveAttribute('aria-pressed', 'true'));
  expect(screen.getByRole('article', { name: /atlas contractor payment detail/i })).toHaveTextContent('600 cUSDC');
  expect(screen.getByRole('article', { name: /atlas contractor payment detail/i })).toHaveTextContent('New supplier invoice');
  const guidedSubmit = screen.getAllByRole('button', { name: 'Submit confidential payment' })
    .find((button) => button.getAttribute('data-guided-action') === 'mission-violation');
  expect(guidedSubmit).toBeDefined();
  expect(run).not.toHaveBeenCalled();
  expect(mocks.walletWrite).not.toHaveBeenCalled();

  // Browsing another invoice does not change the durable mission selection.
  // Pressing Launch again must still reapply the exact Atlas preset.
  fireEvent.click(screen.getByRole('button', { name: /shieldops.*60 cusdc/i }));
  await waitFor(() => expect(screen.getByRole('article', { name: /shieldops payment detail/i })).toBeInTheDocument());
  act(() => {
    window.dispatchEvent(new CustomEvent('vg-guided-prepare', {
      detail: {
        step: 3,
        role: 'delegate',
        targetId: 'mission-violation',
        selected: { scenarioKey: 'violation' },
      },
    }));
  });
  await waitFor(() => expect(screen.getByRole('article', { name: /atlas contractor payment detail/i })).toHaveTextContent('600 cUSDC'));
  expect(run).not.toHaveBeenCalled();
  expect(mocks.walletWrite).not.toHaveBeenCalled();
});
