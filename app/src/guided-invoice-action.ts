import type { DemoDecisionAttestation } from './demo-decision-attestation';
import type { DemoMissionKey, MissionProgress } from './demo-session';

export type GuidedInvoiceAction =
  | {
    kind: 'submit';
    label: 'Submit confidential payment';
    enabled: true;
  }
  | {
    kind: 'open';
    label: 'Open completed request' | 'Open current request' | 'Open request to decrypt reason';
    requestId: string;
    enabled: true;
  }
  | {
    kind: 'recover';
    label: 'Recover decision evidence';
    requestId: string;
    enabled: true;
  }
  | {
    kind: 'retry';
    label: 'Retry invoice';
    requestId: string;
    enabled: true;
  };

export type GuidedAttemptRequest = {
  id: string | number | bigint;
  state: number;
};

type GuidedInvoiceActionInput = {
  mission: Exclude<DemoMissionKey, 'audit'>;
  progress: MissionProgress;
  request?: GuidedAttemptRequest;
  attestation?: DemoDecisionAttestation;
  complete: boolean;
};

/**
 * Converts persisted mission evidence and the bound on-chain attempt into one
 * judge-facing action. A cancellation is retryable only when the service has
 * authenticated it as the decision-window timeout; an unavailable attestation
 * stays attached to the current request and never permits another spend.
 */
export function deriveGuidedInvoiceAction({
  mission,
  progress,
  request,
  attestation,
  complete,
}: GuidedInvoiceActionInput): GuidedInvoiceAction {
  if (complete && progress.requestId) {
    return { kind: 'open', label: 'Open completed request', requestId: progress.requestId, enabled: true };
  }

  if (!progress.requestId) {
    return { kind: 'submit', label: 'Submit confidential payment', enabled: true };
  }

  const requestId = progress.requestId;
  if (!request) {
    return { kind: 'open', label: 'Open current request', requestId, enabled: true };
  }

  if (request.state === 1 || request.state === 3) {
    return { kind: 'open', label: 'Open current request', requestId, enabled: true };
  }

  if (mission === 'violation' && request.state === 4 && progress.reasonDecrypted !== true) {
    return { kind: 'open', label: 'Open request to decrypt reason', requestId, enabled: true };
  }

  if (mission === 'approval' && request.state === 2) {
    return { kind: 'recover', label: 'Recover decision evidence', requestId, enabled: true };
  }

  if (mission === 'approval' && request.state === 5) {
    if (attestation?.origin === 'timeout') {
      return { kind: 'retry', label: 'Retry invoice', requestId, enabled: true };
    }
    if (attestation?.origin === 'user' && attestation.action === 'reject' && attestation.chainState === 5) {
      return { kind: 'recover', label: 'Recover decision evidence', requestId, enabled: true };
    }
    return { kind: 'open', label: 'Open current request', requestId, enabled: true };
  }

  if (request.state === 6) {
    return { kind: 'retry', label: 'Retry invoice', requestId, enabled: true };
  }

  return { kind: 'open', label: 'Open current request', requestId, enabled: true };
}
