// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { MissionDrawer } from '../src/GuidedTour';
import { createDemoSession, demoSessionReducer } from '../src/demo-session';

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
    onNavigate={vi.fn()}
    onRefresh={vi.fn().mockResolvedValue({ status: 'unchanged', checkedAt: 1, changedRequestIds: [] })}
    onClose={vi.fn()}
  />);

  act(() => { vi.advanceTimersByTime(2_000); });
  expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'TOUR_STEP', step: 2 }));
  expect(screen.getAllByRole('button', { name: /continue/i }).length).toBeGreaterThan(0);
  fireEvent.click(screen.getAllByRole('button', { name: /continue/i })[0]);
  expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'TOUR_STEP', step: 2 }));
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
    onNavigate={vi.fn()}
    onRefresh={vi.fn().mockResolvedValue({ status: 'unchanged', checkedAt: 1, changedRequestIds: [] })}
    onClose={vi.fn()}
  />);

  const drawer = screen.getByRole('complementary', { name: /launch day demo mission/i });
  expect(drawer).toHaveClass('is-action-compact', 'is-decision-step');
  const expand = screen.getByRole('button', { name: /expand mission details/i });
  expect(expand).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(expand);
  expect(drawer).not.toHaveClass('is-action-compact');
  expect(screen.getByRole('button', { name: 'Collapse' })).toHaveAttribute('aria-expanded', 'true');
});

test.each([
  [{ status: 'changed' as const, checkedAt: 1_700_000_000_000, changedRequestIds: ['11'] }, /new on-chain evidence found.*#11/i],
  [{ status: 'unchanged' as const, checkedAt: 1_700_000_000_000, changedRequestIds: [] }, /no new evidence yet/i],
  [{ status: 'failed' as const, checkedAt: 1_700_000_000_000, message: 'RPC unavailable', changedRequestIds: [] as [] }, /chain check failed: rpc unavailable/i],
])('chain refresh reports $status after the actual promise resolves', async (refreshResult, expected) => {
  const session = createDemoSession({ runId: `refresh-${refreshResult.status}`, now: 1, tourActive: true });
  const onRefresh = vi.fn().mockResolvedValue(refreshResult);
  render(<MissionDrawer
    session={{ ...session, tour: { ...session.tour, step: 1 } }}
    dispatch={vi.fn()}
    currentRoute={{ page: 'payment-inbox' }}
    currentRole="delegate"
    onNavigate={vi.fn()}
    onRefresh={onRefresh}
    onClose={vi.fn()}
  />);

  fireEvent.click(screen.getByRole('button', { name: /check chain state/i }));
  expect(onRefresh).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(screen.getByText(expected)).toBeInTheDocument());
  expect(screen.queryByText(/checking chain/i)).not.toBeInTheDocument();
  if (refreshResult.status === 'failed') expect(screen.getByRole('button', { name: /retry chain check/i })).toBeInTheDocument();
});

test('chain-check spinner remains bound to the in-flight refresh promise', async () => {
  const session = createDemoSession({ runId: 'refresh-pending', now: 1, tourActive: true });
  let resolveRefresh!: (value: { status: 'unchanged'; checkedAt: number; changedRequestIds: string[] }) => void;
  const onRefresh = vi.fn(() => new Promise<{ status: 'unchanged'; checkedAt: number; changedRequestIds: string[] }>((resolve) => {
    resolveRefresh = resolve;
  }));
  render(<MissionDrawer
    session={{ ...session, tour: { ...session.tour, step: 1 } }}
    dispatch={vi.fn()}
    currentRoute={{ page: 'payment-inbox' }}
    currentRole="delegate"
    onNavigate={vi.fn()}
    onRefresh={onRefresh}
    onClose={vi.fn()}
  />);

  fireEvent.click(screen.getByRole('button', { name: /check chain state/i }));
  expect(screen.getByRole('button', { name: /checking chain/i })).toBeDisabled();
  await act(async () => resolveRefresh({ status: 'unchanged', checkedAt: 1_700_000_000_000, changedRequestIds: [] }));
  await waitFor(() => expect(screen.getByText(/no new evidence yet/i)).toBeInTheDocument());
});
