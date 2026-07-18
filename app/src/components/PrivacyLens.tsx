import type { ReactNode } from 'react';

export type PrivacyLensRow = { label: string; value: ReactNode };

export function PrivacyLens({
  authorized,
  publicView,
}: {
  authorized: PrivacyLensRow[];
  publicView: PrivacyLensRow[];
}) {
  const side = (title: string, rows: PrivacyLensRow[], className: string) => (
    <section className={`privacy-side ${className}`} aria-label={title}>
      <h4>{title}</h4>
      <dl>
        {rows.map((row) => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}
      </dl>
    </section>
  );
  return (
    <div className="privacy-lens" aria-label="Privacy lens comparison">
      {side('What the authorised role sees', authorized, 'authorised')}
      <div className="privacy-vs" aria-hidden="true">VS</div>
      {side('What the public chain sees', publicView, 'public')}
    </div>
  );
}
