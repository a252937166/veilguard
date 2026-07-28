export type FreshDeploymentIdentity = Readonly<{
  chainId: number;
  module: string;
  safe: string;
}>;

export type FreshCheckpointStage = {
  hash?: `0x${string}`;
  status?: string;
  blockNumber?: string;
  [key: string]: unknown;
};

export type FreshCheckpoint = {
  version: number;
  deployment: FreshDeploymentIdentity;
  createdAt: string;
  updatedAt: string;
  stages: Record<string, FreshCheckpointStage>;
  values: Record<string, unknown>;
};

export declare const FRESH_CHECKPOINT_VERSION: 1;
export declare function freshDeploymentIdentity(input: {
  chainId: number | bigint;
  module: string;
  safe: string;
}): FreshDeploymentIdentity;
export declare function checkpointPath(value?: string): string;
export declare function newFreshCheckpoint(
  identity: FreshDeploymentIdentity,
): FreshCheckpoint;
export declare function loadFreshCheckpoint(
  path: string,
  identity: FreshDeploymentIdentity,
  options?: { create?: boolean },
): FreshCheckpoint | null;
export declare function saveFreshCheckpoint(
  path: string,
  checkpoint: FreshCheckpoint,
): FreshCheckpoint;
export declare function checkpointValue(
  checkpoint: FreshCheckpoint,
  key: string,
): unknown;
export declare function setCheckpointValue(
  checkpoint: FreshCheckpoint,
  key: string,
  value: unknown,
): FreshCheckpoint;
export declare function checkpointStage(
  checkpoint: FreshCheckpoint,
  key: string,
): FreshCheckpointStage | undefined;
export declare function recordCheckpointBroadcast(
  checkpoint: FreshCheckpoint,
  key: string,
  hash: `0x${string}`,
): FreshCheckpoint;
export declare function recordCheckpointReceipt(
  checkpoint: FreshCheckpoint,
  key: string,
  receipt: {
    transactionHash: `0x${string}`;
    status: string;
    blockNumber: bigint;
  },
  values?: Record<string, unknown>,
): FreshCheckpoint;
export declare function markCheckpointStage(
  checkpoint: FreshCheckpoint,
  key: string,
  values?: Record<string, unknown>,
): FreshCheckpoint;
