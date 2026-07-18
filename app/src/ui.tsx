import { useState } from 'react';
import { DECISION_LABEL, MANDATE_STATES, REQUEST_STATES, fmt } from './config';
import { handleClientFor, waitResolved } from './nox';
import { useApp } from './App';

export function MandatePill({ state }: { state: number }) {
  const cls = state === 2 ? 'ok' : state === 1 ? 'warn' : 'dim';
  return <span className={`pill ${cls}`}>{MANDATE_STATES[state] ?? state}</span>;
}

export function RequestPill({ state, decisionReady }: { state: number; decisionReady?: boolean }) {
  if (state === 1) {
    return decisionReady
      ? <span className="pill tee">DECIDED — FINALIZE</span>
      : <span className="pill tee"><span className="spin" /> CHECKING IN TEE</span>;
  }
  const map: Record<number, [string, string]> = {
    2: ['ok', 'EXECUTED'], 3: ['warn', 'APPROVAL REQUIRED'], 4: ['bad', 'BLOCKED'],
    5: ['dim', 'CANCELLED'], 6: ['dim', 'EXPIRED'],
  };
  const [cls, label] = map[state] ?? ['dim', REQUEST_STATES[state] ?? String(state)];
  return <span className={`pill ${cls}`}>{label}</span>;
}

/** Decrypt-on-click for a handle the connected account can view. */
export function Decrypt({ handle, unit = 'cUSDC', label = 'Decrypt' }: {
  handle: `0x${string}`; unit?: string; label?: string;
}) {
  const { account, toast } = useApp();
  const [value, setValue] = useState<string>();
  const [loading, setLoading] = useState(false);
  if (value !== undefined) return <span className="value">{value}{unit ? ` ${unit}` : ''}</span>;
  return (
    <button
      className="btn small ghost"
      disabled={!account || loading}
      onClick={async () => {
        if (!account) return;
        setLoading(true);
        try {
          const client = await handleClientFor(account);
          await waitResolved([handle]);
          const { value: v, solidityType } = await client.decrypt(handle as any);
          setValue(solidityType === 'uint256' ? fmt(v as bigint) : String(v));
        } catch (e: any) {
          toast(`Decrypt refused: ${e?.message ?? e}`.slice(0, 300), true);
        } finally {
          setLoading(false);
        }
      }}
    >
      {loading ? <span className="spin" /> : `🔓 ${label}`}
    </button>
  );
}

export function DecisionLabel({ value }: { value: number }) {
  const cls = value === 1 ? 'ok' : value === 2 ? 'warn' : 'bad';
  return <span className={`pill ${cls}`}>{DECISION_LABEL[value] ?? value}</span>;
}

/**
 * Dead-end helper: when the connected wallet holds no on-chain role for a view,
 * explain why (role-gating is the point) and offer a one-click path into the
 * matching demo account instead of leaving the user stuck.
 */
export function NoRole({
  title, body, demo,
}: {
  title: string;
  body: string;
  demo?: 'delegate' | 'auditor';
}) {
  const { account, startDemo, openRolePicker } = useApp();
  return (
    <div className="norole">
      <h3>{title}</h3>
      <p className="muted" style={{ fontSize: 13.5, maxWidth: 640 }}>{body}</p>
      {account && <p className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>Connected: <span className="mono">{account.slice(0, 6)}…{account.slice(-4)}</span> — this wallet holds no such role, by design (every value is gated by on-chain ACLs).</p>}
      <div className="row" style={{ marginTop: 14 }}>
        {demo
          ? <button className="btn primary" onClick={() => startDemo(demo)}>⚡ Try as the demo {demo === 'delegate' ? 'Delegate' : 'Auditor'} — instant</button>
          : <button className="btn primary" onClick={openRolePicker}>⚡ Try a demo role</button>}
        <span className="muted" style={{ fontSize: 12.5 }}>a shared, pre-funded public account with the right permissions — no setup</span>
      </div>
    </div>
  );
}
