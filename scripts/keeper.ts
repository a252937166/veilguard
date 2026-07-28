/**
 * VeilGuard keeper — an UNTRUSTED courier that improves availability.
 *
 * It watches for requests stuck in `Requested` whose decision handle the Nox
 * gateway can already prove, and submits `finalize(id, proof)`. It never
 * decides anything: the on-chain proof determines the outcome, so a malicious
 * or buggy keeper cannot change a result — only delay it (users can always
 * finalize themselves from the dApp).
 *
 * One-shot:   npx hardhat run scripts/keeper.ts --network sepolia
 * Loop (cron / systemd): KEEPER_LOOP=1 npx hardhat run scripts/keeper.ts --network sepolia
 */
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { createViemHandleClient } from '@iexec-nox/handle';
import { createGuardedRpcFallback, parseRpcUrls } from '../server/lib/rpc-fallback.mjs';
import {
  areNoxHandlesResolved,
  resolveThenRetryNoxRead,
  waitUntilNoxSimulatable,
} from '../server/lib/nox-production.mjs';

const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const env = (k: string) =>
  envText.split('\n').find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim();
const deployments = JSON.parse(readFileSync(new URL('../deployments.json', import.meta.url), 'utf8'));
const MODULE = deployments.contracts.VeilGuardModule as `0x${string}`;

const RPC = process.env.SEPOLIA_RPC_URL
  ?? env('SEPOLIA_RPC_URL')
  ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const RPC_FALLBACKS = process.env.SEPOLIA_RPC_FALLBACK_URLS
  ?? env('SEPOLIA_RPC_FALLBACK_URLS')
  ?? '';
const GATEWAY = 'https://gateway-testnets.noxprotocol.dev';
const LOOP = process.env.KEEPER_LOOP === '1';
const INTERVAL_MS = Number(process.env.KEEPER_INTERVAL_MS ?? 20_000);

// The keeper signs finalize txs. Uses a dedicated key if provided, else the deployer.
const keeperKey = (
  process.env.KEEPER_KEY
  ?? env('KEEPER_KEY')
  ?? process.env.SEPOLIA_DEPLOYER_KEY
  ?? env('SEPOLIA_DEPLOYER_KEY')
)! as `0x${string}`;

const rpc = createGuardedRpcFallback({
  urls: parseRpcUrls(RPC, RPC_FALLBACKS, sepolia.rpcUrls.default.http),
  chainId: sepolia.id,
});
const publicClient = createPublicClient({ chain: sepolia, transport: rpc.transport });
const keeper = createWalletClient({
  account: privateKeyToAccount(keeperKey),
  chain: sepolia,
  transport: rpc.transport,
});

const moduleAbi = JSON.parse(readFileSync(
  new URL('../artifacts/contracts/VeilGuardModule.sol/VeilGuardModule.json', import.meta.url), 'utf8',
)).abi;

const handleClient = await createViemHandleClient({
  ...keeper, getAddresses: async () => [keeper.account.address],
} as any);

const NOX_STATUS_URL = `${GATEWAY}/v0/public/handles/status`;

async function sweep() {
  const nextId = (await publicClient.readContract({
    address: MODULE, abi: moduleAbi, functionName: 'nextRequestId',
  })) as bigint;
  let finalized = 0;
  for (let i = 1n; i < nextId; i++) {
    const r = (await publicClient.readContract({
      address: MODULE, abi: moduleAbi, functionName: 'getRequest', args: [i],
    })) as any[];
    if (Number(r[5]) !== 1) continue; // not in Requested
    const decisionHandle = r[7] as `0x${string}`;
    if (!(await areNoxHandlesResolved(NOX_STATUS_URL, [decisionHandle]))) {
      console.log(`  #${i}: decision not yet resolved by the TEE — skipping`);
      continue;
    }
    try {
      const { decryptionProof } = await resolveThenRetryNoxRead({
        statusUrl: NOX_STATUS_URL,
        handles: [decisionHandle],
        label: 'keeper decision public decrypt',
        operation: () => handleClient.publicDecrypt(decisionHandle as any),
      });
      const params = {
        address: MODULE, abi: moduleAbi, functionName: 'finalize', args: [i, decryptionProof],
      } as const;
      // Retry only the exact read-only estimate. The signed finalize payload is
      // sent once after Nox proof propagation is demonstrably consumable.
      const estimatedGas = await waitUntilNoxSimulatable(
        'keeper finalize proof exact estimate',
        () => publicClient.estimateContractGas({ ...params, account: keeper.account }),
      );
      const hash = await keeper.writeContract({
        ...params,
        gas: estimatedGas * 125n / 100n,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error('finalize transaction reverted');
      console.log(`  #${i}: finalized ✓ ${hash}`);
      finalized++;
    } catch (e: any) {
      console.log(`  #${i}: finalize failed (${e?.shortMessage ?? e?.message}) — will retry`);
    }
  }
  return finalized;
}

console.log(
  `[keeper] module ${MODULE} · signer ${keeper.account.address} · loop=${LOOP}`
  + ` · rpc=${rpc.status().endpointCount} endpoint(s), single-broadcast`,
);
if (LOOP) {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const n = await sweep();
    if (n) console.log(`[keeper] finalized ${n} request(s)`);
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
} else {
  const n = await sweep();
  console.log(`[keeper] done — finalized ${n} request(s)`);
  process.exit(0);
}
