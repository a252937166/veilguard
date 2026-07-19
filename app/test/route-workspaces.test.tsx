// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import { createDemoSession, isMissionComplete, loadDemoSession, saveDemoSession } from '../src/demo-session';
import { demoMemoHash } from '../src/demo-scenarios';

const appContext = vi.hoisted(() => ({ current: {} as any }));

vi.mock('../src/App', () => ({ useApp: () => appContext.current }));
vi.mock('../src/txlog', () => ({ fetchRequestTxs: () => Promise.resolve(new Map()) }));

import { PoliciesView } from '../src/views/PoliciesView';
import { SignerView } from '../src/views/SignerView';

const delegate = '0x1111111111111111111111111111111111111111';
const shieldOps = '0xe32148e45c3b1f8a692bec3baa0079ad103a4c6b';
const handle = `0x${'1'.repeat(64)}`;

const mandates = [1n, 2n].map((id) => ({
  id,
  delegate,
  validFrom: 1_700_000_000n,
  validUntil: 1_900_000_000n,
  version: Number(id),
  state: 2,
  autoLimit: handle,
  budgetLeft: handle,
  reserveFloor: handle,
  recipients: [shieldOps],
}));

const requests = [10n, 11n].map((id) => ({
  id,
  mandateId: 1n,
  delegate,
  recipient: shieldOps,
  memoHash: handle,
  createdAt: BigInt(Math.floor(Date.now() / 1000) - Number(id)),
  state: 3,
  amount: handle,
  decision: handle,
  blockedReason: handle,
}));

