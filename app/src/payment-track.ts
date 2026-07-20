import type { MissionKey } from './missions';

export type PaymentTrack = {
  id?: string;
  mission: MissionKey | 'free';
  amount: string;
  tx?: `0x${string}`;
  delegate?: `0x${string}`;
  at: number;
  runId?: string;
  replaceRetryableAttempt?: boolean;
};

export function loadPaymentTrack(): PaymentTrack | null {
  try { return JSON.parse(sessionStorage.getItem('vg_track') ?? 'null'); }
  catch { return null; }
}

export function savePaymentTrack(track: PaymentTrack | null): void {
  try {
    if (track) sessionStorage.setItem('vg_track', JSON.stringify(track));
    else sessionStorage.removeItem('vg_track');
  } catch { /* storage is best-effort before broadcast; guarded at call sites */ }
}

export function unresolvedRunBroadcast(
  runId: string,
  track: PaymentTrack | null = loadPaymentTrack(),
): PaymentTrack | null {
  return track?.runId === runId && !!track.tx && !track.id ? track : null;
}
