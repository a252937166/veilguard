/**
 * Real 2-of-N Safe multisig helper — fully on-chain, no API key required.
 *
 * Protocol Kit builds the Safe transaction, BOTH owners sign it with genuine
 * EIP-712 signatures, and it executes only once the threshold's worth of
 * signatures are attached. With threshold = 2 a single owner physically cannot
 * execute: `execTransaction` reverts without the second signature. This is the
 * real multisig guarantee (the Safe Transaction Service / Safe{Wallet} queue is
 * an optional UX layer that now needs an API key and is not required for the
 * on-chain security property).
 */
import { readFileSync } from 'node:fs';
import * as ProtocolKit from '@safe-global/protocol-kit';
import { createPublicClient, http } from 'viem';
import { sepolia } from 'viem/chains';
import { assertExact2of2, assertTwoSignatures } from './lib/safe-policy.mjs';

const Safe = ProtocolKit.default as unknown as typeof import('@safe-global/protocol-kit').default;

const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8');
export const env = (k: string) =>
  process.env[k] ??
  envText.split('\n').find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim();

export const RPC = env('SEPOLIA_RPC_URL') ?? 'https://ethereum-sepolia-rpc.publicnode.com';

export type MultisigResult = {
  safeTxHash: string;
  executeTxHash: string;
  nonce: number;
  confirmations: number;
  threshold: number;
};

/**
 * Owner A signs, owner B signs, then the tx executes on-chain.
 *
 * This helper deliberately refuses anything except the project's exact
 * two-owner, threshold-two Safe shape. That keeps deployment and evidence
 * scripts from silently proving a weaker 1-of-2 setup.
 */
export async function safeExec2of2(
  safeAddress: string,
  to: string,
  data: string,
  { ownerAKey, ownerBKey }: { ownerAKey: string; ownerBKey: string },
  log: (m: string) => void = console.log,
  onBroadcast: (hash: `0x${string}`) => void = () => {},
): Promise<MultisigResult> {
  const publicClient = createPublicClient({ chain: sepolia, transport: http(RPC) });
  const chainId = await publicClient.getChainId();
  if (chainId !== sepolia.id) {
    throw new Error(`Safe execution requires Sepolia (${sepolia.id}), got chain ${chainId}`);
  }
  const safeA = await Safe.init({ provider: RPC, signer: ownerAKey, safeAddress });
  const safeB = await Safe.init({ provider: RPC, signer: ownerBKey, safeAddress });
  const [threshold, owners, ownerA, ownerB] = await Promise.all([
    safeA.getThreshold(),
    safeA.getOwners(),
    safeA.getSafeProvider().getSignerAddress(),
    safeB.getSafeProvider().getSignerAddress(),
  ]);
  const exactSafe = assertExact2of2({ threshold, owners, ownerA, ownerB });

  const nonce = await safeA.getNonce();
  let tx = await safeA.createTransaction({
    transactions: [{ to, value: '0', data }],
    options: { nonce },
  });
  const safeTxHash = await safeA.getTransactionHash(tx);

  tx = await safeA.signTransaction(tx, 'eth_signTypedData_v4'); // owner A's real EIP-712 signature
  log(`  Safe proposal ${safeTxHash} — owner A signed (1/${threshold})`);
  tx = await safeB.signTransaction(tx, 'eth_signTypedData_v4'); // owner B's real EIP-712 signature
  log(`  owner B signed (2/${threshold}) — threshold met`);
  const confirmations = assertTwoSignatures(tx.signatures.size);
  const currentNonce = await safeA.getNonce();
  if (currentNonce !== tx.data.nonce) {
    throw new Error(`Safe nonce changed while collecting signatures (expected ${tx.data.nonce}, got ${currentNonce})`);
  }

  const exec = await safeB.executeTransaction(tx);
  const executeTxHash = exec.hash as `0x${string}`;
  onBroadcast(executeTxHash);
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: executeTxHash,
  });
  if (receipt.status !== 'success') {
    throw new Error(`Safe execution reverted: ${executeTxHash}`);
  }
  log(`  executed on-chain (2-of-${threshold}): ${executeTxHash}`);

  return {
    safeTxHash,
    executeTxHash,
    nonce: tx.data.nonce,
    confirmations,
    threshold: exactSafe.threshold,
  };
}
