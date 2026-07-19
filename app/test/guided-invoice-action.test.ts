import { expect, test } from 'vitest';
import { createDemoSession, demoSessionReducer, isMissionComplete } from '../src/demo-session';
import { deriveGuidedInvoiceAction } from '../src/guided-invoice-action';

const reduce = (
  state: ReturnType<typeof createDemoSession>,
  action: Omit<Parameters<typeof demoSessionReducer>[1], 'runId'>,
) => demoSessionReducer(state, { ...action, runId: state.runId } as Parameters<typeof demoSessionReducer>[1]);

test('completed guided invoices only open their frozen request', () => {
  let session = createDemoSession({ runId: 'guided-complete', now: 1 });
  session = reduce(session, { type: 'ROUTINE_EXECUTED', requestId: '35', at: 2 });
  const progress = session.missions.routine;

  expect(deriveGuidedInvoiceAction({
    mission: 'routine',
    progress,
    request: { id: 35n, state: 2 },
    complete: isMissionComplete(session, 'routine', { strict: true }),
  })).toEqual({
    kind: 'open',
    label: 'Open completed request',
    requestId: '35',
    enabled: true,
  });
});

test('in-flight and blocked attempts return to their bound request', () => {
  let session = createDemoSession({ runId: 'guided-current', now: 1 });
  session = reduce(session, { type: 'BIND_REQUEST', mission: 'approval', requestId: '36', at: 2 });
  session = reduce(session, { type: 'VIOLATION_BLOCKED', requestId: '37', at: 3 });

  expect(deriveGuidedInvoiceAction({
    mission: 'approval',
    progress: session.missions.approval,
    request: { id: 36n, state: 3 },
    complete: false,
  }).label).toBe('Open current request');
  expect(deriveGuidedInvoiceAction({
    mission: 'violation',
    progress: session.missions.violation,
    request: { id: 37n, state: 4 },
    complete: false,
  }).label).toBe('Open request to decrypt reason');
});

test('state-2 approval recovers evidence instead of resubmitting', () => {
  let session = createDemoSession({ runId: 'guided-approve', now: 1 });
  session = reduce(session, { type: 'BIND_REQUEST', mission: 'approval', requestId: '35', at: 2 });

  expect(deriveGuidedInvoiceAction({
    mission: 'approval',
    progress: session.missions.approval,
    request: { id: 35n, state: 2 },
    complete: false,
  })).toEqual({
    kind: 'recover',
    label: 'Recover decision evidence',
    requestId: '35',
    enabled: true,
  });
});

test('only authenticated timeout or expiry permits a retry', () => {
  let session = createDemoSession({ runId: 'guided-retry', now: 1 });
  session = reduce(session, { type: 'BIND_REQUEST', mission: 'approval', requestId: '37', at: 2 });
  const progress = session.missions.approval;

  expect(deriveGuidedInvoiceAction({
    mission: 'approval',
    progress,
    request: { id: 37n, state: 5 },
    attestation: { requestId: 37, chainState: 5, origin: 'unknown' },
    complete: false,
  }).kind).toBe('open');
  expect(deriveGuidedInvoiceAction({
    mission: 'approval',
    progress,
    request: { id: 37n, state: 5 },
    attestation: { requestId: 37, chainState: 5, origin: 'timeout' },
    complete: false,
  }).kind).toBe('retry');
  expect(deriveGuidedInvoiceAction({
    mission: 'approval',
    progress,
    request: { id: 37n, state: 6 },
    complete: false,
  }).kind).toBe('retry');
});

test('a missing binding is the only fresh-submit state', () => {
  const session = createDemoSession({ runId: 'guided-submit', now: 1 });
  expect(deriveGuidedInvoiceAction({
    mission: 'routine',
    progress: session.missions.routine,
    complete: false,
  }).kind).toBe('submit');
});
