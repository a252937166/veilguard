/** Shared object models used by Payment Inbox, Request Detail, Approvals and Verify. */

export type { DemoScenario, DemoScenarioKey } from './demo-scenarios';

export type ObjectId = string | number | bigint;
export type Hex = `0x${string}`;

export type RequestChainState = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type RequestDetailStatus =
  | 'unknown'
  | 'tee-evaluating'
  | 'decision-ready'
  | 'direct-executed'
  | 'executed-unclassified'
  | 'awaiting-approval'
  | 'safe-approved'
  | 'safe-rejected'
  | 'cancelled'
  | 'blocked'
  | 'expired';

export type RequestOutcomePath = 'direct' | 'approval' | 'blocked' | 'unknown';

export type FlowStageState = 'pending' | 'current' | 'complete' | 'failed';

export type FlowStage = {
  id: 'submitted' | 'tee' | 'escrow' | 'safe' | 'recipient' | 'refund';
  label: string;
  detail: string;
  state: FlowStageState;
  visibility: 'public' | 'authorized';
  transactionHash?: Hex;
};

export type RequestCapabilities = {
  canFinalize: boolean;
  canApprove: boolean;
  canReject: boolean;
  canDecryptAmount: boolean;
  canDecryptReason: boolean;
  canRetry: boolean;
  canViewProof: boolean;
};

export type RequestTransactionIndex = {
  request?: Hex;
  finalize?: Hex;
  approval?: Hex;
  cancellation?: Hex;
  expiry?: Hex;
};

export type RequestEventEvidence = {
  outcomePath?: RequestOutcomePath;
  safeAction?: 'approve' | 'reject';
  /** A cancellation event alone never authenticates who initiated it. */
  decisionOrigin?: 'user' | 'timeout' | 'unknown';
  safeSignatures?: Array<{ signer: Hex; signedAt?: number }>;
};

export type RequestActor = {
  isDelegate?: boolean;
  isFinanceAdmin?: boolean;
  isSafeOwner?: boolean;
  isAuditor?: boolean;
  /** Public demo control backed by the restricted server-side Safe endpoint. */
  canUseDemoDecision?: boolean;
  disclosedAmount?: boolean;
  disclosedReason?: boolean;
};

export type RequestAuthorizedValues = {
  amount?: string;
  reason?: string;
  memo?: string;
  policyResult?: string;
};

export type SpendRequestLike = {
  id: ObjectId;
  mandateId: ObjectId;
  delegate: Hex;
  recipient: Hex;
  memoHash: Hex;
  createdAt: ObjectId;
  state: number;
  amount?: Hex;
  decision?: Hex;
  blockedReason?: Hex;
  decisionReady?: boolean;
};

export type PrivacyLens = {
  authorized: {
    amount?: string;
    recipient: Hex;
    memo?: string;
    policyResult?: string;
    reason?: string;
  };
  public: {
    amount: 'Encrypted handle';
    recipient: Hex;
    memo: 'Memo hash only';
    policyResult: 'Terminal state only';
    reason: 'Not disclosed';
  };
};

export type RequestDetailModel = {
  id: string;
  mandateId: string;
  createdAt: number;
  delegate: Hex;
  recipient: Hex;
  memoHash: Hex;
  chainState: RequestChainState;
  status: RequestDetailStatus;
  statusLabel: string;
  statusTone: 'neutral' | 'progress' | 'success' | 'warning' | 'danger';
  outcomePath: RequestOutcomePath;
  terminal: boolean;
  escrow: 'none' | 'reserved' | 'released-to-recipient' | 'refunded' | 'untouched';
  capabilities: RequestCapabilities;
  timeline: FlowStage[];
  transactions: RequestTransactionIndex;
  safeSignatures: Array<{ signer: Hex; signedAt?: number }>;
  privacy: PrivacyLens;
};

export type DeriveRequestDetailOptions = {
  transactions?: RequestTransactionIndex;
  events?: RequestEventEvidence;
  actor?: RequestActor;
  authorized?: RequestAuthorizedValues;
  expectedPath?: RequestOutcomePath;
};

export type RequestContexts<T> = {
  active?: T;
  viewed?: T;
};

/**
 * Keeps the operation that may finalize/advance a mission independent from the
 * object opened for inspection. A missing viewed id never falls back to active.
 */
export function resolveRequestContexts<T extends { id: ObjectId }>(
  requests: readonly T[],
  ids: { activeId?: ObjectId | null; viewedId?: ObjectId | null },
): RequestContexts<T> {
  const find = (id: ObjectId | null | undefined) => id == null
    ? undefined
    : requests.find((request) => String(request.id) === String(id));
  return { active: find(ids.activeId), viewed: find(ids.viewedId) };
}

