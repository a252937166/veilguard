import { encodeAbiParameters, keccak256 } from 'viem';

const normalizeAddress = (value) => String(value ?? '').toLowerCase();
const normalizeHex = (value) => String(value ?? '').toLowerCase();

function sameBigIntSequence(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => BigInt(value) === BigInt(expected[index]));
}

export function assertAuditPacketBinding({
  module,
  event,
  packet,
  auditor,
  mandateId,
  policyVersion,
  requestIds,
  expectedSnapshotCount = 3 + requestIds.length * 2,
}) {
  if (normalizeAddress(event?.address) !== normalizeAddress(module)) {
    throw new Error('AuditPacketCreated event came from an unexpected contract');
  }
  if (normalizeAddress(event?.args?.auditor) !== normalizeAddress(auditor)) {
    throw new Error('AuditPacketCreated auditor mismatch');
  }
  if (BigInt(event?.args?.mandateId) !== BigInt(mandateId)) {
    throw new Error('AuditPacketCreated mandate mismatch');
  }
  if (normalizeAddress(packet?.[0]) !== normalizeAddress(auditor)) {
    throw new Error('stored Audit Packet auditor mismatch');
  }
  if (BigInt(packet?.[1]) !== BigInt(mandateId)) {
    throw new Error('stored Audit Packet mandate mismatch');
  }
  if (BigInt(packet?.[2]) !== BigInt(policyVersion)) {
    throw new Error('stored Audit Packet policy version mismatch');
  }
  if (!sameBigIntSequence(packet?.[5], requestIds)) {
    throw new Error('stored Audit Packet request IDs mismatch');
  }
  const snapshots = [...(packet?.[6] ?? [])];
  if (snapshots.length !== expectedSnapshotCount) {
    throw new Error(
      `stored Audit Packet snapshot count mismatch: expected ${expectedSnapshotCount}, `
      + `got ${snapshots.length}`,
    );
  }
  const expectedManifest = keccak256(encodeAbiParameters(
    [
      { name: 'auditor', type: 'address' },
      { name: 'mandateId', type: 'uint256' },
      { name: 'policyVersion', type: 'uint32' },
      { name: 'requestIds', type: 'uint256[]' },
      { name: 'snapshotHandles', type: 'bytes32[]' },
    ],
    [auditor, BigInt(mandateId), Number(policyVersion), requestIds.map(BigInt), snapshots],
  ));
  const eventManifest = normalizeHex(event?.args?.manifestHash);
  const storedManifest = normalizeHex(packet?.[3]);
  if (eventManifest !== storedManifest || storedManifest !== normalizeHex(expectedManifest)) {
    throw new Error('Audit Packet manifest does not bind event, storage and ABI payload');
  }
  return Object.freeze({
    manifestHash: expectedManifest,
    requestIds: Object.freeze(requestIds.map(BigInt)),
    snapshots: Object.freeze(snapshots),
  });
}
