/**
 * FINAL EVIDENCE RUN — one clean pass over the fixed v1.0 deployment that
 * freezes every transaction hash judges need, with REAL 2-of-2 Safe multisig
 * (Protocol Kit + API Kit via the Safe Transaction Service) for every
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
import { createWalletClient, encodeFunctionData, http, padHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { createViemHandleClient } from '@iexec-nox/handle';
import { safeMultisig, env, RPC } from './safe-lib.js';

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
  const rc = await publicClient.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error(`${label} reverted: ${hash}`);
  console.log(`  ${label}: ${hash}`);
  return hash as string;
};
const getRequest = async (id: bigint) => (await publicClient.readContract({
  address: MODULE, abi: moduleAbi, functionName: 'getRequest', args: [id],
})) as any[];

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

// REUSE_MANDATE / REUSE_ACTIVATION_TX let us reuse a mandate already activated by
// a real 2-of-2 multisig (saves gas + avoids re-running the proven multisig).
const reuseId = env('REUSE_MANDATE');
let mandateId: bigint;
let proposeTx: string;
let activation: any;

if (reuseId) {
  mandateId = BigInt(reuseId);
  await waitMandateActive(mandateId);
  proposeTx = env('REUSE_PROPOSE_TX') ?? 'reused';
  activation = {
    safeTxHash: env('REUSE_ACTIVATION_SAFETX') ?? 'reused',
    executeTxHash: env('REUSE_ACTIVATION_TX') ?? 'reused',
    nonce: 0, confirmations: 2, threshold: 2,
  };
  console.log(`[1-2] reusing mandate #${mandateId} (already activated by 2-of-2 ${activation.executeTxHash})`);
} else {
  console.log('[1] admin proposes encrypted mandate (40 / 500 / 300)');
  const [l, b, f] = await Promise.all([
    adminClient.encryptInput(usdc(40), 'uint256', MODULE),
    adminClient.encryptInput(usdc(500), 'uint256', MODULE),
    adminClient.encryptInput(usdc(300), 'uint256', MODULE),
  ]);
  const now = BigInt(Math.floor(Date.now() / 1000));
  proposeTx = await send('proposeMandate', admin, {
    address: MODULE, abi: moduleAbi, functionName: 'proposeMandate',
    args: [delegate.account.address, 0n, now + 86_400n * 60n, [deployer.account.address],
      l.handle, l.handleProof, b.handle, b.handleProof, f.handle, f.handleProof],
  });
  mandateId = ((await publicClient.readContract({
    address: MODULE, abi: moduleAbi, functionName: 'nextMandateId',
  })) as bigint) - 1n;
  console.log(`[2] Safe 2-of-2 activates mandate #${mandateId}`);
  activation = await safeMultisig(
    SAFE, MODULE,
    encodeFunctionData({ abi: moduleAbi, functionName: 'activateMandate', args: [mandateId] }),
    keys,
  );
  await waitMandateActive(mandateId);
}

// helper: request + finalize
const delegateClient = await clientFor(delegate);
const spend = async (n: number, memo: string) => {
  const enc = await delegateClient.encryptInput(usdc(n), 'uint256', MODULE);
  const requestTx = await send(`requestSpend ${n}`, delegate, {
    address: MODULE, abi: moduleAbi, functionName: 'requestSpend',
    args: [mandateId, deployer.account.address, enc.handle, enc.handleProof,
      padHex(memo as `0x${string}`, { size: 32 })],
  });
  const id = ((await publicClient.readContract({
    address: MODULE, abi: moduleAbi, functionName: 'nextRequestId',
  })) as bigint) - 1n;
  const r = await getRequest(id);
  const tee = await waitResolved([r[7]]);
  const { value: decision, decryptionProof } = await delegateClient.publicDecrypt(r[7]);
  const finalizeTx = await send('finalize', deployer, {
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
const approval = await safeMultisig(
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
const packetTx = await send('createAuditPacket', admin, {
  address: MODULE, abi: moduleAbi, functionName: 'createAuditPacket',
  args: [env('DEMO_AUDITOR_ADDR'), mandateId, [within.id, escalated.id, blocked.id]],
});
const packetId = ((await publicClient.readContract({
  address: MODULE, abi: moduleAbi, functionName: 'nextPacketId',
})) as bigint) - 1n;
const packet = (await publicClient.readContract({
  address: MODULE, abi: moduleAbi, functionName: 'getAuditPacket', args: [packetId],
})) as any[];
const snaps: `0x${string}`[] = packet[6];
await waitResolved(snaps);
const auditor = wallet('DEMO_AUDITOR_KEY');
const auditorClient = await clientFor(auditor);
const vals: number[] = [];
for (const s of snaps) vals.push(Number((await auditorClient.decrypt(s)).value));
console.log(`  auditor decrypts [limit,budget,floor, amt/reason ×3] = ${vals.map((v, i) => (i < 3 || i % 2 === 1 ? v / 1e6 : v)).join(', ')}`);

// 7. freeze evidence
evidence.mandate = { id: Number(mandateId), proposeTx, activation };
evidence.requests = {
  within: { id: Number(within.id), requestTx: within.requestTx, finalizeTx: within.finalizeTx },
  escalated: { id: Number(escalated.id), requestTx: escalated.requestTx, finalizeTx: escalated.finalizeTx, approval },
  blocked: { id: Number(blocked.id), requestTx: blocked.requestTx, finalizeTx: blocked.finalizeTx },
};
evidence.packet = { id: Number(packetId), createTx: packetTx, requestIds: [Number(within.id), Number(escalated.id), Number(blocked.id)] };
writeFileSync(new URL('../app/src/demo-evidence.json', import.meta.url), JSON.stringify(evidence, null, 2));
console.log('\n✅ evidence frozen → app/src/demo-evidence.json');
process.exit(0);