const asId = (value: ObjectId) => String(value);
const asTimestamp = (value: ObjectId) => {
  const numeric = Number(value);
  // Contract timestamps are seconds; browser timestamps are milliseconds.
  return Number.isFinite(numeric) && numeric > 0 && numeric < 10_000_000_000
    ? numeric * 1_000
    : numeric;
};

const chainState = (state: number): RequestChainState =>
  state >= 0 && state <= 6 && Number.isInteger(state) ? state as RequestChainState : 0;

export function deriveRequestStatus(
  request: Pick<SpendRequestLike, 'state' | 'decisionReady'>,
  evidence: Pick<DeriveRequestDetailOptions, 'transactions' | 'events' | 'expectedPath'> = {},
): RequestDetailStatus {
  switch (chainState(request.state)) {
    case 1: return request.decisionReady ? 'decision-ready' : 'tee-evaluating';
    case 2: {
      const approvalEvidence = evidence.events?.safeAction === 'approve'
        || !!evidence.transactions?.approval
        || evidence.events?.outcomePath === 'approval';
      if (approvalEvidence) return 'safe-approved';
      const directEvidence = evidence.events?.outcomePath === 'direct';
      return directEvidence ? 'direct-executed' : 'executed-unclassified';
    }
    case 3: return 'awaiting-approval';
    case 4: return 'blocked';
    // EscalationCancelled proves cancellation/refund, not a user's Reject.
    case 5: return evidence.events?.decisionOrigin === 'user'
      && evidence.events.safeAction === 'reject'
      ? 'safe-rejected'
      : 'cancelled';
    case 6: return 'expired';
    default: return 'unknown';
  }
}

const outcomePathFor = (
  status: RequestDetailStatus,
  options: DeriveRequestDetailOptions,
): RequestOutcomePath => {
  if (status === 'direct-executed') return 'direct';
  if (status === 'executed-unclassified') return 'unknown';
  if (status === 'awaiting-approval' || status === 'safe-approved' || status === 'safe-rejected' || status === 'cancelled') return 'approval';
  if (status === 'blocked') return 'blocked';
  return options.events?.outcomePath ?? options.expectedPath ?? 'unknown';
};

const statusPresentation = (status: RequestDetailStatus): Pick<RequestDetailModel, 'statusLabel' | 'statusTone'> => {
  switch (status) {
    case 'tee-evaluating': return { statusLabel: 'Private evaluation in progress', statusTone: 'progress' };
    case 'decision-ready': return { statusLabel: 'TEE result ready to finalize', statusTone: 'progress' };
    case 'direct-executed': return { statusLabel: 'Executed within mandate', statusTone: 'success' };
    case 'executed-unclassified': return { statusLabel: 'Executed · path evidence indexing', statusTone: 'success' };
    case 'awaiting-approval': return { statusLabel: 'Awaiting committee decision', statusTone: 'warning' };
    case 'safe-approved': return { statusLabel: 'Approved and executed', statusTone: 'success' };
    case 'safe-rejected': return { statusLabel: 'User rejected · refunded', statusTone: 'danger' };
    case 'cancelled': return { statusLabel: 'Cancelled and refunded', statusTone: 'neutral' };
    case 'blocked': return { statusLabel: 'Blocked by confidential policy', statusTone: 'danger' };
    case 'expired': return { statusLabel: 'Expired and refunded', statusTone: 'warning' };
    default: return { statusLabel: 'Unknown request state', statusTone: 'neutral' };
  }
};

const stageState = (complete: boolean, current = false, failed = false): FlowStageState =>
  failed ? 'failed' : complete ? 'complete' : current ? 'current' : 'pending';

