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
  const { rerender } = render(
    <MissionDrawer session={session} dispatch={dispatch} currentRoute={{ page: 'payment-inbox' }} currentRole="delegate" onNavigate={navigate} onRefresh={refresh} onClose={vi.fn()} />,
  );
  expect(screen.getByText(/Waiting for the executed request evidence/i)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /check chain state/i }));
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: /continue/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /skip/i })).not.toBeInTheDocument();

  const paused = { ...session, tour: { ...session.tour, paused: true as const, pauseReason: 'navigation' as const } };
  rerender(<MissionDrawer session={paused} dispatch={dispatch} currentRoute={{ page: 'funds' }} currentRole="delegate" onNavigate={navigate} onRefresh={refresh} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: /return to current mission/i }));
  expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'RETURN_TO_MISSION', runId: 'launch-test' }));
  expect(navigate).toHaveBeenCalledWith({ route: { page: 'payment-inbox' }, role: undefined });
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
