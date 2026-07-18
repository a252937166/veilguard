import { expect, test } from 'vitest';
import {
  DEMO_SESSION_KEY,
  createDemoSession,
  demoCompleted,
  demoSessionReducer,
  isMissionComplete,
  loadDemoSession,
  saveDemoSession,
} from '../src/demo-session.ts';

const reduce = (
  state: ReturnType<typeof createDemoSession>,
  action: Omit<Parameters<typeof demoSessionReducer>[1], 'runId'>,
) => demoSessionReducer(state, { ...action, runId: state.runId } as Parameters<typeof demoSessionReducer>[1]);

test('strict completion requires run-bound request and packet evidence', () => {
  let state = createDemoSession({ runId: 'run-a', now: 1 });
  state = reduce(state, { type: 'ROUTINE_EXECUTED', requestId: '11', at: 2 });
  state = reduce(state, { type: 'BIND_REQUEST', mission: 'approval', requestId: '12', at: 3 });
  state = reduce(state, { type: 'APPROVAL_DECISION_CONFIRMED', requestId: '12', decision: 'reject', transactionHash: '0xabc', at: 4 });
  state = reduce(state, { type: 'APPROVAL_SETTLED', requestId: '12', decision: 'reject', at: 5 });
  state = reduce(state, { type: 'VIOLATION_BLOCKED', requestId: '13', at: 4 });
  expect(demoCompleted(state), 'blocked outcome still needs private reason disclosure').toBe(false);
  state = reduce(state, { type: 'VIOLATION_REASON_DECRYPTED', requestId: '13', at: 5 });
  state = reduce(state, { type: 'AUDIT_PACKETS_CREATED', packetIds: ['8', '9'], requestIds: ['11', '12', '13'], at: 6 });
  state = reduce(state, { type: 'AUDIT_UNLOCKED', at: 7 });
  state = reduce(state, { type: 'AUDIT_REQUEST_DISPOSITION', requestId: '11', disposition: 'reviewed', at: 8 });
  state = reduce(state, { type: 'AUDIT_REQUEST_DISPOSITION', requestId: '12', disposition: 'flagged', at: 9 });
  state = reduce(state, { type: 'AUDIT_INTEGRITY_VERIFIED', verified: true, at: 10 });
  expect(demoCompleted(state), 'every included request needs a disposition').toBe(false);
  state = reduce(state, { type: 'AUDIT_REQUEST_DISPOSITION', requestId: '13', disposition: 'reviewed', at: 11 });
  expect(demoCompleted(state)).toBe(true);
  expect(state.lifecycle).toBe('completed');
});

test('watchdog cancellation cannot masquerade as a user reject', () => {
  let state = createDemoSession({ runId: 'run-timeout', now: 1 });
  state = reduce(state, { type: 'BIND_REQUEST', mission: 'approval', requestId: '12', at: 2 });
  state = reduce(state, { type: 'APPROVAL_SETTLED', requestId: '12', decision: 'reject', at: 3 });
  expect(state.missions.approval.outcome).toBeUndefined();
  expect(isMissionComplete(state, 'approval', { strict: true })).toBe(false);
});

test('late events from an old run cannot advance the active run', () => {
  const state = createDemoSession({ runId: 'current', now: 1 });
  const next = demoSessionReducer(state, {
    type: 'ROUTINE_EXECUTED', runId: 'previous', requestId: '99', at: 2,
  });
  expect(next).toBe(state);
});

test('tour pause and return restore the atomic route and role target', () => {
  let state = createDemoSession({ runId: 'guided', now: 1, route: { page: 'overview' } });
  state = reduce(state, {
    type: 'TOUR_STEP', step: 4, route: { page: 'audit-packets' }, role: 'auditor', at: 2,
  });
  state = reduce(state, { type: 'NAVIGATE', route: { page: 'funds' }, at: 3 });
  state = reduce(state, { type: 'SET_ROLE', role: 'delegate', at: 4 });
  state = reduce(state, { type: 'PAUSE_TOUR', reason: 'navigation', at: 5 });
  expect(state.tour.paused).toBe(true);
  state = reduce(state, { type: 'RETURN_TO_MISSION', at: 6 });
  expect(state.route).toEqual({ page: 'audit-packets' });
  expect(state.role).toBe('auditor');
  expect(state.tour.paused).toBe(false);
});

test('restart is blocked until a pending approval is refunded', () => {
  let state = createDemoSession({ runId: 'old-run', now: 1 });
  state = reduce(state, { type: 'REQUEST_RESTART', pendingApprovalRequestId: '42', at: 2 });
  expect(state.restart.status).toBe('cleanup-required');
  const refused = reduce(state, { type: 'CONFIRM_RESTART', newRunId: 'too-early', at: 3 });
  expect(refused.runId).toBe('old-run');
  state = reduce(state, { type: 'RESTART_CLEANUP_SUCCEEDED', requestId: '42', at: 4 });
  state = reduce(state, { type: 'CONFIRM_RESTART', newRunId: 'new-run', at: 5 });
  expect(state.runId).toBe('new-run');
  expect(state.missions.routine.status).toBe('ready');
});

test('failed restart cleanup leaves resume as the recovery path', () => {
  let state = createDemoSession({ runId: 'run-a', now: 1 });
  state = reduce(state, { type: 'REQUEST_RESTART', pendingApprovalRequestId: '42', at: 2 });
  state = reduce(state, { type: 'RESTART_CLEANUP_FAILED', requestId: '42', error: 'RPC unavailable', at: 3 });
  expect(state.restart.status).toBe('failed');
  expect(state.lifecycle).toBe('paused');
  expect(reduce(state, { type: 'CONFIRM_RESTART', newRunId: 'bad', at: 4 }).runId).toBe('run-a');
  state = reduce(state, { type: 'RESUME_SESSION', at: 5 });
  expect(state.lifecycle).toBe('active');
  expect(state.restart.status).toBe('idle');
});

test('session persistence uses the versioned key', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const state = createDemoSession({ runId: 'stored', now: 10 });
  expect(saveDemoSession(state, storage)).toBe(true);
  expect(values.has(DEMO_SESSION_KEY)).toBe(true);
  expect(loadDemoSession(storage)?.runId).toBe('stored');
});

test('legacy mission migration persists one stable run id', () => {
  const values = new Map<string, string>([['vg_missions', JSON.stringify({ routine: true })]]);
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const first = loadDemoSession(storage);
  const second = loadDemoSession(storage);
  expect(first).toBeTruthy();
  expect(first!.runId).toBe(second?.runId);
  expect(values.has(DEMO_SESSION_KEY)).toBe(true);
});