function buildTimeline(
  status: RequestDetailStatus,
  path: RequestOutcomePath,
  tx: RequestTransactionIndex,
  decisionOrigin: RequestEventEvidence['decisionOrigin'],
): FlowStage[] {
  const evaluated = !['unknown', 'tee-evaluating'].includes(status);
  const terminal = ['direct-executed', 'executed-unclassified', 'safe-approved', 'safe-rejected', 'cancelled', 'blocked', 'expired'].includes(status);
  const stages: FlowStage[] = [
    {
      id: 'submitted', label: 'Request submitted', detail: 'Encrypted amount committed on Sepolia',
      state: stageState(!!tx.request || status !== 'unknown'), visibility: 'public', transactionHash: tx.request,
    },
    {
      id: 'tee', label: 'Confidential policy evaluation',
      detail: status === 'tee-evaluating' ? 'Nox TEE is evaluating three private policy rules' : 'Proof-gated result finalized on-chain',
      state: stageState(evaluated, status === 'tee-evaluating' || status === 'decision-ready', status === 'expired'),
      visibility: 'public', transactionHash: tx.finalize,
    },
  ];

  if (path === 'approval') {
    stages.push(
      {
        id: 'escrow', label: 'Funds reserved in escrow', detail: 'No recipient transfer before a 2-of-2 decision',
        state: stageState(status !== 'tee-evaluating' && status !== 'decision-ready' && status !== 'unknown'), visibility: 'public',
      },
      {
        id: 'safe', label: 'Safe 2-of-2 decision',
        detail: status === 'safe-rejected'
          ? 'User-selected rejection authenticated by the run-bound server receipt'
          : status === 'cancelled'
            ? decisionOrigin === 'timeout'
              ? 'Decision window expired; timeout cancellation authenticated by the server journal'
              : 'Cancellation confirmed; no user Reject is claimed without an attestation'
            : 'Committee approval is required',
        state: stageState(status === 'safe-approved' || status === 'safe-rejected' || status === 'cancelled', status === 'awaiting-approval'),
        visibility: 'public', transactionHash: tx.approval ?? tx.cancellation,
      },
      status === 'safe-rejected' || status === 'cancelled'
        ? {
            id: 'refund', label: 'Escrow returned', detail: 'Budget restored to the delegated mandate',
            state: 'complete', visibility: 'public', transactionHash: tx.cancellation,
          }
        : {
            id: 'recipient', label: 'Recipient paid', detail: 'Confidential transfer released from escrow',
            state: stageState(status === 'safe-approved'), visibility: 'public', transactionHash: tx.approval,
          },
    );
  } else if (path === 'blocked') {
    stages.push({
      id: 'escrow', label: 'Treasury protected', detail: 'No funds moved; the private reason stays access-controlled',
      state: status === 'blocked' ? 'complete' : 'pending', visibility: 'authorized', transactionHash: tx.finalize,
    });
  } else if (status === 'executed-unclassified') {
    stages.push({
      id: 'recipient', label: 'Recipient paid', detail: 'Terminal execution is on-chain; direct versus Safe path is not claimed until event evidence is indexed',
      state: 'complete', visibility: 'public', transactionHash: tx.approval ?? tx.finalize,
    });
  } else {
    stages.push({
      id: 'recipient', label: 'Recipient paid', detail: 'Confidential transfer executed within the mandate',
      state: stageState(status === 'direct-executed', evaluated && !terminal), visibility: 'public', transactionHash: tx.finalize,
    });
  }
  return stages;
}

export function deriveRequestDetailModel(
  request: SpendRequestLike,
  options: DeriveRequestDetailOptions = {},
): RequestDetailModel {
  const transactions = options.transactions ?? {};
  const actor = options.actor ?? {};
  const status = deriveRequestStatus(request, options);
  const outcomePath = outcomePathFor(status, options);
  const presentation = statusPresentation(status);
  const terminal = ['direct-executed', 'executed-unclassified', 'safe-approved', 'safe-rejected', 'cancelled', 'blocked', 'expired'].includes(status);
  const amountViewer = !!(actor.isDelegate || actor.isFinanceAdmin || actor.isSafeOwner || actor.disclosedAmount);
  const reasonViewer = !!(actor.isDelegate || actor.isFinanceAdmin || actor.disclosedReason);
  const decisionActor = !!(actor.isSafeOwner || actor.canUseDemoDecision);
  const escrow: RequestDetailModel['escrow'] = status === 'awaiting-approval'
    ? 'reserved'
    : status === 'safe-approved' || status === 'executed-unclassified' ? 'released-to-recipient'
      : status === 'safe-rejected' || status === 'cancelled' || status === 'expired' ? 'refunded'
        : status === 'blocked' ? 'untouched' : 'none';

  return {
    id: asId(request.id),
    mandateId: asId(request.mandateId),
    createdAt: asTimestamp(request.createdAt),
    delegate: request.delegate,
    recipient: request.recipient,
    memoHash: request.memoHash,
    chainState: chainState(request.state),
    status,
    ...presentation,
    outcomePath,
    terminal,
    escrow,
    capabilities: {
      canFinalize: request.state === 1 && request.decisionReady === true,
      canApprove: status === 'awaiting-approval' && decisionActor,
      canReject: status === 'awaiting-approval' && decisionActor,
      canDecryptAmount: amountViewer,
      canDecryptReason: status === 'blocked' && reasonViewer,
      canRetry: status === 'tee-evaluating' || status === 'decision-ready',
      canViewProof: !!(transactions.request || transactions.finalize || terminal),
    },
    timeline: buildTimeline(status, outcomePath, transactions, options.events?.decisionOrigin),
    transactions,
    safeSignatures: options.events?.safeSignatures ?? [],
    privacy: {
      authorized: {
        amount: amountViewer ? options.authorized?.amount : undefined,
        recipient: request.recipient,
        memo: options.authorized?.memo,
        policyResult: options.authorized?.policyResult,
        reason: reasonViewer ? options.authorized?.reason : undefined,
      },
      public: {
        amount: 'Encrypted handle',
        recipient: request.recipient,
        memo: 'Memo hash only',
        policyResult: 'Terminal state only',
        reason: 'Not disclosed',
      },
    },
  };
}
