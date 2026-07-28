/**
 * FINAL EVIDENCE RUN — one clean pass over the fixed v1.0 deployment that
 * freezes every transaction hash judges need, with REAL 2-of-2 Safe multisig
 * (two distinct owner EIP-712 signatures, executed on-chain — no Transaction Service) for every
 * governance action.
 *
 *   1. admin proposes an encrypted mandate (autoLimit 40 / budget 500 / floor 300)
 *   2. Safe 2-of-2 multisig ACTIVATES it            → safeTxHash + exec tx
 *   3. delegate 25  → WITHIN MANDATE → finalize → paid
 *   4. delegate 60  → APPROVAL REQUIRED → finalize → Safe 2-of-2 executes
 *   5. delegate 600 → BLOCKED (budget) → finalize → private reason
 *   6. selective-disclosure packet over the three requests → auditor decrypts
 *   7. writes app/src/demo-evidence.json (single source for UI/README/tour)
 *
 * Run: npx hardhat run scripts/final-evidence.ts --network sepolia
 */
import { network } from 'hardhat';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  keccak256,
  padHex,
  parseEventLogs,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { createViemHandleClient } from '@iexec-nox/handle';
import { safeExec2of2, env, RPC } from './safe-lib.js';

const deployments = JSON.parse(readFileSync(new URL('../deployments.json', import.meta.url), 'utf8'));
const { ConfidentialUSDC, Safe: SAFE, VeilGuardModule: MODULE } = deployments.contracts;
const GATEWAY = 'https://gateway-testnets.noxprotocol.dev';
const usdc = (n: number) => BigInt(Math.round(n * 1e6));

const conn = await network.connect('sepolia');
const { viem } = conn;
const publicClient = await viem.getPublicClient();
const [deployer] = await viem.getWalletClients();

const wallet = (k: string) => createWalletClient({
  account: privateKeyToAccount(env(k)! as `0x${string}`), chain: sepolia, transport: http(RPC),
});
const admin = wallet('DEMO_ADMIN_KEY');
const delegate = wallet('DEMO_DELEGATE_KEY');
const clientFor = async (w: any) =>
  await createViemHandleClient({ ...w, getAddresses: async () => [w.account.address] });

const moduleAbi = JSON.parse(readFileSync(
  new URL('../artifacts/contracts/VeilGuardModule.sol/VeilGuardModule.json', import.meta.url), 'utf8',
)).abi;

const waitResolved = async (handles: string[], timeoutMs = 300_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`${GATEWAY}/v0/public/handles/status`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handles }),
      });
      if (res.ok) {
        const d = await res.json();
        const m = new Map(d.payload.statuses.map((s: any) => [s.handle.toLowerCase(), s.resolved]));
        if (handles.every((h) => m.get(h.toLowerCase()) === true)) return (Date.now() - t0) / 1000;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error('TEE resolution timeout');
};

const send = async (label: string, w: any, tx: any) => {
  const hash = await w.writeContract(tx);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${label} reverted: ${hash}`);
  console.log(`  ${label}: ${hash}`);
  return { hash: hash as `0x${string}`, receipt };
};
const getRequest = async (id: bigint) => (await publicClient.readContract({
  address: MODULE, abi: moduleAbi, functionName: 'getRequest', args: [id],
})) as any[];
const assertBigIntEqual = (label: string, actual: unknown, expected: bigint) => {
  const normalized = BigInt(actual as bigint | number | string);
  if (normalized !== expected) {
    throw new Error(`${label} mismatch: expected ${expected}, got ${normalized}`);
  }
};
const assertBigIntSequence = (
  label: string,
  actual: readonly unknown[],
  expected: readonly bigint[],
) => {
  if (actual.length !== expected.length) {
    throw new Error(`${label} length mismatch: expected ${expected.length}, got ${actual.length}`);
  }
  for (let i = 0; i < expected.length; i++) {
    assertBigIntEqual(`${label}[${i}]`, actual[i], expected[i]);
  }
};
const assertAddressEqual = (label: string, actual: string, expected: string) => {
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`${label} mismatch: expected ${expected}, got ${actual}`);
  }
};
const assertHexEqual = (label: string, actual: string, expected: string) => {
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`${label} mismatch: expected ${expected}, got ${actual}`);
  }
};
type ModuleEventName = 'MandateProposed' | 'SpendRequested' | 'AuditPacketCreated';
const requireSingleModuleEvent = (
  label: string,
  receipt: Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>>,
  eventName: ModuleEventName,
) => {
  const events = parseEventLogs({
    abi: moduleAbi,
    logs: receipt.logs,
    eventName,
    strict: true,
  });
  if (events.length !== 1) {
    throw new Error(`${label} expected exactly one ${eventName} event, got ${events.length}`);
  }
  const event = events[0] as any;
  assertAddressEqual(`${eventName} event address`, String(event.address), MODULE);
  return event;
};

/** Guard against public-RPC read-after-write lag: poll until the mandate is Active. */
const waitMandateActive = async (id: bigint, timeoutMs = 60_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const m = (await publicClient.readContract({
      address: MODULE, abi: moduleAbi, functionName: 'getMandate', args: [id],
    })) as any[];
    if (Number(m[4]) === 2) return;
    await new Promise((r) => setTimeout(r, 2500));
  }
  throw new Error(`mandate #${id} not Active after activation`);
};

