/**
 * Module v1.0 redeploy on the EXISTING Safe + treasury:
 *   1. deploy the fixed VeilGuardModule
 *   2. (threshold still 1) Safe: disable old module → enable new → raise threshold to 2
 *   3. verify and rewrite deployments.json
 *
 * After this script every governance action requires a REAL 2-of-2 Safe
 * multisig via the Transaction Service (see safe-lib.ts).
 *
 * Run: npx hardhat run scripts/redeploy-module.ts --network sepolia
 */
import { network } from 'hardhat';
import { readFileSync, writeFileSync } from 'node:fs';
import { createWalletClient, encodeFunctionData, encodePacked, http, padHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const env = (k: string) =>
  envText.split('\n').find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim();
const depPath = new URL('../deployments.json', import.meta.url);
const deployments = JSON.parse(readFileSync(depPath, 'utf8'));
const { Safe: SAFE, ConfidentialUSDC } = deployments.contracts;
const OLD_MODULE = deployments.contracts.VeilGuardModule as `0x${string}`;
const SENTINEL = '0x0000000000000000000000000000000000000001' as const;

const RPC = env('SEPOLIA_RPC_URL') ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const conn = await network.connect('sepolia');
const { viem } = conn;
const publicClient = await viem.getPublicClient();
const admin = createWalletClient({
  account: privateKeyToAccount(env('DEMO_ADMIN_KEY')! as `0x${string}`),
  chain: sepolia,
  transport: http(RPC),
});

const safeAbi = [
  { type: 'function', name: 'execTransaction', stateMutability: 'payable', inputs: [
    { type: 'address' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'uint8' },
    { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' },
    { type: 'address' }, { type: 'bytes' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'enableModule', stateMutability: 'nonpayable', inputs: [{ type: 'address' }], outputs: [] },
  { type: 'function', name: 'disableModule', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [] },
  { type: 'function', name: 'changeThreshold', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'getThreshold', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'isModuleEnabled', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] },
] as const;

const preSig = encodePacked(
  ['bytes32', 'bytes32', 'uint8'],
  [padHex(admin.account.address, { size: 32 }), padHex('0x00', { size: 32 }), 1],
);
const safeSelfCall = async (label: string, fn: string, args: unknown[]) => {
  const hash = await admin.writeContract({
    address: SAFE, abi: safeAbi, functionName: 'execTransaction',
    args: [SAFE, 0n, encodeFunctionData({ abi: safeAbi, functionName: fn as any, args: args as any }),
      0, 0n, 0n, 0n,
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000', preSig],
  });
  const rc = await publicClient.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error(`${label} reverted`);
  console.log(`  ${label}: ${hash}`);
};

const threshold = (await publicClient.readContract({
  address: SAFE, abi: safeAbi, functionName: 'getThreshold',
})) as bigint;
if (threshold !== 1n) throw new Error(`expected threshold 1 for migration, got ${threshold}`);

console.log('[1/3] deploy fixed VeilGuardModule…');
const module_ = await viem.deployContract('VeilGuardModule', [
  SAFE, ConfidentialUSDC, admin.account.address,
]);
console.log(`  new module: ${module_.address}`);

console.log('[2/3] Safe migration (still 1-of-2): swap modules, then raise threshold…');
await safeSelfCall('disable old module', 'disableModule', [SENTINEL, OLD_MODULE]);
await safeSelfCall('enable new module', 'enableModule', [module_.address]);
await safeSelfCall('threshold → 2', 'changeThreshold', [2n]);

console.log('[3/3] verify…');
const [oldOn, newOn, th] = await Promise.all([
  publicClient.readContract({ address: SAFE, abi: safeAbi, functionName: 'isModuleEnabled', args: [OLD_MODULE] }),
  publicClient.readContract({ address: SAFE, abi: safeAbi, functionName: 'isModuleEnabled', args: [module_.address] }),
  publicClient.readContract({ address: SAFE, abi: safeAbi, functionName: 'getThreshold' }),
]);
if (oldOn !== false || newOn !== true || th !== 2n) throw new Error(`verify failed: old=${oldOn} new=${newOn} th=${th}`);
console.log(`  old disabled ✓  new enabled ✓  threshold=2 ✓`);

deployments.contracts.VeilGuardModule = module_.address;
deployments.retired = { ...(deployments.retired ?? {}), moduleV09: OLD_MODULE };
deployments.safe.threshold = 2;
deployments.redeployedAt = new Date().toISOString();
writeFileSync(depPath, JSON.stringify(deployments, null, 2));
console.log('✅ deployments.json updated — governance now requires 2-of-2.');
process.exit(0);
