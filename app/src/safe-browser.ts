import { encodeFunctionData, type WalletClient } from 'viem';
import { ADDR, moduleAbi } from './config';
import { publicClient } from './nox';

const ZERO = '0x0000000000000000000000000000000000000000' as const;

const safeAbi = [
  { type: 'function', name: 'nonce', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'execTransaction', stateMutability: 'payable', inputs: [
    { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' }, { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' }, { name: 'refundReceiver', type: 'address' },
    { name: 'signatures', type: 'bytes' }], outputs: [{ type: 'bool' }] },
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
 * Real in-browser 2-of-2: owner A (the given wallet) signs the SafeTx locally;
 * owner B is co-signed server-side but ONLY for governance calls (the server
 * refuses anything else, so owner A alone can never reach threshold). Both real
 * EIP-712 signatures are combined and execTransaction runs on-chain.
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

  onStep?.('Owner B: co-signing (governance-only, server-side)…');
  const res = await fetch('/api/cosign', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, data, nonce: Number(nonce) }),
  });
  const cos = await res.json();
  if (!res.ok) throw new Error(cos.error ?? 'owner B co-sign refused');
  const sigB: `0x${string}` = cos.signature;
  const ownerBAddr: string = cos.signer;

  // Safe requires signatures concatenated, sorted by signer address ascending.
  const parts = [
    { addr: ownerAAddr.toLowerCase(), sig: sigA },
    { addr: ownerBAddr.toLowerCase(), sig: sigB },
  ].sort((a, b) => (a.addr < b.addr ? -1 : 1));
  const signatures = ('0x' + parts.map((p) => p.sig.slice(2)).join('')) as `0x${string}`;

  onStep?.('Executing the 2-of-2 on-chain…');
  const hash = await ownerA.writeContract({
    address: ADDR.Safe, abi: safeAbi, functionName: 'execTransaction',
    args: [to, 0n, data, 0, 0n, 0n, 0n, ZERO, ZERO, signatures],
    chain: ownerA.chain, account: ownerA.account!,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}
