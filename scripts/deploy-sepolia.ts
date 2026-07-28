/**
 * VeilGuard Sepolia deployment.
 *
 * Deploys: TestUSDC -> ConfidentialUSDCWrapper (official ERC-20→7984 wrapper)
 * -> real Safe v1.4.1 via the canonical proxy factory (hard-fails if the
 * canonical Safe contracts are missing — no stand-ins on a real network)
 * -> VeilGuardModule. Then funds the demo role accounts and enables the module
 * through two genuine owner EIP-712 signatures on an exact 2-of-2 Safe.
 *
 * Run: npx hardhat run scripts/deploy-sepolia.ts --network sepolia
 */
import { network } from 'hardhat';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  encodeFunctionData,
  formatEther,
  parseEther,
  parseEventLogs,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import {
  createFundingPlan,
  fundRoleToTarget,
  resolveRoleTargets,
} from './lib/fresh-funding.mjs';
import {
  checkpointPath,
  markCheckpointStage,
  newFreshCheckpoint,
  saveFreshCheckpoint,
} from './lib/fresh-checkpoint.mjs';
import { env, safeExec2of2 } from './safe-lib.js';

// Canonical Safe v1.4.1 deployment (same addresses on all chains).
const SAFE_FACTORY = '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67' as const;
const SAFE_SINGLETON_L1 = '0x41675C099F32341bf84BFc5382aF534df5C7461a' as const;
const SAFE_SINGLETON_L2 = '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762' as const;
const SAFE_FALLBACK_HANDLER = '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99' as const;
// Role top-ups are calculated from their live balances. Keep a separate
// deployer reserve so target funding cannot consume the contract-deployment
// and Safe-setup gas budget.
const DEPLOY_GAS_RESERVE = parseEther('0.02');

