// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { MissionDrawer } from '../src/GuidedTour';
import { createDemoSession, demoSessionReducer } from '../src/demo-session';
import type { SpendRequest } from '../src/App';

const request = (id: bigint, state: number): SpendRequest => ({
  id,
  mandateId: 9n,
  delegate: `0x${'1'.repeat(40)}`,
  recipient: `0x${'2'.repeat(40)}`,
  memoHash: `0x${'3'.repeat(64)}`,
  createdAt: 1n,
  state,
  amount: `0x${'4'.repeat(64)}`,
  decision: `0x${'5'.repeat(64)}`,
  blockedReason: `0x${'6'.repeat(64)}`,
});

function bindRoutineRequest(runId: string) {
  let session = createDemoSession({ runId, now: 1, tourActive: true });
  session = demoSessionReducer(session, {
    type: 'BIND_REQUEST', runId: session.runId, mission: 'routine', requestId: '41', at: 2,
  });
  session = demoSessionReducer(session, {
    type: 'TOUR_STEP', runId: session.runId, step: 1,
    route: { page: 'payment-detail', requestId: '41' }, role: 'delegate', at: 3,
  });
  return session;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test('completed evidence waits for an explicit Continue action', () => {
  vi.useFakeTimers();
  let session = createDemoSession({ runId: 'explicit-continue', now: 1, tourActive: true });
  session = demoSessionReducer(session, {
    type: 'ROUTINE_EXECUTED', runId: session.runId, requestId: '11', at: 2,
  });
  session = demoSessionReducer(session, {
    type: 'TOUR_STEP', runId: session.runId, step: 1,
    route: { page: 'payment-inbox' }, role: 'delegate', at: 3,
  });
  const dispatch = vi.fn();

  render(<MissionDrawer
    session={session}
    dispatch={dispatch}
    currentRoute={{ page: 'payment-inbox' }}
    currentRole="delegate"
    requests={[request(11n, 1)]}
    onNavigate={vi.fn()}
    onRefresh={vi.fn().mockResolvedValue({ status: 'unchanged', checkedAt: 1, changedRequestIds: [] })}
    onGuide={vi.fn()}
    onClose={vi.fn()}
  />);

  act(() => { vi.advanceTimersByTime(2_000); });
  expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'TOUR_STEP', step: 2 }));
  expect(screen.getAllByRole('button', { name: /continue/i }).length).toBeGreaterThan(0);
  fireEvent.click(screen.getAllByRole('button', { name: /continue/i })[0]);
  expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'TOUR_STEP', step: 2 }));
});

test('a page-level step advance in transit does not pause the tour', () => {
  let session = createDemoSession({ runId: 'transit-advance', now: 1, tourActive: true });
  session = demoSessionReducer(session, {
    type: 'TOUR_STEP', runId: session.runId, step: 3,
    route: { page: 'payment-inbox' }, role: 'delegate', at: 2,
  });
  const dispatch = vi.fn();
  const shared = {
    dispatch,
    currentRole: 'delegate' as const,
    requests: [] as SpendRequest[],
    onNavigate: vi.fn(),
    onRefresh: vi.fn().mockResolvedValue({ status: 'unchanged' as const, checkedAt: 1, changedRequestIds: [] }),
    onGuide: vi.fn(),
    onClose: vi.fn(),
  };
  const { rerender } = render(
    <MissionDrawer session={session} currentRoute={{ page: 'payment-inbox' }} {...shared} />,
  );

  // A mission CTA commits the next step via advanceGuidedMission; the router
  // transition has not landed yet, so the drawer still observes the previous
  // payment route for a frame. That frame is travel, not leaving the tour.
  const advanced = demoSessionReducer(session, {
    type: 'TOUR_STEP', runId: session.runId, step: 4,
    route: { page: 'disclosure-builder' }, role: 'delegate', at: 3,
  });
  rerender(<MissionDrawer session={advanced} currentRoute={{ page: 'payment-inbox' }} {...shared} />);
  expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'PAUSE_TOUR' }));

  // Once the transition lands, leaving the surface WITHOUT a step change must
  // still pause the run.
  rerender(<MissionDrawer session={advanced} currentRoute={{ page: 'disclosure-builder' }} {...shared} />);
  rerender(<MissionDrawer session={advanced} currentRoute={{ page: 'policies' }} {...shared} />);
  expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'PAUSE_TOUR', reason: 'navigation' }));
});

