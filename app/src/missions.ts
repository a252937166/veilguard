/**
 * Mission progress for the three-outcome collection game. Per-tab
 * (sessionStorage), matching the demo-role persistence.
 */
export type MissionKey = 'routine' | 'approval' | 'violation' | 'audit';

export type MissionState = Record<MissionKey, boolean>;

const KEY = 'vg_missions';
const EMPTY: MissionState = { routine: false, approval: false, violation: false, audit: false };

export function loadMissions(): MissionState {
  try { return { ...EMPTY, ...JSON.parse(sessionStorage.getItem(KEY) ?? '{}') }; }
  catch { return { ...EMPTY }; }
}

export function completeMission(k: MissionKey): MissionState {
  const next = { ...loadMissions(), [k]: true };
  try { sessionStorage.setItem(KEY, JSON.stringify(next)); } catch { /* ignore */ }
  try { window.dispatchEvent(new CustomEvent('vg-missions')); } catch { /* ignore */ }
  return next;
}

export const MISSIONS: { key: MissionKey; title: string; goal: string; outcome: string }[] = [
  { key: 'routine', title: 'Routine payment', goal: 'Pay the vendor a routine amount — the private policy auto-executes it.', outcome: '✓ Executed' },
  { key: 'approval', title: 'Approval challenge', goal: 'Submit a payment above the secret auto-limit — watch the committee approve a real 2-of-2.', outcome: '⏸ Approval required' },
  { key: 'violation', title: 'Policy violation', goal: 'Try to overspend — the TEE blocks it and no funds move.', outcome: '⛔ Blocked' },
];
