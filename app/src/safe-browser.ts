import { encodeFunctionData, type WalletClient } from 'viem';
import { ADDR, moduleAbi } from './config';
import { publicClient } from './nox';

const ZERO = '0x0000000000000000000000000000000000000000' as const;

const safeAbi = [
  { type: 'function', name: 'nonce', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const;

const SAFE_TX_TYPES = {
  SafeTx: [
    { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' }, { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' }, { name: 'nonce', type: 'uint256' },
  ],
} as const;

export type GovFn = 'activateMandate' | 'executeEscalated' | 'cancelEscalated' | 'retireMandate' | 'unpauseAll';

/**
 * Real 2-of-2: owner A signs the exact SafeTx locally. The server verifies that
 * signature, the current owner set, latest nonce and canonical governance
 * calldata, then adds owner B and broadcasts while holding the shared Safe lock.
 */
export async function governance2of2(
  ownerA: WalletClient,
  fn: GovFn,
  args: unknown[],
  onStep?: (s: string) => void,
): Promise<`0x${string}`> {
  const to = ADDR.VeilGuardModule;
  const data = encodeFunctionData({ abi: moduleAbi, functionName: fn, args }) as `0x${string}`;
  const nonce = (await publicClient.readContract({ address: ADDR.Safe, abi: safeAbi, functionName: 'nonce' })) as bigint;

  const domain = { chainId: 11155111, verifyingContract: ADDR.Safe } as const;
  const message = { to, value: 0n, data, operation: 0, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: ZERO, refundReceiver: ZERO, nonce } as const;

  onStep?.('Owner A: sign the activation in your wallet…');
  const sigA = await ownerA.signTypedData({ account: ownerA.account!, domain, types: SAFE_TX_TYPES, primaryType: 'SafeTx', message });
  const ownerAAddr = ownerA.account!.address;

  onStep?.('Owner B: validating and co-signing the bounded governance action…');
  const res = await fetch('/api/governance-execute', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, data, nonce: nonce.toString(), signer: ownerAAddr, signature: sigA }),
    signal: AbortSignal.timeout(45_000),
  });
  const executed = await res.json();
  if (!res.ok) throw new Error(executed.error ?? 'governance execution refused');
  onStep?.('2-of-2 executed on-chain.');
  return executed.hash as `0x${string}`;
}
