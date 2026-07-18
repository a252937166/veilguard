import { expect, test } from 'vitest';
import {
  formatAppRoute,
  legacyTabToRoute,
  parseAppHash,
  routeToLegacyTab,
  sameAppRoute,
  type AppRoute,
} from '../src/routes.ts';

test('route codec round-trips all object and workspace routes', () => {
  const routes: AppRoute[] = [
    { page: 'overview' }, { page: 'payment-inbox' }, { page: 'new-payment' },
    { page: 'payment-detail', requestId: '42' }, { page: 'policies' },
    { page: 'policy-detail', policyId: 'policy v4' }, { page: 'approvals' },
    { page: 'approval-detail', requestId: '0xabc' }, { page: 'disclosure-builder' },
    { page: 'audit-packets' }, { page: 'audit-detail', packetId: '7' },
    { page: 'verify' }, { page: 'verify', flowId: 'launch-day' },
    { page: 'contracts' }, { page: 'provenance' }, { page: 'funds' },
  ];
  for (const route of routes) {
    expect(parseAppHash(formatAppRoute(route))).toEqual(route);
  }
});

test('legacy entry and tab compatibility remain deterministic', () => {
  expect(parseAppHash('#app')).toEqual({ page: 'overview' });
  expect(parseAppHash('')).toBeNull();
  expect(routeToLegacyTab({ page: 'approval-detail', requestId: '4' })).toBe('Signer');
  expect(legacyTabToRoute('Auditor')).toEqual({ page: 'audit-packets' });
});

test('invalid and ambiguous object ids are rejected', () => {
  expect(parseAppHash('#/payments/a/b')).toBeNull();
  expect(parseAppHash('#/payments/%2Fetc')).toBeNull();
  expect(parseAppHash('#/contracts/extra')).toBeNull();
  expect(sameAppRoute({ page: 'verify' }, { page: 'verify' })).toBe(true);
});
