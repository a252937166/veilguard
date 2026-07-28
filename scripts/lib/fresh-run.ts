import type { Hash, TransactionReceipt } from 'viem';
import {
  checkpointPath,
  checkpointStage,
  checkpointValue,
  freshDeploymentIdentity,
  loadFreshCheckpoint,
  markCheckpointStage,
  recordCheckpointBroadcast,
  recordCheckpointReceipt,
  saveFreshCheckpoint,
  setCheckpointValue,
  type FreshCheckpoint,
} from './fresh-checkpoint.mjs';

type PublicClient = {
  waitForTransactionReceipt(input: { hash: Hash }): Promise<TransactionReceipt>;
};

type FreshRunControllerOptions = {
  publicClient: PublicClient;
  chainId: number;
  module: `0x${string}`;
  safe: `0x${string}`;
  path?: string;
  log?: (message: string) => void;
};

export type CheckpointedReceipt = {
  hash: Hash;
  receipt: TransactionReceipt;
  recovered: boolean;
};

export function createFreshRunController({
  publicClient,
  chainId,
  module,
  safe,
  path = checkpointPath(),
  log = console.log,
}: FreshRunControllerOptions) {
  const identity = freshDeploymentIdentity({ chainId, module, safe });
  let checkpoint = loadFreshCheckpoint(path, identity) as FreshCheckpoint;

  const persist = () => {
    checkpoint = saveFreshCheckpoint(path, checkpoint);
  };

  const value = <T>(key: string): T | undefined =>
    checkpointValue(checkpoint, key) as T | undefined;

  const setValue = (key: string, next: unknown) => {
    checkpoint = setCheckpointValue(checkpoint, key, next);
    persist();
  };

  const stage = (key: string) => checkpointStage(checkpoint, key);

  const markStage = (key: string, values: Record<string, unknown> = {}) => {
    checkpoint = markCheckpointStage(checkpoint, key, values);
    persist();
  };

  const transaction = async ({
    key,
    label,
    broadcast,
    receiptValues,
  }: {
    key: string;
    label: string;
    broadcast: () => Promise<Hash>;
    receiptValues?: (
      receipt: TransactionReceipt,
    ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  }): Promise<CheckpointedReceipt> => {
    let tracked = stage(key);
    let hash = tracked?.hash as Hash | undefined;
    const recovered = Boolean(hash);

    if (tracked && !hash) {
      throw new Error(
        `${label} checkpoint is in an ambiguous pre-broadcast state; `
        + 'refusing a possible duplicate transaction',
      );
    }
    if (!hash) {
      markStage(key, { status: 'preparing', label });
      hash = await broadcast();
      checkpoint = recordCheckpointBroadcast(checkpoint, key, hash);
      persist();
      log(`  ${label}: ${hash}`);
    } else {
      log(`  ${label}: recovering ${hash}`);
    }

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const values = receiptValues ? await receiptValues(receipt) : {};
    checkpoint = recordCheckpointReceipt(checkpoint, key, receipt, values);
    persist();
    return { hash, receipt, recovered };
  };

  const safeAction = async ({
    key,
    label,
    isComplete,
    execute,
  }: {
    key: string;
    label: string;
    isComplete: () => Promise<boolean>;
    execute: (onBroadcast: (hash: Hash) => void) => Promise<{ executeTxHash: string }>;
  }): Promise<void> => {
    let tracked = stage(key);
    if (tracked && !tracked.hash) {
      // A crash can occur after a Safe execution reaches chain state but
      // before its broadcast callback is persisted. Reconcile that exact
      // target state first; only an incomplete target remains ambiguous.
      if (await isComplete()) {
        markStage(key, {
          status: 'verified',
          recoveredFromChainState: true,
          reconciledAmbiguousCheckpoint: true,
        });
        return;
      }
      throw new Error(
        `${label} checkpoint is in an ambiguous pre-broadcast state; `
        + 'refusing a possible duplicate Safe execution',
      );
    }
    if (tracked?.hash) {
      const hash = tracked.hash as Hash;
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      checkpoint = recordCheckpointReceipt(checkpoint, key, receipt);
      persist();
      if (!await isComplete()) {
        throw new Error(`${label} receipt confirmed but target state was not reached`);
      }
      markStage(key, { status: 'verified', recoveredFromTrackedHash: true });
      return;
    }

    if (await isComplete()) {
      markStage(key, { status: 'verified', recoveredFromChainState: true });
      return;
    }

    markStage(key, { status: 'preparing', label });
    let callbackObserved = false;
    await execute((hash) => {
      callbackObserved = true;
      checkpoint = recordCheckpointBroadcast(checkpoint, key, hash);
      persist();
    });
    if (!callbackObserved) {
      throw new Error(`${label} did not expose its broadcast hash to the checkpoint`);
    }

    tracked = stage(key);
    if (!tracked?.hash) {
      throw new Error(`${label} checkpoint lost its broadcast hash`);
    }
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: tracked.hash as Hash,
    });
    checkpoint = recordCheckpointReceipt(checkpoint, key, receipt);
    persist();

    if (!await isComplete()) {
      throw new Error(`${label} transaction confirmed but target state was not reached`);
    } else {
      markStage(key, { status: 'verified' });
    }
  };

  return Object.freeze({
    path,
    identity,
    value,
    setValue,
    stage,
    markStage,
    transaction,
    safeAction,
  });
}
