/**
 * Sepolia smoke test — exercises the full VeilGuard loop against the REAL
 * Nox testnet infrastructure and leaves the evidence on-chain:
 *
 *   faucet TestUSDC → wrap 1000 cUSDC into the Safe → propose encrypted
 *   mandate (40/100/500) → Safe activates → delegate requests 25 →
 *   TEE decision → finalize with gateway proof → funds arrive.
 *
 * Also measures first real TEE latencies (feedback.md material).
 *
 * Run: npx hardhat run scripts/smoke-sepolia.ts --network sepolia
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
const { TestUSDC, ConfidentialUSDC, Safe, VeilGuardModule } = deployments.contracts;

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

/** SDK identity workaround: pin getAddresses to the wallet's own account. */
const clientFor = async (w: any) =>
  await createViemHandleClient({ ...w, getAddresses: async () => [w.account.address] });

const waitResolved = async (handles: string[], timeoutMs = 300_000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${GATEWAY}/v0/public/handles/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handles }),
      });
      if (res.ok) {
        const data = (await res.json()) as any;
        const map = new Map(
          data.payload.statuses.map((s: any) => [s.handle.toLowerCase(), s.resolved]),
        );
        if (handles.every((h) => map.get(h.toLowerCase()) === true)) return Date.now() - started;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`handles not resolved in ${timeoutMs}ms`);
};

