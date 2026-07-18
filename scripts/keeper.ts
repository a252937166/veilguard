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
import { network } from 'hardhat';
import { readFileSync } from 'node:fs';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { createViemHandleClient } from '@iexec-nox/handle';

const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const env = (k: string) =>
  envText.split('\n').find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim();
const deployments = JSON.parse(readFileSync(new URL('../deployments.json', import.meta.url), 'utf8'));
const MODULE = deployments.contracts.VeilGuardModule as `0x${string}`;

const RPC = env('SEPOLIA_RPC_URL') ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const GATEWAY = 'https://gateway-testnets.noxprotocol.dev';
const LOOP = process.env.KEEPER_LOOP === '1';
const INTERVAL_MS = Number(process.env.KEEPER_INTERVAL_MS ?? 20_000);

// The keeper signs finalize txs. Uses a dedicated key if provided, else the deployer.
const keeperKey = (env('KEEPER_KEY') ?? env('SEPOLIA_DEPLOYER_KEY'))! as `0x${string}`;

const conn = await network.connect('sepolia');
const { viem } = conn;
const publicClient = await viem.getPublicClient();
const keeper = createWalletClient({ account: privateKeyToAccount(keeperKey), chain: sepolia, transport: http(RPC) });

const moduleAbi = JSON.parse(readFileSync(
  new URL('../artifacts/contracts/VeilGuardModule.sol/VeilGuardModule.json', import.meta.url), 'utf8',
)).abi;

const handleClient = await createViemHandleClient({
  ...keeper, getAddresses: async () => [keeper.account.address],
} as any);

const resolved = async (handle: string) => {
  try {
    const res = await fetch(`${GATEWAY}/v0/public/handles/status`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handles: [handle] }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data.payload.statuses?.[0]?.resolved === true;
  } catch { return false; }
};

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
    if (!(await resolved(decisionHandle))) {
      console.log(`  #${i}: decision not yet resolved by the TEE — skipping`);
      continue;
    }
    try {
      const { decryptionProof } = await handleClient.publicDecrypt(decisionHandle as any);
      const hash = await keeper.writeContract({
        address: MODULE, abi: moduleAbi, functionName: 'finalize', args: [i, decryptionProof],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      console.log(`  #${i}: finalized ✓ ${hash}`);
      finalized++;
    } catch (e: any) {
      console.log(`  #${i}: finalize failed (${e?.shortMessage ?? e?.message}) — will retry`);
    }
  }
  return finalized;
}

console.log(`[keeper] module ${MODULE} · signer ${keeper.account.address} · loop=${LOOP}`);
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
