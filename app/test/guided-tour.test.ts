import { expect, test } from 'vitest';
import {
  MISSION_STEPS,
  deriveGuidedStepPreparation,
  isMissionRouteCompatible,
} from '../src/GuidedTour.tsx';
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

test('mission drawer has no skip-ahead control or copy', () => {
  for (const step of MISSION_STEPS) {
    expect(`${step.title} ${step.body} ${step.nextLabel ?? ''}`).not.toMatch(/skip ahead/i);
    if (step.mission) expect(step.nextLabel).toMatch(/continue/i);
  }
});

test('action missions define compact mobile instructions', () => {
  for (const step of MISSION_STEPS.filter((candidate) => candidate.mission || candidate.gate)) {
    expect(step.mobileActionLabel).toBeTruthy();
  }
});

test('story order is request decisions, disclosure, then verification', () => {
  expect(MISSION_STEPS.map((step) => step.mission ?? step.route.page))
    .toEqual(['payment-inbox', 'routine', 'approval', 'violation', 'disclosure-builder', 'audit', 'verify']);
});

test('fresh payment missions prepare the exact invoice without pretending chain work started', () => {
  let session = createDemoSession({ runId: 'launch-guide', route: { page: 'payment-inbox' }, tourActive: true });
  for (const [step, scenarioKey, vendor, amount] of [
    [1, 'routine', 'CloudNode', '25'],
    [2, 'approval', 'ShieldOps', '60'],
    [3, 'violation', 'Atlas Contractor', '600'],
  ] as const) {
    session = demoSessionReducer(session, {
      type: 'TOUR_STEP', runId: session.runId, step,
      route: { page: 'payment-inbox' }, role: 'delegate', at: step + 1,
    });
    const preparation = deriveGuidedStepPreparation(session, [], step);
    expect(preparation).toMatchObject({
      phase: 'ready',
      route: { page: 'payment-inbox' },
      selected: { scenarioKey },
      targetId: `mission-${scenarioKey}`,
    });
    expect(preparation?.label).toContain(vendor);
    expect(preparation?.detail).toContain(`${amount} cUSDC`);
  }
});

test('bound approval and blocked requests open their exact next action', () => {
  let approval = createDemoSession({ runId: 'launch-approval-guide', route: { page: 'payment-inbox' }, tourActive: true });
  approval = demoSessionReducer(approval, {
    type: 'BIND_REQUEST', runId: approval.runId, mission: 'approval', requestId: '52', at: 2,
  });
  const decision = deriveGuidedStepPreparation(approval, [request(52n, 3)], 2);
  expect(decision).toMatchObject({
    phase: 'ready',
    route: { page: 'payment-detail', requestId: '52' },
    targetId: 'mission-approval',
  });
  expect(decision?.instruction).toMatch(/approve payment.*reject/i);

  let violation = createDemoSession({ runId: 'launch-block-guide', route: { page: 'payment-inbox' }, tourActive: true });
  violation = demoSessionReducer(violation, {
    type: 'BIND_REQUEST', runId: violation.runId, mission: 'violation', requestId: '53', at: 2,
  });
  const decrypt = deriveGuidedStepPreparation(violation, [request(53n, 4)], 3);
  expect(decrypt).toMatchObject({
    phase: 'ready',
    route: { page: 'payment-detail', requestId: '53' },
    targetId: 'mission-violation',
  });
  expect(decrypt?.instruction).toMatch(/decrypt the private reason/i);
});

test('recovery, retry, disclosure and audit handoffs derive from evidence instead of page-local state', () => {
  let session = createDemoSession({ runId: 'launch-evidence-guide', route: { page: 'payment-inbox' }, tourActive: true });
  session = demoSessionReducer(session, {
    type: 'BIND_REQUEST', runId: session.runId, mission: 'approval', requestId: '71', at: 2,
  });
  expect(deriveGuidedStepPreparation(session, [request(71n, 2)], 2)).toMatchObject({
    phase: 'ready',
    label: 'Recover decision evidence',
    route: { page: 'payment-inbox' },
    selected: { scenarioKey: 'approval', requestId: '71' },
  });

  let cancelled = createDemoSession({ runId: 'launch-cancelled-guide', route: { page: 'payment-inbox' }, tourActive: true });
  cancelled = demoSessionReducer(cancelled, {
    type: 'BIND_REQUEST', runId: cancelled.runId, mission: 'approval', requestId: '73', at: 2,
  });
  const cancelledPreparation = deriveGuidedStepPreparation(cancelled, [request(73n, 5)], 2);
  expect(cancelledPreparation).toMatchObject({
    phase: 'ready',
    label: 'Open cancelled request #73',
    route: { page: 'payment-inbox' },
    selected: { scenarioKey: 'approval', requestId: '73' },
  });
  expect(`${cancelledPreparation?.instruction} ${cancelledPreparation?.detail}`).not.toMatch(/click.*recover decision evidence/i);
  expect(cancelledPreparation?.detail).toMatch(/recover, retry or open/i);

  let expired = createDemoSession({ runId: 'launch-expired-guide', route: { page: 'payment-inbox' }, tourActive: true });
  expired = demoSessionReducer(expired, {
    type: 'BIND_REQUEST', runId: expired.runId, mission: 'routine', requestId: '72', at: 2,
  });
  expect(deriveGuidedStepPreparation(expired, [request(72n, 6)], 1)).toMatchObject({
    phase: 'ready',
    label: 'Retry CloudNode invoice',
    selected: { scenarioKey: 'routine', requestId: '72' },
  });

  expect(deriveGuidedStepPreparation(session, [request(71n, 2)], 4)).toMatchObject({
    route: { page: 'disclosure-builder' },
    targetId: 'mission-disclosure',
    label: 'Open preselected disclosure scope',
  });

  session = demoSessionReducer(session, {
    type: 'AUDIT_PACKETS_CREATED', runId: session.runId,
    packetIds: ['8', '9'], requestIds: ['71'], at: 3,
  });
  expect(deriveGuidedStepPreparation(session, [request(71n, 2)], 5)).toMatchObject({
    route: { page: 'audit-detail', packetId: '8' },
    role: 'auditor',
    selected: { packetId: '8' },
    targetId: 'mission-audit',
  });

  session = demoSessionReducer(session, {
    type: 'NAVIGATE', runId: session.runId,
    route: { page: 'audit-detail', packetId: '9' }, selected: { packetId: '9' }, at: 4,
  });
  expect(deriveGuidedStepPreparation(session, [request(71n, 2)], 5)).toMatchObject({
    route: { page: 'audit-detail', packetId: '9' },
    selected: { packetId: '9' },
  });
});

test('run-bound request detail remains inside the active payment mission', () => {
  let session = createDemoSession({ runId: 'launch-compatible', route: { page: 'payment-inbox' }, tourActive: true });
  session = demoSessionReducer(session, {
    type: 'BIND_REQUEST', runId: session.runId, mission: 'routine', requestId: '61', at: 2,
  });
  session = demoSessionReducer(session, {
    type: 'TOUR_STEP', runId: session.runId, step: 1,
    route: { page: 'payment-inbox' }, role: 'delegate', selected: { scenarioKey: 'routine' }, at: 3,
  });
  expect(isMissionRouteCompatible(MISSION_STEPS[1], { page: 'payment-detail', requestId: '61' }, session)).toBe(true);
  expect(isMissionRouteCompatible(MISSION_STEPS[1], { page: 'payment-detail', requestId: '62' }, session)).toBe(false);
});
