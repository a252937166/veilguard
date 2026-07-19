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
    { page: 'policy-new' }, { page: 'policy-detail', policyId: '4' },
    { page: 'policy-new-version', policyId: '4' }, { page: 'approvals' },
    { page: 'approval-detail', requestId: '12' }, { page: 'disclosure-builder' },
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
  expect(parseAppHash('#/')).toBeNull();
  expect(routeToLegacyTab({ page: 'approval-detail', requestId: '4' })).toBe('Signer');
  expect(legacyTabToRoute('Auditor')).toEqual({ page: 'audit-packets' });
});

test('invalid and ambiguous object ids resolve to an explicit not-found route', () => {
  expect(parseAppHash('#/payments/a/b')).toEqual({ page: 'not-found', path: '/payments/a/b' });
  expect(parseAppHash('#/payments/%2Fetc')).toEqual({ page: 'not-found', path: '/payments/%2Fetc' });
  expect(parseAppHash('#/payments/0x12')).toEqual({ page: 'not-found', path: '/payments/0x12' });
  expect(parseAppHash('#/approvals/request-4')).toEqual({ page: 'not-found', path: '/approvals/request-4' });
  expect(parseAppHash('#/policies/v4')).toEqual({ page: 'not-found', path: '/policies/v4' });
  expect(parseAppHash('#/audit/packet-7')).toEqual({ page: 'not-found', path: '/audit/packet-7' });
  expect(parseAppHash('#/contracts/extra')).toEqual({ page: 'not-found', path: '/contracts/extra' });
  expect(parseAppHash('#/policies/4/not-a-version-action')).toEqual({ page: 'not-found', path: '/policies/4/not-a-version-action' });
  expect(sameAppRoute({ page: 'verify' }, { page: 'verify' })).toBe(true);
});
