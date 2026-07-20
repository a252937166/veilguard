import { readFile } from 'node:fs/promises';

const deployments = JSON.parse(await readFile(new URL('../../app/src/deployments.json', import.meta.url), 'utf8'));
const canonicalModule = deployments.contracts.VeilGuardModule.toLowerCase();
const canonicalSafe = deployments.contracts.Safe.toLowerCase();

export function validateReleaseEvidence(value) {
  const errors = [];
  const action = value?.decision?.action;
  const semantics = action === 'approve'
    ? { state: 2, moduleAction: 'executeEscalated', terminalEvent: 'EscalationExecuted' }
    : action === 'reject'
      ? { state: 5, moduleAction: 'cancelEscalated', terminalEvent: 'EscalationCancelled' }
      : null;
  const sameHex = (left, right) => typeof left === 'string'
    && typeof right === 'string'
    && left.toLowerCase() === right.toLowerCase();
  if (value?.schema !== 'veilguard.live-release-evidence' || value?.version !== 1) errors.push('schema/version');
  if (!semantics) errors.push('decision.action');
  if (value?.decision?.origin !== 'user') errors.push('decision.origin');
  if (semantics && value?.decision?.chainState !== semantics.state) errors.push('decision.chainState');
  if (value?.chain?.id !== 11155111
    || value?.chain?.network !== 'ethereum-sepolia'
    || value?.chain?.safeThreshold !== 2
    || value?.chain?.safeOwnerCount !== 2) errors.push('chain/Safe');
  if (value?.chain?.module?.toLowerCase?.() !== canonicalModule
    || value?.chain?.safe?.toLowerCase?.() !== canonicalSafe) errors.push('canonical deployment');
  if (value?.scenario?.name !== 'ShieldOps') errors.push('scenario.name');
  if (!/^0x[0-9a-f]{64}$/i.test(value?.decision?.transactionHash ?? '')) errors.push('decision hash');
  if (!sameHex(value?.attestation?.hash, value?.decision?.transactionHash)
    || value?.attestation?.action !== value?.decision?.action
    || value?.attestation?.origin !== 'user'
    || value?.attestation?.chainState !== semantics?.state
    || String(value?.attestation?.requestId) !== value?.scenario?.requestId) errors.push('attestation');
  const safeTx = value?.transactions?.safeDecision;
  if (!sameHex(safeTx?.hash, value?.decision?.transactionHash) || safeTx?.status !== 'success') errors.push('Safe receipt');
  if (safeTx?.outerTarget?.toLowerCase?.() !== value?.chain?.safe?.toLowerCase?.()
    || safeTx?.moduleTarget?.toLowerCase?.() !== value?.chain?.module?.toLowerCase?.()) errors.push('Safe targets');
  if (safeTx?.requestId !== value?.scenario?.requestId
    || safeTx?.moduleAction !== semantics?.moduleAction
    || safeTx?.terminalEvent !== semantics?.terminalEvent
    || safeTx?.operation !== 0
    || safeTx?.signatureBytes !== 130
    || safeTx?.signatureCount !== 2
    || safeTx?.terminalEventCount !== 1) errors.push('Safe calldata/event');
  if (value?.transactions?.request?.status !== 'success'
    || value?.transactions?.teeFinalize?.status !== 'success'
    || value?.transactions?.teeFinalize?.terminalEvent !== 'EscalationReady') errors.push('request/finalize receipts');
  if (!value?.production?.expectedUiSha
    || value.production.expectedUiSha !== value.production.observedUiSha
    || !String(value?.workflow?.sourceCommit ?? '').startsWith(value.production.expectedUiSha)) errors.push('production UI SHA');
  return errors;
}
