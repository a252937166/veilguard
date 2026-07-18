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
import Safe from '@safe-global/protocol-kit';

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

/** Owner A signs, owner B signs, then the tx executes on-chain (2-of-N). */
export async function safeMultisig(
  safeAddress: string,
  to: string,
  data: string,
  { ownerAKey, ownerBKey }: { ownerAKey: string; ownerBKey: string },
  log: (m: string) => void = console.log,
): Promise<MultisigResult> {
  const safeA = await Safe.init({ provider: RPC, signer: ownerAKey, safeAddress });
  const safeB = await Safe.init({ provider: RPC, signer: ownerBKey, safeAddress });
  const threshold = await safeA.getThreshold();

  let tx = await safeA.createTransaction({ transactions: [{ to, value: '0', data }] });
  const safeTxHash = await safeA.getTransactionHash(tx);

  tx = await safeA.signTransaction(tx); // owner A's real EIP-712 signature
  log(`  Safe proposal ${safeTxHash} — owner A signed (1/${threshold})`);
  tx = await safeB.signTransaction(tx); // owner B's real EIP-712 signature
  log(`  owner B signed (2/${threshold}) — threshold met`);

  const exec = await safeB.executeTransaction(tx);
  const executeTxHash = exec.hash as string;
  const nonce = await safeA.getNonce();
  log(`  executed on-chain (2-of-${threshold}): ${executeTxHash}`);

  return { safeTxHash, executeTxHash, nonce: Number(nonce) - 1, confirmations: tx.signatures.size, threshold };
}
