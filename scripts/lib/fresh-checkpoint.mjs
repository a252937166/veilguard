import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';

export const FRESH_CHECKPOINT_VERSION = 1;

const normalizeAddress = (value) => String(value ?? '').toLowerCase();

export function freshDeploymentIdentity({ chainId, module, safe }) {
  if (!Number.isInteger(Number(chainId)) || Number(chainId) <= 0) {
    throw new Error('fresh checkpoint requires a valid chainId');
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(module))) {
    throw new Error('fresh checkpoint requires a valid module address');
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(safe))) {
    throw new Error('fresh checkpoint requires a valid Safe address');
  }
  return Object.freeze({
    chainId: Number(chainId),
    module: normalizeAddress(module),
    safe: normalizeAddress(safe),
  });
}

export function checkpointPath(value = process.env.FRESH_RUN_CHECKPOINT_PATH) {
  return resolve(value || '.fresh-run-checkpoint.json');
}

export function newFreshCheckpoint(identity) {
  return {
    version: FRESH_CHECKPOINT_VERSION,
    deployment: freshDeploymentIdentity(identity),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stages: {},
    values: {},
  };
}

function assertIdentity(checkpoint, identity) {
  const expected = freshDeploymentIdentity(identity);
  const actual = checkpoint?.deployment;
  if (
    checkpoint?.version !== FRESH_CHECKPOINT_VERSION
    || Number(actual?.chainId) !== expected.chainId
    || normalizeAddress(actual?.module) !== expected.module
    || normalizeAddress(actual?.safe) !== expected.safe
  ) {
    throw new Error(
      'fresh checkpoint belongs to a different deployment; use an isolated '
      + 'FRESH_RUN_CHECKPOINT_PATH and do not overwrite recovery evidence',
    );
  }
}

export function loadFreshCheckpoint(path, identity, { create = true } = {}) {
  if (!existsSync(path)) return create ? newFreshCheckpoint(identity) : null;
  let checkpoint;
  try {
    checkpoint = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('fresh checkpoint is unreadable; refusing to submit any transaction');
  }
  assertIdentity(checkpoint, identity);
  if (
    typeof checkpoint.stages !== 'object'
    || checkpoint.stages == null
    || typeof checkpoint.values !== 'object'
    || checkpoint.values == null
  ) {
    throw new Error('fresh checkpoint schema is invalid; refusing to submit any transaction');
  }
  return checkpoint;
}

export function saveFreshCheckpoint(path, checkpoint) {
  const next = {
    ...checkpoint,
    updatedAt: new Date().toISOString(),
  };
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
  return next;
}

export function checkpointValue(checkpoint, key) {
  return checkpoint.values[key];
}

export function setCheckpointValue(checkpoint, key, value) {
  return {
    ...checkpoint,
    values: {
      ...checkpoint.values,
      [key]: value,
    },
  };
}

export function checkpointStage(checkpoint, key) {
  return checkpoint.stages[key];
}

export function recordCheckpointBroadcast(checkpoint, key, hash) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(hash))) {
    throw new Error(`fresh checkpoint stage ${key} received an invalid transaction hash`);
  }
  const current = checkpointStage(checkpoint, key);
  if (current?.hash && String(current.hash).toLowerCase() !== String(hash).toLowerCase()) {
    throw new Error(
      `fresh checkpoint stage ${key} already tracks another transaction; refusing duplicate broadcast`,
    );
  }
  return {
    ...checkpoint,
    stages: {
      ...checkpoint.stages,
      [key]: {
        ...current,
        hash,
        status: 'broadcast',
        broadcastAt: current?.broadcastAt ?? new Date().toISOString(),
      },
    },
  };
}

export function recordCheckpointReceipt(checkpoint, key, receipt, values = {}) {
  const current = checkpointStage(checkpoint, key);
  if (!current?.hash) {
    throw new Error(`fresh checkpoint stage ${key} cannot record a receipt before broadcast`);
  }
  if (String(receipt?.transactionHash).toLowerCase() !== String(current.hash).toLowerCase()) {
    throw new Error(`fresh checkpoint stage ${key} receipt hash does not match its broadcast`);
  }
  if (receipt?.status !== 'success') {
    throw new Error(`fresh checkpoint stage ${key} transaction reverted`);
  }
  return {
    ...checkpoint,
    stages: {
      ...checkpoint.stages,
      [key]: {
        ...current,
        status: 'success',
        blockNumber: String(receipt.blockNumber),
        confirmedAt: new Date().toISOString(),
        ...values,
      },
    },
  };
}

export function markCheckpointStage(checkpoint, key, values = {}) {
  const current = checkpointStage(checkpoint, key);
  return {
    ...checkpoint,
    stages: {
      ...checkpoint.stages,
      [key]: {
        ...current,
        ...values,
        status: values.status ?? current?.status ?? 'verified',
        verifiedAt: new Date().toISOString(),
      },
    },
  };
}