const keys = { ownerAKey: env('DEMO_ADMIN_KEY')!, ownerBKey: env('DEMO_SIGNER_B_KEY')! };
const evidence: any = {
  network: 'sepolia', chainId: 11155111,
  module: MODULE, safe: SAFE, threshold: 2,
  generatedAt: new Date().toISOString(),
  commit: execSync('git rev-parse --short HEAD').toString().trim(),
  teeLatencySec: {},
};

console.log('— FINAL EVIDENCE RUN (2-of-2 governance) —');
const adminClient = await clientFor(admin);

console.log('[1] admin proposes encrypted mandate (40 / 500 / 300)');
const [l, b, f] = await Promise.all([
  adminClient.encryptInput(usdc(40), 'uint256', MODULE),
  adminClient.encryptInput(usdc(500), 'uint256', MODULE),
  adminClient.encryptInput(usdc(300), 'uint256', MODULE),
]);
const now = BigInt(Math.floor(Date.now() / 1000));
const { hash: proposeTx, receipt: proposeReceipt } = await send('proposeMandate', admin, {
  address: MODULE, abi: moduleAbi, functionName: 'proposeMandate',
  args: [delegate.account.address, 0n, now + 86_400n * 60n, [deployer.account.address],
    l.handle, l.handleProof, b.handle, b.handleProof, f.handle, f.handleProof],
});
const mandateProposedEvent = requireSingleModuleEvent(
  'proposeMandate receipt',
  proposeReceipt,
  'MandateProposed',
);
const mandateId = BigInt(mandateProposedEvent.args.mandateId);
if (mandateId <= 0n) throw new Error(`MandateProposed emitted invalid mandateId ${mandateId}`);
assertAddressEqual(
  'MandateProposed.delegate',
  String(mandateProposedEvent.args.delegate),
  delegate.account.address,
);
assertBigIntEqual('MandateProposed.version', mandateProposedEvent.args.version, mandateId);
console.log(`[2] Safe 2-of-2 activates mandate #${mandateId}`);
const activation = await safeExec2of2(
  SAFE, MODULE,
  encodeFunctionData({ abi: moduleAbi, functionName: 'activateMandate', args: [mandateId] }),
  keys,
);
await waitMandateActive(mandateId);

