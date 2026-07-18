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
