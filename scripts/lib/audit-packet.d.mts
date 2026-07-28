export declare function assertAuditPacketBinding(input: {
  module: string;
  event: {
    address: string;
    args: {
      auditor: string;
      mandateId: bigint;
      manifestHash: string;
    };
  };
  packet: readonly unknown[];
  auditor: `0x${string}`;
  mandateId: bigint;
  policyVersion: number | bigint;
  requestIds: readonly bigint[];
  expectedSnapshotCount?: number;
}): Readonly<{
  manifestHash: `0x${string}`;
  requestIds: readonly bigint[];
  snapshots: readonly `0x${string}`[];
}>;
