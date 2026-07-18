import type { KeyboardEvent, ReactNode } from 'react';

export function Workbench({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`workbench ${className}`.trim()}>{children}</div>;
}

export function WorkbenchList({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <aside className="workbench-list" aria-label={title}>
      <header className="workbench-list-head">
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </header>
      <div className="workbench-list-body">{children}</div>
    </aside>
  );
}

export function WorkbenchDetail({ children, labelledBy }: { children: ReactNode; labelledBy?: string }) {
  return <section className="workbench-detail" aria-labelledby={labelledBy}>{children}</section>;
}

export type WorkbenchTab<T extends string> = { id: T; label: string; count?: number };

export function WorkbenchTabs<T extends string>({
  tabs,
  active,
  onChange,
  label,
  idPrefix,
}: {
  tabs: readonly WorkbenchTab<T>[];
  active: T;
  onChange: (tab: T) => void;
  label: string;
  idPrefix: string;
}) {
  const tabId = (id: T) => `${idPrefix}-tab-${id.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === 'Home' ? 0
      : event.key === 'End' ? tabs.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    const next = tabs[nextIndex];
    onChange(next.id);
    window.requestAnimationFrame(() => document.getElementById(tabId(next.id))?.focus());
  };
  return (
    <div className="workbench-tabs" role="tablist" aria-label={label}>
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          id={tabId(tab.id)}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          aria-controls={`${idPrefix}-panel`}
          tabIndex={active === tab.id ? 0 : -1}
          className={`workbench-tab ${active === tab.id ? 'active' : ''}`}
          onClick={() => onChange(tab.id)}
          onKeyDown={(event) => moveFocus(event, index)}
        >
          {tab.label}{tab.count !== undefined && <span className="workbench-tab-count">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}
