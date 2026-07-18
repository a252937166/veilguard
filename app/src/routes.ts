/**
 * Typed application routes and a small, dependency-free hash codec.
 *
 * The UI may render these routes with React Router's HashRouter, but keeping the
 * codec framework-agnostic makes navigation state testable and lets old tabs
 * migrate without a flag day.
 */

export type AppRoute =
  | { page: 'overview' }
  | { page: 'payment-inbox' }
  | { page: 'new-payment' }
  | { page: 'payment-detail'; requestId: string }
  | { page: 'policies' }
  | { page: 'policy-detail'; policyId: string }
  | { page: 'approvals' }
  | { page: 'approval-detail'; requestId: string }
  | { page: 'disclosure-builder' }
  | { page: 'audit-packets' }
  | { page: 'audit-detail'; packetId: string }
  | { page: 'verify'; flowId?: string }
  | { page: 'contracts' }
  | { page: 'provenance' }
  | { page: 'funds' };

export type RouteObjectSelection = {
  requestId?: string;
  policyId?: string;
  packetId?: string;
  flowId?: string;
};

export type LegacyTabName =
  | 'Dashboard'
  | 'Delegate'
  | 'Admin'
  | 'Signer'
  | 'Auditor'
  | 'Verify'
  | 'Get Funds';

export const DEFAULT_APP_ROUTE: AppRoute = { page: 'overview' };

const cleanId = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  try {
    const decoded = decodeURIComponent(value).trim();
    // IDs are deliberately opaque, but path separators/control characters are
    // never valid object identifiers and would make round-tripping ambiguous.
    if (!decoded || /[\u0000-\u001f/\\]/.test(decoded)) return undefined;
    return decoded;
  } catch {
    return undefined;
  }
};

const encoded = (value: string) => encodeURIComponent(value);

/** Return an AppRoute for an app hash, or null when the hash is the landing page. */
export function parseAppHash(hash: string): AppRoute | null {
  const raw = hash.trim();
  if (!raw || raw === '#') return null;
  if (raw === '#app' || raw === '#/app' || raw === '#/overview') return DEFAULT_APP_ROUTE;

  const path = raw.replace(/^#/, '').replace(/^\/?/, '/').replace(/\/+$/, '') || '/';
  const parts = path.split('/').filter(Boolean);
  const [root, id, extra] = parts;
  if (extra) return null;

  switch (root) {
    case 'overview': return { page: 'overview' };
    case 'payments': {
      if (!id) return { page: 'payment-inbox' };
      if (id === 'new') return { page: 'new-payment' };
      const requestId = cleanId(id);
      return requestId ? { page: 'payment-detail', requestId } : null;
    }
    case 'policies': {
      if (!id) return { page: 'policies' };
      const policyId = cleanId(id);
      return policyId ? { page: 'policy-detail', policyId } : null;
    }
    case 'approvals': {
      if (!id) return { page: 'approvals' };
      const requestId = cleanId(id);
      return requestId ? { page: 'approval-detail', requestId } : null;
    }
    case 'disclosure': return id ? null : { page: 'disclosure-builder' };
    case 'audit': {
      if (!id) return { page: 'audit-packets' };
      const packetId = cleanId(id);
      return packetId ? { page: 'audit-detail', packetId } : null;
    }
    case 'verify': {
      const flowId = cleanId(id);
      return id && !flowId ? null : { page: 'verify', ...(flowId ? { flowId } : {}) };
    }
    case 'contracts': return id ? null : { page: 'contracts' };
    case 'provenance': return id ? null : { page: 'provenance' };
    case 'funds': return id ? null : { page: 'funds' };
    default: return null;
  }
}

export function formatAppRoute(route: AppRoute): string {
  switch (route.page) {
    case 'overview': return '#/overview';
    case 'payment-inbox': return '#/payments';
    case 'new-payment': return '#/payments/new';
    case 'payment-detail': return `#/payments/${encoded(route.requestId)}`;
    case 'policies': return '#/policies';
    case 'policy-detail': return `#/policies/${encoded(route.policyId)}`;
    case 'approvals': return '#/approvals';
    case 'approval-detail': return `#/approvals/${encoded(route.requestId)}`;
    case 'disclosure-builder': return '#/disclosure';
    case 'audit-packets': return '#/audit';
    case 'audit-detail': return `#/audit/${encoded(route.packetId)}`;
    case 'verify': return route.flowId ? `#/verify/${encoded(route.flowId)}` : '#/verify';
    case 'contracts': return '#/contracts';
    case 'provenance': return '#/provenance';
    case 'funds': return '#/funds';
  }
}

export function sameAppRoute(a: AppRoute | null | undefined, b: AppRoute | null | undefined): boolean {
  return !!a && !!b && formatAppRoute(a) === formatAppRoute(b);
}

export function selectionFromRoute(route: AppRoute): RouteObjectSelection {
  switch (route.page) {
    case 'payment-detail':
    case 'approval-detail': return { requestId: route.requestId };
    case 'policy-detail': return { policyId: route.policyId };
    case 'audit-detail': return { packetId: route.packetId };
    case 'verify': return route.flowId ? { flowId: route.flowId } : {};
    default: return {};
  }
}

/** Temporary bridge for the existing tab renderer while routes are adopted. */
export function routeToLegacyTab(route: AppRoute): LegacyTabName {
  switch (route.page) {
    case 'overview': return 'Dashboard';
    case 'payment-inbox':
    case 'new-payment':
    case 'payment-detail': return 'Delegate';
    case 'policies':
    case 'policy-detail':
    case 'disclosure-builder': return 'Admin';
    case 'approvals':
    case 'approval-detail': return 'Signer';
    case 'audit-packets':
    case 'audit-detail': return 'Auditor';
    case 'verify':
    case 'contracts':
    case 'provenance': return 'Verify';
    case 'funds': return 'Get Funds';
  }
}

export function legacyTabToRoute(tab: LegacyTabName): AppRoute {
  switch (tab) {
    case 'Dashboard': return { page: 'overview' };
    case 'Delegate': return { page: 'payment-inbox' };
    case 'Admin': return { page: 'policies' };
    case 'Signer': return { page: 'approvals' };
    case 'Auditor': return { page: 'audit-packets' };
    case 'Verify': return { page: 'verify' };
    case 'Get Funds': return { page: 'funds' };
  }
}

export function appRouteLabel(route: AppRoute): string {
  switch (route.page) {
    case 'overview': return 'Overview';
    case 'payment-inbox': return 'Payment Inbox';
    case 'new-payment': return 'New Payment';
    case 'payment-detail': return `Request #${route.requestId}`;
    case 'policies': return 'Policies';
    case 'policy-detail': return `Policy #${route.policyId}`;
    case 'approvals': return 'Pending Approvals';
    case 'approval-detail': return `Approval #${route.requestId}`;
    case 'disclosure-builder': return 'Build Packet';
    case 'audit-packets': return 'Audit Packets';
    case 'audit-detail': return `Packet #${route.packetId}`;
    case 'verify': return route.flowId ? `Flow ${route.flowId}` : 'Flow Explorer';
    case 'contracts': return 'Contracts';
    case 'provenance': return 'Build Provenance';
    case 'funds': return 'Get Funds';
  }
}