test('action step exposes an accessible compact-rail disclosure control', () => {
  let session = createDemoSession({ runId: 'compact-rail', now: 1, tourActive: true });
  session = demoSessionReducer(session, {
    type: 'TOUR_STEP', runId: session.runId, step: 2,
    route: { page: 'payment-inbox' }, role: 'delegate', at: 2,
  });

  render(<MissionDrawer
    session={session}
    dispatch={vi.fn()}
    currentRoute={{ page: 'payment-inbox' }}
    currentRole="delegate"
    requests={[]}
    onNavigate={vi.fn()}
    onRefresh={vi.fn().mockResolvedValue({ status: 'unchanged', checkedAt: 1, changedRequestIds: [] })}
    onGuide={vi.fn()}
    onClose={vi.fn()}
  />);

  const drawer = screen.getByRole('complementary', { name: /launch day demo mission/i });
  expect(drawer).not.toHaveClass('is-action-compact');
  expect(drawer).toHaveClass('is-decision-step');
  const prepare = screen.getByRole('button', { name: /open shieldops invoice/i });
  const back = screen.getByRole('button', { name: /back/i });
  expect(prepare.compareDocumentPosition(back) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const collapse = screen.getByRole('button', { name: 'Collapse' });
  expect(collapse).toHaveAttribute('aria-expanded', 'true');
  fireEvent.click(collapse);
  expect(drawer).toHaveClass('is-action-compact', 'is-decision-step');
  const expand = screen.getByRole('button', { name: /expand mission details/i });
  expect(expand).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(expand);
  expect(drawer).not.toHaveClass('is-action-compact');
  expect(screen.getByRole('button', { name: 'Collapse' })).toHaveAttribute('aria-expanded', 'true');
});

test('a located action collapses the drawer while keeping an expandable mission rail', async () => {
  let session = createDemoSession({ runId: 'located-rail', now: 1, tourActive: true });
  session = demoSessionReducer(session, {
    type: 'TOUR_STEP', runId: session.runId, step: 1,
    route: { page: 'payment-inbox' }, role: 'delegate', at: 2,
  });

  render(<MissionDrawer
    session={session}
    dispatch={vi.fn()}
    currentRoute={{ page: 'payment-inbox' }}
    currentRole="delegate"
    requests={[]}
    onNavigate={vi.fn()}
    onRefresh={vi.fn().mockResolvedValue({ status: 'unchanged', checkedAt: 1, changedRequestIds: [] })}
    onGuide={vi.fn()}
    guideStatus="found"
    onClose={vi.fn()}
  />);

  const drawer = screen.getByRole('complementary', { name: /launch day demo mission/i });
  await waitFor(() => expect(drawer).toHaveClass('is-action-compact'));
  expect(screen.getByText(/submit the cloudnode payment/i)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /expand mission details/i }));
  expect(drawer).not.toHaveClass('is-action-compact');
});

test.each([
  [{ status: 'changed' as const, checkedAt: 1_700_000_000_000, changedRequestIds: ['11'] }, /new on-chain evidence found.*#11/i],
  [{ status: 'unchanged' as const, checkedAt: 1_700_000_000_000, changedRequestIds: [] }, /no new evidence yet/i],
  [{ status: 'failed' as const, checkedAt: 1_700_000_000_000, message: 'RPC unavailable', changedRequestIds: [] as [] }, /chain check failed: rpc unavailable/i],
])('chain refresh reports $status after the actual promise resolves', async (refreshResult, expected) => {
  const session = bindRoutineRequest(`refresh-${refreshResult.status}`);
  const onRefresh = vi.fn().mockResolvedValue(refreshResult);
  render(<MissionDrawer
    session={session}
    dispatch={vi.fn()}
    currentRoute={{ page: 'payment-detail', requestId: '41' }}
    currentRole="delegate"
    requests={[request(41n, 1)]}
    onNavigate={vi.fn()}
    onRefresh={onRefresh}
    onGuide={vi.fn()}
    onClose={vi.fn()}
  />);

  fireEvent.click(screen.getByRole('button', { name: /check chain state/i }));
  expect(onRefresh).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(screen.getByText(expected)).toBeInTheDocument());
  expect(screen.queryByText(/checking chain/i)).not.toBeInTheDocument();
  if (refreshResult.status === 'failed') expect(screen.getByRole('button', { name: /retry chain check/i })).toBeInTheDocument();
});

test('chain-check spinner remains bound to the in-flight refresh promise', async () => {
  const session = bindRoutineRequest('refresh-pending');
  let resolveRefresh!: (value: { status: 'unchanged'; checkedAt: number; changedRequestIds: string[] }) => void;
  const onRefresh = vi.fn(() => new Promise<{ status: 'unchanged'; checkedAt: number; changedRequestIds: string[] }>((resolve) => {
    resolveRefresh = resolve;
  }));
  render(<MissionDrawer
    session={session}
    dispatch={vi.fn()}
    currentRoute={{ page: 'payment-detail', requestId: '41' }}
    currentRole="delegate"
    requests={[request(41n, 1)]}
    onNavigate={vi.fn()}
    onRefresh={onRefresh}
    onGuide={vi.fn()}
    onClose={vi.fn()}
  />);

  fireEvent.click(screen.getByRole('button', { name: /check chain state/i }));
  expect(screen.getByRole('button', { name: /checking chain/i })).toBeDisabled();
  await act(async () => resolveRefresh({ status: 'unchanged', checkedAt: 1_700_000_000_000, changedRequestIds: [] }));
  await waitFor(() => expect(screen.getByText(/no new evidence yet/i)).toBeInTheDocument());
});
