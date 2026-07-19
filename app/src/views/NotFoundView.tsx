import { Link } from 'react-router-dom';
import { formatAppRoute } from '../routes';

export function NotFoundView({ path }: { path: string }) {
  return (
    <section className="surface-section workspace-loading" role="alert" aria-labelledby="not-found-title">
      <span className="detail-kicker">Invalid object route</span>
      <h1 id="not-found-title">Page not found</h1>
      <p>The path <span className="mono">{path}</span> does not identify a VeilGuard object. Request, policy, approval and packet IDs must be decimal on-chain IDs.</p>
      <div className="row">
        <Link className="btn primary" to={formatAppRoute({ page: 'overview' }).slice(1)}>Return to Overview</Link>
        <Link className="btn" to={formatAppRoute({ page: 'payment-inbox' }).slice(1)}>Open Payment Inbox</Link>
      </div>
    </section>
  );
}
