/**
 * Sepolia E2E — completes three-state coverage on the live testnet and leaves
 * the evidence on-chain (smoke-sepolia.ts already executed request #1):
 *
 *   A. escalate 60 → finalize → Safe CANCELS   (escrow refund + budget restore)
 *   B. escalate 60 → finalize → Safe EXECUTES  (payee receives)
 *   C. blocked 500 (over budget) → viewer-only reason + cooldown
 *   D. audit packet over all requests → auditor decrypts snapshots
 *
 * Run: npx hardhat run scripts/e2e-sepolia.ts --network sepolia
 */
import { network } from 'hardhat';
import { readFileSync } from 'node:fs';
import { createWalletClient, encodeFunctionData, encodePacked, http, padHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { createViemHandleClient } from '@iexec-nox/handle';

const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const env = (k: string) =>
  envText.split('\n').find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim();
const deployments = JSON.parse(
  readFileSync(new URL('../deployments.json', import.meta.url), 'utf8'),
);
const { ConfidentialUSDC, Safe, VeilGuardModule } = deployments.contracts;

const RPC = env('SEPOLIA_RPC_URL') ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const GATEWAY = 'https://gateway-testnets.noxprotocol.dev';
const usdc = (n: number) => BigInt(Math.round(n * 1e6));

const conn = await network.connect('sepolia');
const { viem } = conn;
const publicClient = await viem.getPublicClient();
const [deployer] = await viem.getWalletClients();

const wallet = (key: string) =>
  createWalletClient({
    account: privateKeyToAccount(env(key)! as `0x${string}`),
    chain: sepolia,
    transport: http(RPC),
  });
const admin = wallet('DEMO_ADMIN_KEY');
const delegate = wallet('DEMO_DELEGATE_KEY');
const auditor = wallet('DEMO_AUDITOR_KEY');

const clientFor = async (w: any) =>
  await createViemHandleClient({ ...w, getAddresses: async () => [w.account.address] });

const waitResolved = async (handles: string[], timeoutMs = 300_000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${GATEWAY}/v0/public/handles/status`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handles }),
      });
      if (res.ok) {
        const data = (await res.json()) as any;
        const map = new Map(data.payload.statuses.map((s: any) => [s.handle.toLowerCase(), s.resolved]));
        if (handles.every((h) => map.get(h.toLowerCase()) === true)) return Date.now() - started;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`handles not resolved in ${timeoutMs}ms`);
};

const moduleAbi = JSON.parse(readFileSync(
  new URL('../artifacts/contracts/VeilGuardModule.sol/VeilGuardModule.json', import.meta.url), 'utf8',
)).abi;
const wrapperAbi = [
  { type: 'function', name: 'confidentialBalanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bytes32' }] },
] as const;
const safeAbi = [
  { type: 'function', name: 'execTransaction', stateMutability: 'payable', inputs: [
    { type: 'address' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'uint8' },
    { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' },
    { type: 'address' }, { type: 'bytes' }], outputs: [{ type: 'bool' }] },
] as const;

const send = async (label: string, w: any, tx: any) => {
  const hash = await w.writeContract(tx);
  const rc = await publicClient.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error(`${label} reverted: ${hash}`);
  console.log(`  ${label}: ${hash}`);
  return rc;
};

const preValidatedSig = encodePacked(
  ['bytes32', 'bytes32', 'uint8'],
  [padHex(admin.account.address, { size: 32 }), padHex('0x00', { size: 32 }), 1],
);
const safeCall = (fn: string, args: unknown[]) =>
  send(`Safe.${fn}`, admin, {
    address: Safe, abi: safeAbi, functionName: 'execTransaction',
    args: [VeilGuardModule, 0n,
      encodeFunctionData({ abi: moduleAbi, functionName: fn, args }),
      0, 0n, 0n, 0n,
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000', preValidatedSig],
  });

const getRequest = async (id: bigint) =>
  (await publicClient.readContract({
    address: VeilGuardModule, abi: moduleAbi, functionName: 'getRequest', args: [id],
  })) as any[];
const getMandate = async (id: bigint) =>
  (await publicClient.readContract({
    address: VeilGuardModule, abi: moduleAbi, functionName: 'getMandate', args: [id],
  })) as any[];

const delegateClient = await clientFor(delegate);
const adminClient = await clientFor(admin);
const auditorClient = await clientFor(auditor);

const requestSpend = async (n: number, memo: string) => {
  const enc = await delegateClient.encryptInput(usdc(n), 'uint256', VeilGuardModule);
  await send(`requestSpend ${n}`, delegate, {
    address: VeilGuardModule, abi: moduleAbi, functionName: 'requestSpend',
    args: [1n, deployer.account.address, enc.handle, enc.handleProof, padHex(memo as `0x${string}`, { size: 32 })],
  });
  const id = ((await publicClient.readContract({
    address: VeilGuardModule, abi: moduleAbi, functionName: 'nextRequestId',
  })) as bigint) - 1n;
  const req = await getRequest(id);
  const t = await waitResolved([req[7]]);
  const { value: decision, decryptionProof } = await delegateClient.publicDecrypt(req[7]);
  console.log(`  request #${id}: decision=${decision} (TEE ${(t / 1000).toFixed(1)}s)`);
  return { id, decision: Number(decision), decryptionProof };
};

const decryptBudget = async () => {
  const m = await getMandate(1n);
  await waitResolved([m[6]]);
  return Number((await adminClient.decrypt(m[6])).value) / 1e6;
};

console.log('— VeilGuard Sepolia E2E (three-state completion) —');
console.log(`budget before: ${await decryptBudget()} (expect 75 after smoke)`);

// A. Escalate then CANCEL
console.log('[A] escalate 60 → Safe cancels');
const a = await requestSpend(60, '0xa1');
if (a.decision !== 2) throw new Error(`expected ESCALATE, got ${a.decision}`);
await send('finalize', deployer, {
  address: VeilGuardModule, abi: moduleAbi, functionName: 'finalize', args: [a.id, a.decryptionProof],
});
await safeCall('cancelEscalated', [a.id]);
const aState = (await getRequest(a.id))[5];
if (aState !== 5) throw new Error(`expected Cancelled(5), got ${aState}`);
const budgetAfterCancel = await decryptBudget();
console.log(`  state=Cancelled ✓ budget restored: ${budgetAfterCancel} (expect 75)`);
if (budgetAfterCancel !== 75) throw new Error('budget not restored');

// B. Escalate then EXECUTE
console.log('[B] escalate 60 → Safe executes');
const b = await requestSpend(60, '0xb1');
if (b.decision !== 2) throw new Error(`expected ESCALATE, got ${b.decision}`);
await send('finalize', deployer, {
  address: VeilGuardModule, abi: moduleAbi, functionName: 'finalize', args: [b.id, b.decryptionProof],
});
await safeCall('executeEscalated', [b.id]);
const bState = (await getRequest(b.id))[5];
if (bState !== 2) throw new Error(`expected Executed(2), got ${bState}`);
console.log(`  state=Executed ✓ budget now: ${await decryptBudget()} (expect 15)`);

// Payee received 25 (smoke) + 60 = 85
const payeeBal = (await publicClient.readContract({
  address: ConfidentialUSDC, abi: wrapperAbi, functionName: 'confidentialBalanceOf',
  args: [deployer.account.address],
})) as `0x${string}`;
await waitResolved([payeeBal]);
const deployerClient = await clientFor(deployer);
const received = Number((await deployerClient.decrypt(payeeBal)).value) / 1e6;
console.log(`  payee total: ${received} (expect 85)`);
if (received !== 85) throw new Error('payee balance mismatch');

// C. Blocked over budget
console.log('[C] request 500 → BLOCKED (over budget), reason viewer-only');
const c = await requestSpend(500, '0xc1');
if (c.decision !== 3) throw new Error(`expected BLOCKED, got ${c.decision}`);
await send('finalize', deployer, {
  address: VeilGuardModule, abi: moduleAbi, functionName: 'finalize', args: [c.id, c.decryptionProof],
});
const cReq = await getRequest(c.id);
if (cReq[5] !== 4) throw new Error(`expected Blocked(4), got ${cReq[5]}`);
await waitResolved([cReq[8]]);
const reason = Number((await delegateClient.decrypt(cReq[8])).value);
console.log(`  state=Blocked ✓ delegate sees reason=${reason} (1=BUDGET) ✓ budget intact: ${await decryptBudget()}`);
if (reason !== 1) throw new Error(`expected reason BUDGET(1), got ${reason}`);

// D. Audit packet over everything
console.log('[D] audit packet → auditor decrypts snapshots');
await send('createAuditPacket', admin, {
  address: VeilGuardModule, abi: moduleAbi, functionName: 'createAuditPacket',
  args: [auditor.account.address, 1n, [1n, a.id, b.id, c.id]],
});
const packet = (await publicClient.readContract({
  address: VeilGuardModule, abi: moduleAbi, functionName: 'getAuditPacket', args: [1n],
})) as any[];
const snaps: `0x${string}`[] = packet[6];
await waitResolved(snaps);
const values = [];
for (const s of snaps) values.push(Number((await auditorClient.decrypt(s)).value) / 1e6);
console.log(`  snapshots [limit,budget,floor,amt1,amtA,amtB,amtC] = ${values.join(', ')}`);
const expected = [40, 15, 500, 25, 60, 60, 500];
if (JSON.stringify(values) !== JSON.stringify(expected))
  throw new Error(`snapshot mismatch: ${values}`);

console.log('\n✅ E2E complete — all three states + cancel + audit live on Sepolia.');
process.exit(0);