const safeAbi = [
  { type: 'function', name: 'setup', stateMutability: 'nonpayable', inputs: [
    { name: '_owners', type: 'address[]' }, { name: '_threshold', type: 'uint256' },
    { name: 'to', type: 'address' }, { name: 'data', type: 'bytes' },
    { name: 'fallbackHandler', type: 'address' }, { name: 'paymentToken', type: 'address' },
    { name: 'payment', type: 'uint256' }, { name: 'paymentReceiver', type: 'address' },
  ], outputs: [] },
  { type: 'function', name: 'enableModule', stateMutability: 'nonpayable',
    inputs: [{ name: 'module', type: 'address' }], outputs: [] },
  { type: 'function', name: 'isModuleEnabled', stateMutability: 'view',
    inputs: [{ name: 'module', type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'getOwners', stateMutability: 'view', inputs: [],
    outputs: [{ type: 'address[]' }] },
  { type: 'function', name: 'getThreshold', stateMutability: 'view', inputs: [],
    outputs: [{ type: 'uint256' }] },
] as const;

const factoryAbi = [
  { type: 'function', name: 'createProxyWithNonce', stateMutability: 'nonpayable', inputs: [
    { name: '_singleton', type: 'address' }, { name: 'initializer', type: 'bytes' },
    { name: 'saltNonce', type: 'uint256' },
  ], outputs: [{ name: 'proxy', type: 'address' }] },
  { type: 'event', name: 'ProxyCreation', inputs: [
    { name: 'proxy', type: 'address', indexed: true },
    { name: 'singleton', type: 'address', indexed: false },
  ] },
] as const;

const conn = await network.connect('sepolia');
const { viem } = conn;
const publicClient = await viem.getPublicClient();
const [deployer] = await viem.getWalletClients();

const adminKey = env('DEMO_ADMIN_KEY')! as `0x${string}`;
const admin = privateKeyToAccount(adminKey);
const signerB = privateKeyToAccount(env('DEMO_SIGNER_B_KEY')! as `0x${string}`);
const delegate = privateKeyToAccount(env('DEMO_DELEGATE_KEY')! as `0x${string}`);
const auditor = privateKeyToAccount(env('DEMO_AUDITOR_KEY')! as `0x${string}`);
const roleTargetBalances = resolveRoleTargets(env);
const roleFundingTargets = [
  { role: 'admin', address: admin.address, targetBalance: roleTargetBalances.admin },
  { role: 'signerB', address: signerB.address, targetBalance: roleTargetBalances.signerB },
  { role: 'delegate', address: delegate.address, targetBalance: roleTargetBalances.delegate },
  { role: 'auditor', address: auditor.address, targetBalance: roleTargetBalances.auditor },
] as const;
const checkedInDeployments = JSON.parse(
  readFileSync(new URL('../deployments.json', import.meta.url), 'utf8'),
) as {
  safe?: { owners?: unknown[] };
  roles?: Record<string, unknown>;
};
const freshCheckpointPath = checkpointPath(env('FRESH_RUN_CHECKPOINT_PATH'));

// ------------------------------------------------------------ read-only preflight

// Every safety check in this section must remain before the first chain write.
// network.connect('sepolia') selects a config name; only the RPC response proves
// that the endpoint is actually Ethereum Sepolia.
const chainId = await publicClient.getChainId();
if (chainId !== sepolia.id) {
  throw new Error(`fresh deployment requires Sepolia (${sepolia.id}), got chain ${chainId}`);
}

const demoRoleAddresses = [admin, signerB, delegate, auditor]
  .map(({ address }) => address.toLowerCase());
if (new Set(demoRoleAddresses).size !== demoRoleAddresses.length) {
  throw new Error('fresh deployment requires four distinct demo role accounts');
}
const deployerAddress = deployer.account.address.toLowerCase();
if (demoRoleAddresses.includes(deployerAddress)) {
  throw new Error('fresh deployment requires every demo role account to differ from the deployer');
}

// A fresh reproduction must not silently reuse any privileged or test identity
// recorded by the checked-in deployment. Contract addresses are intentionally
// excluded: only Safe owners and role accounts define the identity boundary.
const checkedInIdentityValues = [
  ...(checkedInDeployments.safe?.owners ?? []),
  ...Object.values(checkedInDeployments.roles ?? {}),
];
const isAddress = (value: unknown): value is string =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
if (
  checkedInIdentityValues.length === 0
  || checkedInIdentityValues.some((value) => !isAddress(value))
) {
  throw new Error('checked-in deployment identity manifest is missing or invalid');
}
const checkedInIdentities = new Set(
  checkedInIdentityValues.filter(isAddress).map((address) => address.toLowerCase()),
);
if (demoRoleAddresses.some((address) => checkedInIdentities.has(address))) {
  throw new Error('fresh deployment demo roles must not reuse checked-in deployment identities');
}
if (existsSync(freshCheckpointPath)) {
  throw new Error(
    'fresh deployment checkpoint path already exists; use an isolated '
    + 'FRESH_RUN_CHECKPOINT_PATH and do not overwrite recovery evidence',
  );
}

// Safe is the integration target, so prove that its canonical factory and at
// least one supported singleton exist before deploying even the first token.
const factoryCode = await publicClient.getCode({ address: SAFE_FACTORY }).catch(() => undefined);
let singleton: `0x${string}` | undefined;
for (const candidate of [SAFE_SINGLETON_L1, SAFE_SINGLETON_L2]) {
  const code = await publicClient.getCode({ address: candidate }).catch(() => undefined);
  if (code && code !== '0x') {
    singleton = candidate;
    break;
  }
}
if (!factoryCode || factoryCode === '0x' || !singleton) {
  throw new Error('canonical Safe v1.4.1 factory/singleton not found on Sepolia; aborting before deployment');
}

console.log(`deployer: ${deployer.account.address}`);
const [balance, fundingPlan] = await Promise.all([
  publicClient.getBalance({ address: deployer.account.address }),
  createFundingPlan(
    [...roleFundingTargets],
    (address) => publicClient.getBalance({ address }),
  ),
]);
const minimumDeployerBalance = fundingPlan.totalTopUp + DEPLOY_GAS_RESERVE;
console.log(`balance:  ${formatEther(balance)} ETH`);
for (const role of fundingPlan.roles) {
  console.log(
    `  ${role.role} target ${formatEther(role.targetBalance)} ETH; `
    + `current ${formatEther(role.currentBalance)} ETH; `
    + `top-up ${formatEther(role.plannedTopUp)} ETH`,
  );
}

if (balance < minimumDeployerBalance) {
  throw new Error(
    `not enough Sepolia ETH: need at least ${formatEther(minimumDeployerBalance)} ETH; `
      + `${formatEther(fundingPlan.totalTopUp)} ETH is the current total role top-up `
      + `and ${formatEther(DEPLOY_GAS_RESERVE)} ETH is retained as deployment gas reserve`,
  );
}

// ---------------------------------------------------------------- contracts

console.log('\n[1/5] TestUSDC…');
const testUsdc = await viem.deployContract('TestUSDC');
console.log(`  TestUSDC: ${testUsdc.address}`);

console.log('[2/5] ConfidentialUSDCWrapper (cUSDC)…');
const cUsdc = await viem.deployContract('ConfidentialUSDCWrapper', [testUsdc.address]);
console.log(`  cUSDC: ${cUsdc.address}`);

// ---------------------------------------------------------------- Safe

console.log('[3/5] Safe…');
let safeAddress: `0x${string}`;
let safeKind: string;

{
  const initializer = encodeFunctionData({
    abi: safeAbi,
    functionName: 'setup',
    args: [
      [admin.address, signerB.address], 2n,
      '0x0000000000000000000000000000000000000000', '0x',
      SAFE_FALLBACK_HANDLER, '0x0000000000000000000000000000000000000000', 0n,
      '0x0000000000000000000000000000000000000000',
    ],
  });
  const hash = await deployer.writeContract({
    address: SAFE_FACTORY,
    abi: factoryAbi,
    functionName: 'createProxyWithNonce',
    args: [singleton, initializer, BigInt(Date.now())],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const [created] = parseEventLogs({ abi: factoryAbi, logs: receipt.logs, eventName: 'ProxyCreation' });
  safeAddress = created.args.proxy as `0x${string}`;
  safeKind = `safe-v1.4.1 (singleton ${singleton})`;
}
console.log(`  Safe: ${safeAddress} (${safeKind})`);

// ---------------------------------------------------------------- module

console.log('[4/5] VeilGuardModule…');
const module_ = await viem.deployContract('VeilGuardModule', [
  safeAddress, cUsdc.address, admin.address,
]);
console.log(`  VeilGuardModule: ${module_.address}`);

// ---------------------------------------------------------------- roles & enable

console.log('[5/5] Funding demo roles + enabling module…');
for (const role of fundingPlan.roles) {
  const funded = await fundRoleToTarget(role, {
    getBalance: (address) => publicClient.getBalance({ address }),
    sendTopUp: async (address, value) => {
      const hash = await deployer.sendTransaction({ to: address, value });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') {
        throw new Error(`${role.role} funding transaction reverted`);
      }
    },
  });
  console.log(
    `  ${role.role}: transferred ${formatEther(funded.transferred)} ETH; `
    + `verified ${formatEther(funded.finalBalance)} ETH`,
  );
}

const enableData = encodeFunctionData({
  abi: safeAbi,
  functionName: 'enableModule',
  args: [module_.address],
});
await safeExec2of2(
  safeAddress,
  safeAddress,
  enableData,
  { ownerAKey: adminKey, ownerBKey: env('DEMO_SIGNER_B_KEY')! },
);
const [enabled, safeOwners, safeThreshold] = await Promise.all([
  publicClient.readContract({
    address: safeAddress, abi: safeAbi, functionName: 'isModuleEnabled', args: [module_.address],
  }),
  publicClient.readContract({
    address: safeAddress, abi: safeAbi, functionName: 'getOwners',
  }),
  publicClient.readContract({
    address: safeAddress, abi: safeAbi, functionName: 'getThreshold',
  }),
]);
if (!enabled) throw new Error('module not enabled on Safe');
if (safeThreshold !== 2n || safeOwners.length !== 2) {
  throw new Error(`expected exact 2-of-2 Safe after setup, got threshold ${safeThreshold} with ${safeOwners.length} owners`);
}
console.log('  module enabled ✓');

// ---------------------------------------------------------------- record

const deployments = {
  chainId: 11155111,
  network: 'sepolia',
  deployedAt: new Date().toISOString(),
  contracts: {
    TestUSDC: testUsdc.address,
    ConfidentialUSDC: cUsdc.address,
    Safe: safeAddress,
    VeilGuardModule: module_.address,
    NoxCompute: '0x24Ef36Ec5b626D7DCD09a98F3083c2758F0F77bF',
  },
  safe: { kind: safeKind, owners: safeOwners, threshold: Number(safeThreshold) },
  roles: {
    financeAdmin: admin.address,
    signerB: signerB.address,
    delegate: delegate.address,
    auditor: auditor.address,
    deployer: deployer.account.address,
  },
};
writeFileSync(new URL('../deployments.json', import.meta.url), JSON.stringify(deployments, null, 2));
const deploymentCheckpoint = markCheckpointStage(
  newFreshCheckpoint({
    chainId,
    module: module_.address,
    safe: safeAddress,
  }),
  'deploy.complete',
  {
    status: 'verified',
    deployedAt: deployments.deployedAt,
  },
);
saveFreshCheckpoint(freshCheckpointPath, deploymentCheckpoint);
console.log('\n✅ deployments.json written');
console.log('✅ deployment-bound Fresh checkpoint initialized');
console.log(JSON.stringify(deployments.contracts, null, 2));
process.exit(0);
