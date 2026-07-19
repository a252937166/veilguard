export type LiveReleaseAction = 'approve' | 'reject';

export type LiveDecisionAttestation = {
  ok: true;
  requestId: number;
  chainState: 2 | 5;
  origin: 'user';
  action: LiveReleaseAction;
  hash: `0x${string}`;
  recordedAt?: number;
};

/**
 * Durable, partial pointer written before and immediately after the real Safe
 * decision. It is intentionally a different schema from verified evidence so
 * the release manifest can never mistake recovery data for acceptance proof.
 */
export type LiveReleaseRecoveryPointerV1 = {
  schema: 'veilguard.live-release-recovery';
  version: 1;
  generatedAt: string;
  phase: 'run-started' | 'routine-observed' | 'request-bound' | 'decision-observed';
  workflow: {
    repository?: string;
    runId?: string;
    sourceCommit: string;
  };
  production: {
    baseUrl: string;
    expectedUiSha: string;
    observedUiSha: string;
  };
  scenario: {
    name: 'ShieldOps';
    runId: string;
    routineRequestId?: string;
    requestId?: string;
  };
  activeBroadcast?: {
    mission?: string;
    requestId?: string;
    transactionHash: `0x${string}`;
  };
  decision: {
    action: LiveReleaseAction;
    transactionHash?: `0x${string}`;
    etherscanUrl?: string;
  };
  attestation?: LiveDecisionAttestation;
};

/**
 * Machine-readable artifact emitted by one intentionally destructive production
 * release action. Keep this versioned: downstream release manifests validate
 * the schema before presenting any transaction as acceptance evidence.
 */
export type LiveReleaseEvidenceV1 = {
  schema: 'veilguard.live-release-evidence';
  version: 1;
  generatedAt: string;
  workflow: {
    repository?: string;
    runId?: string;
    sourceCommit: string;
  };
  production: {
    baseUrl: string;
    expectedUiSha: string;
    observedUiSha: string;
  };
  chain: {
    id: 11155111;
    network: 'ethereum-sepolia';
    module: `0x${string}`;
    safe: `0x${string}`;
    safeThreshold: 2;
    safeOwnerCount: 2;
  };
  scenario: {
    name: 'ShieldOps';
    runId: string;
    requestId: string;
  };
  decision: {
    action: LiveReleaseAction;
    origin: 'user';
    chainState: 2 | 5;
    transactionHash: `0x${string}`;
    etherscanUrl: string;
  };
  transactions: {
    request: {
      hash: `0x${string}`;
      status: 'success';
      etherscanUrl: string;
    };
    teeFinalize: {
      hash: `0x${string}`;
      status: 'success';
      terminalEvent: 'EscalationReady';
      etherscanUrl: string;
    };
    safeDecision: {
      hash: `0x${string}`;
      status: 'success';
      blockNumber: string;
      outerTarget: `0x${string}`;
      moduleTarget: `0x${string}`;
      moduleAction: 'executeEscalated' | 'cancelEscalated';
      requestId: string;
      operation: 0;
      signatureBytes: 130;
      signatureCount: 2;
      terminalEvent: 'EscalationExecuted' | 'EscalationCancelled';
      terminalEventCount: 1;
      etherscanUrl: string;
    };
  };
  attestation: LiveDecisionAttestation;
};

export function isLiveReleaseEvidenceV1(value: unknown): value is LiveReleaseEvidenceV1 {
  if (!value || typeof value !== 'object') return false;
  const evidence = value as Partial<LiveReleaseEvidenceV1>;
  const action = evidence.decision?.action;
  const expectedState = action === 'approve' ? 2 : action === 'reject' ? 5 : undefined;
  const expectedModuleAction = action === 'approve' ? 'executeEscalated' : 'cancelEscalated';
  const expectedTerminalEvent = action === 'approve' ? 'EscalationExecuted' : 'EscalationCancelled';
  return evidence.schema === 'veilguard.live-release-evidence'
    && evidence.version === 1
    && evidence.chain?.id === 11155111
    && evidence.chain.network === 'ethereum-sepolia'
    && evidence.chain.safeThreshold === 2
    && evidence.chain.safeOwnerCount === 2
    && evidence.scenario?.name === 'ShieldOps'
    && (evidence.decision?.action === 'approve' || evidence.decision?.action === 'reject')
    && evidence.decision.origin === 'user'
    && evidence.decision.chainState === expectedState
    && /^0x[0-9a-f]{64}$/i.test(evidence.decision.transactionHash ?? '')
    && evidence.attestation?.hash?.toLowerCase() === evidence.decision.transactionHash.toLowerCase()
    && evidence.attestation.action === evidence.decision.action
    && evidence.attestation.origin === 'user'
    && evidence.attestation.chainState === expectedState
    && String(evidence.attestation.requestId) === evidence.scenario?.requestId
    && evidence.transactions?.safeDecision.hash?.toLowerCase() === evidence.decision.transactionHash.toLowerCase()
    && evidence.transactions.safeDecision.status === 'success'
    && evidence.transactions.safeDecision.outerTarget.toLowerCase() === evidence.chain.safe.toLowerCase()
    && evidence.transactions.safeDecision.moduleTarget.toLowerCase() === evidence.chain.module.toLowerCase()
    && evidence.transactions.safeDecision.requestId === evidence.scenario?.requestId
    && evidence.transactions.safeDecision.moduleAction === expectedModuleAction
    && evidence.transactions.safeDecision.terminalEvent === expectedTerminalEvent
    && evidence.transactions.safeDecision.operation === 0
    && evidence.transactions.safeDecision.signatureBytes === 130
    && evidence.transactions.safeDecision.signatureCount === 2
    && evidence.transactions.safeDecision.terminalEventCount === 1
    && evidence.transactions.request.status === 'success'
    && evidence.transactions.teeFinalize.status === 'success'
    && evidence.transactions.teeFinalize.terminalEvent === 'EscalationReady';
}