const erc20Abi = [
  { type: 'function', name: 'faucet', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;
const wrapperAbi = [
  { type: 'function', name: 'wrap', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'confidentialBalanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bytes32' }] },
] as const;
const safeAbi = [
  { type: 'function', name: 'execTransaction', stateMutability: 'payable', inputs: [
    { type: 'address' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'uint8' },
    { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' },
    { type: 'address' }, { type: 'bytes' }], outputs: [{ type: 'bool' }] },
] as const;

const moduleArtifact = JSON.parse(
  readFileSync(
    new URL('../artifacts/contracts/VeilGuardModule.sol/VeilGuardModule.json', import.meta.url),
    'utf8',
  ),
);
const moduleAbi = moduleArtifact.abi;

const send = async (label: string, w: any, tx: any) => {
  const t0 = Date.now();
  const hash = await w.writeContract(tx);
  const rc = await publicClient.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error(`${label} reverted: ${hash}`);
  console.log(`  ${label}: ${hash} (+${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  return rc;
};

console.log('— VeilGuard Sepolia smoke —');

// 1. Treasury funding: faucet -> approve -> wrap into the Safe.
console.log('[1] fund treasury with 1000 cUSDC');
await send('faucet', admin, { address: TestUSDC, abi: erc20Abi, functionName: 'faucet', args: [usdc(1000)] });
await send('approve', admin, { address: TestUSDC, abi: erc20Abi, functionName: 'approve', args: [ConfidentialUSDC, usdc(1000)] });
await send('wrap→Safe', admin, { address: ConfidentialUSDC, abi: wrapperAbi, functionName: 'wrap', args: [Safe, usdc(1000)] });

const treasuryHandle = (await publicClient.readContract({
  address: ConfidentialUSDC, abi: wrapperAbi, functionName: 'confidentialBalanceOf', args: [Safe],
})) as `0x${string}`;
const tResolve = await waitResolved([treasuryHandle]);
console.log(`  treasury handle resolved in ${(tResolve / 1000).toFixed(1)}s`);

// 2. Encrypted mandate: autoLimit 40 / budget 100 / reserve 500.
console.log('[2] propose + activate encrypted mandate');
const adminClient = await clientFor(admin);
const encT0 = Date.now();
const [limit, budget, floor] = await Promise.all([
  adminClient.encryptInput(usdc(40), 'uint256', VeilGuardModule),
  adminClient.encryptInput(usdc(100), 'uint256', VeilGuardModule),
  adminClient.encryptInput(usdc(500), 'uint256', VeilGuardModule),
]);
console.log(`  3× encryptInput in ${((Date.now() - encT0) / 1000).toFixed(1)}s`);
const nowTs = BigInt(Math.floor(Date.now() / 1000));
await send('proposeMandate', admin, {
  address: VeilGuardModule, abi: moduleAbi, functionName: 'proposeMandate',
  args: [
    delegate.account.address, 0n, nowTs + 86_400n * 30n,
    [deployer.account.address], // vendor allow-list: the deployer plays the payee
    limit.handle, limit.handleProof,
    budget.handle, budget.handleProof,
    floor.handle, floor.handleProof,
  ],
});
const activateData = encodeFunctionData({
  abi: moduleAbi, functionName: 'activateMandate', args: [1n],
});
const preValidatedSig = encodePacked(
  ['bytes32', 'bytes32', 'uint8'],
  [padHex(admin.account.address, { size: 32 }), padHex('0x00', { size: 32 }), 1],
);
await send('Safe.activate', admin, {
  address: Safe, abi: safeAbi, functionName: 'execTransaction',
  args: [VeilGuardModule, 0n, activateData, 0, 0n, 0n, 0n,
    '0x0000000000000000000000000000000000000000',
    '0x0000000000000000000000000000000000000000', preValidatedSig],
});

// 3. Delegate spends 25 — within mandate.
console.log('[3] delegate requests 25 cUSDC (within mandate)');
const delegateClient = await clientFor(delegate);
const amount = await delegateClient.encryptInput(usdc(25), 'uint256', VeilGuardModule);
const reqT0 = Date.now();
await send('requestSpend', delegate, {
  address: VeilGuardModule, abi: moduleAbi, functionName: 'requestSpend',
  args: [1n, deployer.account.address, amount.handle, amount.handleProof,
    padHex('0x01', { size: 32 })],
});
const req = (await publicClient.readContract({
  address: VeilGuardModule, abi: moduleAbi, functionName: 'getRequest', args: [1n],
})) as any[];
const decisionHandle = req[7] as `0x${string}`;

const dResolve = await waitResolved([decisionHandle]);
console.log(`  decision handle resolved in ${(dResolve / 1000).toFixed(1)}s  ← full policy graph TEE latency`);

const { value: decision, decryptionProof } = await delegateClient.publicDecrypt(decisionHandle as any);
console.log(`  decision = ${decision} (1 = EXECUTE)`);
if (Number(decision) !== 1) throw new Error(`expected EXECUTE, got ${decision}`);

// 4. Finalize with the gateway proof (deployer = untrusted keeper).
console.log('[4] finalize with decryption proof');
await send('finalize', deployer, {
  address: VeilGuardModule, abi: moduleAbi, functionName: 'finalize',
  args: [1n, decryptionProof],
});
console.log(`  request state: ${(await publicClient.readContract({
  address: VeilGuardModule, abi: moduleAbi, functionName: 'getRequest', args: [1n],
}) as any[])[5]} (2 = Executed)`);

// 5. Payee decrypts their confidential balance.
console.log('[5] payee decrypts received amount');
const payeeBalHandle = (await publicClient.readContract({
  address: ConfidentialUSDC, abi: wrapperAbi, functionName: 'confidentialBalanceOf',
  args: [deployer.account.address],
})) as `0x${string}`;
await waitResolved([payeeBalHandle]);
const payeeClient = await clientFor(deployer);
const { value: received } = await payeeClient.decrypt(payeeBalHandle as any);
console.log(`  payee cUSDC balance = ${Number(received) / 1e6} (expect 25)`);
if (received !== usdc(25)) throw new Error('unexpected payee balance');

console.log(`\n✅ Sepolia smoke complete — full confidential loop live on-chain.`);
console.log(`   request #1: EXECUTE, 25 cUSDC, module ${VeilGuardModule}`);
process.exit(0);
