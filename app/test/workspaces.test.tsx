// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { MissionDrawer } from '../src/GuidedTour';
import { createDemoSession, demoSessionReducer } from '../src/demo-session';
import { PrivacyLens } from '../src/components/PrivacyLens';
import { AuditChecklist } from '../src/views/AuditorView';

test('Mission Drawer gates a mission on real evidence and returns from a paused route', () => {
  let session = createDemoSession({ runId: 'launch-test', route: { page: 'payment-inbox' }, role: 'delegate', tourActive: true });
  session = demoSessionReducer(session, {
    type: 'TOUR_STEP', runId: session.runId, step: 1,
    route: { page: 'payment-inbox' }, role: 'delegate', at: 2,
  });
  const dispatch = vi.fn();
  const navigate = vi.fn();
  const refresh = vi.fn();
  const guide = vi.fn();
  const { rerender } = render(
    <MissionDrawer session={session} dispatch={dispatch} currentRoute={{ page: 'payment-inbox' }} currentRole="delegate" requests={[]} onNavigate={navigate} onRefresh={refresh} onGuide={guide} onClose={vi.fn()} />,
  );
  expect(screen.getByText(/Ready · your action is needed/i)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /check chain state/i })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /open cloudnode invoice/i }));
  expect(guide).toHaveBeenCalledWith(expect.objectContaining({
    step: 1,
    route: { page: 'payment-inbox' },
    selected: { scenarioKey: 'routine' },
    targetId: 'mission-routine',
  }));
  expect(navigate).toHaveBeenCalledWith({ route: { page: 'payment-inbox' }, role: 'delegate' });
  expect(refresh).not.toHaveBeenCalled();
  expect(screen.getByRole('complementary', { name: /launch day demo mission/i })).toHaveClass('is-action-compact');
  expect(screen.getByRole('button', { name: /expand mission details/i })).toHaveAttribute('aria-expanded', 'false');

  session = demoSessionReducer(session, {
    type: 'BIND_REQUEST', runId: session.runId, mission: 'routine', requestId: '41', at: 3,
  });
  const request = {
    id: 41n, mandateId: 9n, delegate: `0x${'1'.repeat(40)}` as const,
    recipient: `0x${'2'.repeat(40)}` as const, memoHash: `0x${'3'.repeat(64)}` as const,
    createdAt: 1n, state: 1, amount: `0x${'4'.repeat(64)}` as const,
    decision: `0x${'5'.repeat(64)}` as const, blockedReason: `0x${'6'.repeat(64)}` as const,
  };
  rerender(<MissionDrawer session={session} dispatch={dispatch} currentRoute={{ page: 'payment-inbox' }} currentRole="delegate" requests={[request]} onNavigate={navigate} onRefresh={refresh} onGuide={guide} onClose={vi.fn()} />);
  expect(screen.getByText(/Waiting for chain evidence/i)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /check chain state/i }));
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: /continue/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /skip/i })).not.toBeInTheDocument();

  const paused = { ...session, tour: { ...session.tour, paused: true as const, pauseReason: 'navigation' as const } };
  rerender(<MissionDrawer session={paused} dispatch={dispatch} currentRoute={{ page: 'funds' }} currentRole="delegate" requests={[request]} onNavigate={navigate} onRefresh={refresh} onGuide={guide} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: /return to current mission/i }));
  expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'RETURN_TO_MISSION', runId: 'launch-test' }));
  expect(navigate).toHaveBeenLastCalledWith({ route: { page: 'payment-detail', requestId: '41' }, role: 'delegate' });
});

test('Privacy Lens keeps authorised plaintext out of the public side', () => {
  render(
    <PrivacyLens
      authorized={[{ label: 'Amount', value: '600 cUSDC' }, { label: 'Reason', value: 'Budget exceeded' }]}
      publicView={[{ label: 'Amount', value: 'Encrypted handle' }, { label: 'Reason', value: 'Not disclosed' }]}
    />,
  );
  const publicSide = screen.getByRole('region', { name: 'What the public chain sees' });
  expect(publicSide).toHaveTextContent('Encrypted handle');
  expect(publicSide).toHaveTextContent('Not disclosed');
  expect(publicSide).not.toHaveTextContent('600 cUSDC');
  expect(publicSide).not.toHaveTextContent('Budget exceeded');
});

test('Audit checklist exposes every incomplete integrity gate', () => {
  render(<AuditChecklist checks={[
    { passed: true, title: 'Manifest binds the exact scope', detail: 'Recomputed match' },
    { passed: false, title: 'Every request has a disposition', detail: '2 reviewed · 1 pending' },
  ]} />);
  const checklist = screen.getByRole('list', { name: /audit packet integrity checklist/i });
  expect(checklist).toHaveTextContent('PASS');
  expect(checklist).toHaveTextContent('PENDING');
  expect(checklist).toHaveTextContent('1 pending');
});