function setAppContext() {
  appContext.current = {
    account: undefined,
    owners: [],
    mandates,
    requests,
    paused: false,
    run: vi.fn(),
    busy: null,
    refresh: vi.fn(),
    toast: vi.fn(),
    demoRole: null,
  };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

test('policy selection follows route history and the list route has no implicit selection', async () => {
  setAppContext();
  const router = createMemoryRouter([{ path: '*', element: <PoliciesView /> }], {
    initialEntries: ['/policies/1'],
  });
  render(<RouterProvider router={router} />);

  expect(document.querySelector('.policy-workbench')).toHaveClass('workbench-route-detail');
  expect(screen.getByRole('heading', { name: 'Mandate #1' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Mandate #2 · v2/i }));
  await waitFor(() => expect(router.state.location.pathname).toBe('/policies/2'));
  expect(screen.getByRole('heading', { name: 'Mandate #2' })).toBeInTheDocument();

  await act(async () => { await router.navigate(-1); });
  expect(screen.getByRole('heading', { name: 'Mandate #1' })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Policy objects' }));
  await waitFor(() => expect(router.state.location.pathname).toBe('/policies'));
  expect(document.querySelector('.policy-workbench')).toHaveClass('workbench-route-list');
  expect(screen.getByRole('status')).toHaveTextContent('Choose an on-chain mandate');
  expect(screen.getByRole('button', { name: 'Open latest mandate' })).toBeInTheDocument();
  expect(document.querySelector('.object-list-item[aria-current="page"]')).toBeNull();
});

test('approval selection follows route history and Back returns to the queue route', async () => {
  setAppContext();
  const router = createMemoryRouter([{ path: '*', element: <SignerView /> }], {
    initialEntries: ['/approvals/10'],
  });
  render(<RouterProvider router={router} />);

  expect(document.querySelector('.approval-workbench')).toHaveClass('workbench-route-detail');
  expect(within(screen.getByRole('article')).getByText('Request #10')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Request #11/i }));
  await waitFor(() => expect(router.state.location.pathname).toBe('/approvals/11'));
  expect(within(screen.getByRole('article')).getByText('Request #11')).toBeInTheDocument();

  await act(async () => { await router.navigate(-1); });
  expect(within(screen.getByRole('article')).getByText('Request #10')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Pending approvals' }));
  await waitFor(() => expect(router.state.location.pathname).toBe('/approvals'));
  expect(document.querySelector('.approval-workbench')).toHaveClass('workbench-route-list');
  expect(within(screen.getByRole('article')).getByRole('status')).toHaveTextContent('Select a request');
  expect(document.querySelector('.object-list-item[aria-current="page"]')).toBeNull();
});

test('demo approval workspace contains only the current run-bound ShieldOps request', () => {
  const runId = 'launch-current-run';
  saveDemoSession(createDemoSession({ runId }));
  const current = {
    ...requests[0],
    memoHash: demoMemoHash(runId, 'approval', requests[0].mandateId, requests[0].delegate),
  };
  const previousRun = {
    ...requests[1],
    memoHash: demoMemoHash('launch-previous-run', 'approval', requests[1].mandateId, requests[1].delegate),
  };
  setAppContext();
  appContext.current.demoRole = 'delegate';
  appContext.current.requests = [previousRun, current];

  const router = createMemoryRouter([{ path: '*', element: <SignerView /> }], {
    initialEntries: ['/approvals'],
  });
  render(<RouterProvider router={router} />);

  expect(screen.getByRole('button', { name: /Request #10/i })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Request #11/i })).not.toBeInTheDocument();
  expect(screen.getByText('1 awaiting decision')).toBeInTheDocument();
});

test('demo signer labels a cancellation as user Reject only after server attestation', async () => {
  const runId = 'launch-attested-run';
  saveDemoSession(createDemoSession({ runId }));
  const cancelled = {
    ...requests[0],
    state: 5,
    memoHash: demoMemoHash(runId, 'approval', requests[0].mandateId, requests[0].delegate),
  };
  setAppContext();
  appContext.current.demoRole = 'delegate';
  appContext.current.requests = [cancelled];
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    ok: true,
    requestId: 10,
    chainState: 5,
    origin: 'user',
    action: 'reject',
    hash: `0x${'9'.repeat(64)}`,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

  const router = createMemoryRouter([{ path: '*', element: <SignerView /> }], {
    initialEntries: ['/approvals/10'],
  });
  render(<RouterProvider router={router} />);

  expect(await screen.findByText('USER REJECTED · REFUNDED')).toBeInTheDocument();
  expect(screen.getByText(/User selected Reject · authenticated by the run-bound server receipt/i)).toBeInTheDocument();
  expect(fetch).toHaveBeenCalledWith('/api/demo-decision?runId=launch-attested-run&requestId=10', expect.objectContaining({ method: 'GET' }));
  await waitFor(() => expect(loadDemoSession()?.missions.approval).toEqual(expect.objectContaining({
    requestId: '10',
    decision: 'reject',
    decisionConfirmed: true,
    outcome: 'safe-rejected',
  })));
});

test('demo signer restores an approved mission only from a matching user attestation', async () => {
  const runId = 'launch-approved-run';
  saveDemoSession(createDemoSession({ runId }));
  const approved = {
    ...requests[0],
    state: 2,
    memoHash: demoMemoHash(runId, 'approval', requests[0].mandateId, requests[0].delegate),
  };
  setAppContext();
  appContext.current.demoRole = 'delegate';
  appContext.current.requests = [approved];
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    ok: true,
    requestId: 10,
    chainState: 2,
    origin: 'user',
    action: 'approve',
    hash: `0x${'8'.repeat(64)}`,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

  const router = createMemoryRouter([{ path: '*', element: <SignerView /> }], {
    initialEntries: ['/approvals/10'],
  });
  render(<RouterProvider router={router} />);

  await waitFor(() => {
    const session = loadDemoSession();
    expect(session?.missions.approval).toEqual(expect.objectContaining({
      requestId: '10',
      decision: 'approve',
      decisionConfirmed: true,
      decisionTx: `0x${'8'.repeat(64)}`,
      outcome: 'safe-approved',
    }));
    expect(isMissionComplete(session!, 'approval', { strict: true })).toBe(true);
  });
});

test('timeout attestation never restores a user decision', async () => {
  const runId = 'launch-timeout-run';
  saveDemoSession(createDemoSession({ runId }));
  const timedOut = {
    ...requests[0],
    state: 5,
    memoHash: demoMemoHash(runId, 'approval', requests[0].mandateId, requests[0].delegate),
  };
  setAppContext();
  appContext.current.demoRole = 'delegate';
  appContext.current.requests = [timedOut];
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    ok: true,
    requestId: 10,
    chainState: 5,
    origin: 'timeout',
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

  const router = createMemoryRouter([{ path: '*', element: <SignerView /> }], {
    initialEntries: ['/approvals/10'],
  });
  render(<RouterProvider router={router} />);

  expect(await screen.findByText(/Decision window timeout · no user Reject/i)).toBeInTheDocument();
  const session = loadDemoSession()!;
  expect(session.missions.approval.decisionConfirmed).not.toBe(true);
  expect(isMissionComplete(session, 'approval', { strict: true })).toBe(false);
});
