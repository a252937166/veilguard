import { expect, test } from 'vitest';
import { MISSION_STEPS } from '../src/GuidedTour.tsx';

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