// helper: request + finalize
const delegateClient = await clientFor(delegate);
const spend = async (n: number, memo: string) => {
  const enc = await delegateClient.encryptInput(usdc(n), 'uint256', MODULE);
  const { hash: requestTx, receipt: requestReceipt } = await send(`requestSpend ${n}`, delegate, {
    address: MODULE, abi: moduleAbi, functionName: 'requestSpend',
    args: [mandateId, deployer.account.address, enc.handle, enc.handleProof,
      padHex(memo as `0x${string}`, { size: 32 })],
  });
  const spendRequestedEvent = requireSingleModuleEvent(
    `requestSpend ${n} receipt`,
    requestReceipt,
    'SpendRequested',
  );
  const id = BigInt(spendRequestedEvent.args.requestId);
  if (id <= 0n) throw new Error(`SpendRequested emitted invalid requestId ${id}`);
  assertBigIntEqual('SpendRequested.mandateId', spendRequestedEvent.args.mandateId, mandateId);
  assertAddressEqual(
    'SpendRequested.delegate',
    String(spendRequestedEvent.args.delegate),
    delegate.account.address,
  );
  assertAddressEqual(
    'SpendRequested.recipient',
    String(spendRequestedEvent.args.recipient),
    deployer.account.address,
  );
  const r = await getRequest(id);
  assertBigIntEqual('request.mandateId', r[0], mandateId);
  assertAddressEqual('request.delegate', String(r[1]), delegate.account.address);
  assertAddressEqual('request.recipient', String(r[2]), deployer.account.address);
  assertHexEqual(
    'SpendRequested.decisionHandle',
    String(spendRequestedEvent.args.decisionHandle),
    String(r[7]),
  );
  const tee = await waitResolved([r[7]]);
  const { value: decision, decryptionProof } = await delegateClient.publicDecrypt(r[7]);
  const { hash: finalizeTx } = await send('finalize', deployer, {
    address: MODULE, abi: moduleAbi, functionName: 'finalize', args: [id, decryptionProof],
  });
  console.log(`  request #${id}: decision=${decision} (TEE ${tee.toFixed(1)}s)`);
  return { id, decision: Number(decision), requestTx, finalizeTx, tee };
};

// 3. within
console.log('[3] delegate 25 → WITHIN MANDATE');
const within = await spend(25, '0xe1');
if (within.decision !== 1) throw new Error(`expected EXECUTE, got ${within.decision}`);
evidence.teeLatencySec.within = within.tee;

// 4. escalate + 2-of-2 execution
console.log('[4] delegate 60 → APPROVAL REQUIRED → Safe 2-of-2 approves');
const escalated = await spend(60, '0xe2');
if (escalated.decision !== 2) throw new Error(`expected ESCALATE, got ${escalated.decision}`);
evidence.teeLatencySec.escalated = escalated.tee;
const approval = await safeExec2of2(
  SAFE, MODULE,
  encodeFunctionData({ abi: moduleAbi, functionName: 'executeEscalated', args: [escalated.id] }),
  keys,
);
// guard against public-RPC read-after-write lag
const t0 = Date.now();
while (Date.now() - t0 < 60_000) {
  if (Number((await getRequest(escalated.id))[5]) === 2) break;
  await new Promise((r) => setTimeout(r, 2500));
}
if (Number((await getRequest(escalated.id))[5]) !== 2) throw new Error('escalation not executed');

// 5. blocked
console.log('[5] delegate 600 → BLOCKED (over budget)');
const blocked = await spend(600, '0xe3');
if (blocked.decision !== 3) throw new Error(`expected BLOCKED, got ${blocked.decision}`);
evidence.teeLatencySec.blocked = blocked.tee;

// 6. selective disclosure packet
console.log('[6] selective-disclosure packet for the auditor');
const auditor = wallet('DEMO_AUDITOR_KEY');
const auditorAddress = auditor.account.address;
const auditorClient = await clientFor(auditor);
const expectedRequestIds = [within.id, escalated.id, blocked.id] as const;
const { hash: packetTx, receipt: packetReceipt } = await send('createAuditPacket', admin, {
  address: MODULE, abi: moduleAbi, functionName: 'createAuditPacket',
  args: [auditorAddress, mandateId, expectedRequestIds],
});
const auditPacketCreatedEvent = requireSingleModuleEvent(
  'createAuditPacket receipt',
  packetReceipt,
  'AuditPacketCreated',
);
const packetId = BigInt(auditPacketCreatedEvent.args.packetId);
if (packetId <= 0n) throw new Error(`AuditPacketCreated emitted invalid packetId ${packetId}`);
assertAddressEqual(
  'AuditPacketCreated.auditor',
  String(auditPacketCreatedEvent.args.auditor),
  auditorAddress,
);
assertBigIntEqual('AuditPacketCreated.mandateId', auditPacketCreatedEvent.args.mandateId, mandateId);
const eventManifestHash = String(auditPacketCreatedEvent.args.manifestHash);
const packet = (await publicClient.readContract({
  address: MODULE, abi: moduleAbi, functionName: 'getAuditPacket', args: [packetId],
})) as any[];
const mandate = (await publicClient.readContract({
  address: MODULE, abi: moduleAbi, functionName: 'getMandate', args: [mandateId],
})) as any[];
const policyVersion = Number(mandate[3]);
const packetRequestIds = packet[5] as readonly bigint[];
const snaps = [...(packet[6] as readonly `0x${string}`[])];

