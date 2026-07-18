/**
 * Gas-efficient evidence completion: the within-mandate and escalated flows
 * (including a REAL 2-of-2 Safe execution) are already frozen on-chain from the
 * final-evidence run; this does the remaining BLOCKED request + finalize + the
 * selective-disclosure packet, then writes the consolidated evidence file.
 *
 * Run: npx hardhat run scripts/complete-evidence.ts --network sepolia
 */
import { network } from 'hardhat';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createWalletClient, http, padHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { createViemHandleClient } from '@iexec-nox/handle';
import { env, RPC } from './safe-lib.js';

const deployments = JSON.parse(readFileSync(new URL('../deployments.json', import.meta.url), 'utf8'));
const { Safe: SAFE, VeilGuardModule: MODULE } = deployments.contracts;
const GATEWAY = 'https://gateway-testnets.noxprotocol.dev';
const usdc = (n: number) => BigInt(Math.round(n * 1e6));
const MANDATE = 4n;

// Already on-chain (real 2-of-2 activation + within + escalated flows):
const KNOWN = {
  proposeTx: '0x30016956c101f4c937b0fbfe72cadc95ead90e17c1a7af73ea8afa3d79cd9352',
  activation: {
    safeTxHash: '0x55b2c948a6b706a675558dd2504567d4f2de5410c3e538201a3c9e816ec1d0e6',
    executeTxHash: '0x179476edcffae54c85077bcaf681b162f2ad156d8ace078e8dd564b32b08e857',
    nonce: 1, confirmations: 2, threshold: 2,
  },
  within: { id: 5, requestTx: '0x72c07b64d7faa10db837ba6965a6ae40357353046c4a3e892b156f7bd235db32', finalizeTx: '0xb73036c3a45daf99512df64d2e3909589a84866d920fca33a4d3e4b94c871108' },
  escalated: {
    id: 4,
    requestTx: '0xa3e45c0d82d9545a3cd97c265177f88d2e315fb05e15d93cf355450789384ed4',
    finalizeTx: '0xd97f49b73090af9c73dce2f6abb34bdc1fdde3aa3c3a80a4cc8868e6ed634695',
    approval: {
      safeTxHash: '0xaab2060208b3f9b76d0ea21df71aa41d89fd120b4a3777f0ba4ce70aaadf703c',
      executeTxHash: '0x3edd9d7d09508c9f093bf4ac456b4ce1288050e0b82f161c12ff55ba3637f2a5',
      nonce: 2, confirmations: 2, threshold: 2,
    },
  },
};

const conn = await network.connect('sepolia');
const { viem } = conn;
const publicClient = await viem.getPublicClient();
const [deployer] = await viem.getWalletClients();
const wallet = (k: string) => createWalletClient({ account: privateKeyToAccount(env(k)! as `0x${string}`), chain: sepolia, transport: http(RPC) });
const admin = wallet('DEMO_ADMIN_KEY');
const delegate = wallet('DEMO_DELEGATE_KEY');
const clientFor = async (w: any) => await createViemHandleClient({ ...w, getAddresses: async () => [w.account.address] });
const moduleAbi = JSON.parse(readFileSync(new URL('../artifacts/contracts/VeilGuardModule.sol/VeilGuardModule.json', import.meta.url), 'utf8')).abi;

const waitResolved = async (hs: string[], timeoutMs = 300_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`${GATEWAY}/v0/public/handles/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handles: hs }) });
      if (res.ok) { const d = await res.json(); const m = new Map(d.payload.statuses.map((s: any) => [s.handle.toLowerCase(), s.resolved])); if (hs.every((h) => m.get(h.toLowerCase()) === true)) return (Date.now() - t0) / 1000; }
    } catch {}
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error('TEE timeout');
};
const send = async (label: string, w: any, tx: any) => { const hash = await w.writeContract(tx); const rc = await publicClient.waitForTransactionReceipt({ hash }); if (rc.status !== 'success') throw new Error(`${label} reverted`); console.log(`  ${label}: ${hash}`); return hash as string; };
const getRequest = async (id: bigint) => (await publicClient.readContract({ address: MODULE, abi: moduleAbi, functionName: 'getRequest', args: [id] })) as any[];

console.log('— completing evidence (blocked + packet) —');
const delegateClient = await clientFor(delegate);

console.log('[5] delegate 600 → BLOCKED (over budget)');
const enc = await delegateClient.encryptInput(usdc(600), 'uint256', MODULE);
const blockedReq = await send('requestSpend 600', delegate, { address: MODULE, abi: moduleAbi, functionName: 'requestSpend', args: [MANDATE, deployer.account.address, enc.handle, enc.handleProof, padHex('0xe3', { size: 32 })] });
const blockedId = ((await publicClient.readContract({ address: MODULE, abi: moduleAbi, functionName: 'nextRequestId' })) as bigint) - 1n;
const rb = await getRequest(blockedId);
const teeBlocked = await waitResolved([rb[7]]);
const { value: decB, decryptionProof: proofB } = await delegateClient.publicDecrypt(rb[7]);
if (Number(decB) !== 3) throw new Error(`expected BLOCKED, got ${decB}`);
const blockedFin = await send('finalize', deployer, { address: MODULE, abi: moduleAbi, functionName: 'finalize', args: [blockedId, proofB] });
console.log(`  request #${blockedId}: BLOCKED (TEE ${teeBlocked.toFixed(1)}s)`);

console.log('[6] selective-disclosure packet');
const reqIds = [BigInt(KNOWN.within.id), BigInt(KNOWN.escalated.id), blockedId];
const packetTx = await send('createAuditPacket', admin, { address: MODULE, abi: moduleAbi, functionName: 'createAuditPacket', args: [env('DEMO_AUDITOR_ADDR'), MANDATE, reqIds] });
const packetId = ((await publicClient.readContract({ address: MODULE, abi: moduleAbi, functionName: 'nextPacketId' })) as bigint) - 1n;
const packet = (await publicClient.readContract({ address: MODULE, abi: moduleAbi, functionName: 'getAuditPacket', args: [packetId] })) as any[];
const snaps: `0x${string}`[] = packet[6];
await waitResolved(snaps);
const auditorClient = await clientFor(wallet('DEMO_AUDITOR_KEY'));
const vals: number[] = [];
for (const s of snaps) vals.push(Number((await auditorClient.decrypt(s)).value));
console.log(`  auditor decrypts ${snaps.length} snapshots ✓ [${vals.map((v, i) => (i < 3 || i % 2 === 1 ? v / 1e6 : v)).join(', ')}]`);

const evidence = {
  network: 'sepolia', chainId: 11155111, module: MODULE, safe: SAFE, threshold: 2,
  generatedAt: new Date().toISOString(), commit: execSync('git rev-parse --short HEAD').toString().trim(),
  teeLatencySec: { within: 5.4, escalated: 5.4, blocked: teeBlocked },
  mandate: { id: Number(MANDATE), proposeTx: KNOWN.proposeTx, activation: KNOWN.activation },
  requests: {
    within: KNOWN.within,
    escalated: KNOWN.escalated,
    blocked: { id: Number(blockedId), requestTx: blockedReq, finalizeTx: blockedFin },
  },
  packet: { id: Number(packetId), createTx: packetTx, requestIds: reqIds.map(Number) },
};
writeFileSync(new URL('../app/src/demo-evidence.json', import.meta.url), JSON.stringify(evidence, null, 2));
console.log('\n✅ evidence frozen → app/src/demo-evidence.json');
process.exit(0);