// Fail closed on every public packet binding before attempting disclosure or
// writing demo-evidence.json. The request-state checks also ensure the IDs bound
// by this run's SpendRequested receipts still identify the expected terminal requests.
assertAddressEqual('packet auditor', String(packet[0]), auditorAddress);
assertBigIntEqual('packet mandateId', packet[1], mandateId);
assertBigIntEqual('packet policyVersion', packet[2], BigInt(policyVersion));
assertBigIntSequence('packet requestIds', packetRequestIds, expectedRequestIds);
assertHexEqual('packet manifest vs AuditPacketCreated', String(packet[3]), eventManifestHash);
if (snaps.length !== 3 + expectedRequestIds.length * 2) {
  throw new Error(`snapshot handle count mismatch: expected 9, got ${snaps.length}`);
}
for (const [index, expectedState] of [2n, 2n, 4n].entries()) {
  const request = await getRequest(expectedRequestIds[index]);
  assertBigIntEqual(`request[${index}].mandateId`, request[0], mandateId);
  assertBigIntEqual(`request[${index}].state`, request[5], expectedState);
}

// Solidity computes keccak256(abi.encode(address,uint256,uint32,uint256[],bytes32[])).
// viem's standard ABI encoder is byte-for-byte equivalent to abi.encode here.
const expectedManifestHash = keccak256(encodeAbiParameters(
  [
    { name: 'auditor', type: 'address' },
    { name: 'mandateId', type: 'uint256' },
    { name: 'policyVersion', type: 'uint32' },
    { name: 'requestIds', type: 'uint256[]' },
    { name: 'snapshotHandles', type: 'bytes32[]' },
  ],
  [auditorAddress, mandateId, policyVersion, expectedRequestIds, snaps],
));
if (eventManifestHash.toLowerCase() !== expectedManifestHash.toLowerCase()) {
  throw new Error(`packet manifest mismatch: expected ${expectedManifestHash}, got ${eventManifestHash}`);
}

await waitResolved(snaps);
const vals: bigint[] = [];
for (const s of snaps) vals.push(BigInt((await auditorClient.decrypt(s)).value));
const expectedSnapshotValues = [
  usdc(40),
  usdc(500) - usdc(25) - usdc(60),
  usdc(300),
  usdc(25), 0n,
  usdc(60), 0n,
  usdc(600), 1n,
] as const;
assertBigIntSequence('decrypted packet snapshots', vals, expectedSnapshotValues);
console.log(`  auditor decrypts [limit,budget,floor, amt/reason ×3] = ${vals.map((v, i) => (i < 3 || i % 2 === 1 ? Number(v) / 1e6 : v)).join(', ')}`);

// 7. freeze evidence
evidence.mandate = { id: Number(mandateId), proposeTx, activation };
evidence.requests = {
  within: { id: Number(within.id), requestTx: within.requestTx, finalizeTx: within.finalizeTx },
  escalated: { id: Number(escalated.id), requestTx: escalated.requestTx, finalizeTx: escalated.finalizeTx, approval },
  blocked: { id: Number(blocked.id), requestTx: blocked.requestTx, finalizeTx: blocked.finalizeTx },
};
evidence.packet = {
  id: Number(packetId),
  createTx: packetTx,
  auditor: auditorAddress,
  mandateId: Number(mandateId),
  policyVersion,
  manifestHash: eventManifestHash,
  requestIds: expectedRequestIds.map(Number),
  snapshotHandleCount: snaps.length,
};
writeFileSync(new URL('../app/src/demo-evidence.json', import.meta.url), JSON.stringify(evidence, null, 2));
console.log('\n✅ evidence frozen → app/src/demo-evidence.json');
process.exit(0);
