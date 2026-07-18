/**
 * One-shot key rotation: the original finance-admin / Safe-owner-A key was
 * published in git history (it powered the since-removed public Signer demo),
 * so it must lose ALL on-chain power. This script — run ON the server with the
 * current .env — uses the still-valid 2-of-2 to:
 *   1. rotate the module's financeAdmin to NEW_ADMIN,
 *   2. swapOwner on the Safe (old owner A → NEW_ADMIN),
 *   3. sweep the old admin's gas ETH to the new admin.
 * Afterwards update ADMIN_KEY in .env and restart the provisioner.
 *
 * Usage: NEW_ADMIN_KEY=0x… node rotate-admin.bundle.mjs   (plus the normal .env)
 */
import { createPublicClient, createWalletClient, http as viemHttp, encodeFunctionData, parseSignature } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

const { ADMIN_KEY, SIGNER_B_KEY, MODULE, SAFE, NEW_ADMIN_KEY, RPC_URL = 'https://ethereum-sepolia-rpc.publicnode.com' } = process.env;
if (!ADMIN_KEY || !SIGNER_B_KEY || !MODULE || !SAFE || !NEW_ADMIN_KEY) throw new Error('missing env');

const ZERO = '0x0000000000000000000000000000000000000000';
const SENTINEL = '0x0000000000000000000000000000000000000001';
const pub = createPublicClient({ chain: sepolia, transport: viemHttp(RPC_URL) });
const oldAdmin = privateKeyToAccount(ADMIN_KEY);
const signerB = privateKeyToAccount(SIGNER_B_KEY);
const newAdmin = privateKeyToAccount(NEW_ADMIN_KEY);
const oldWallet = createWalletClient({ account: oldAdmin, chain: sepolia, transport: viemHttp(RPC_URL) });
const bWallet = createWalletClient({ account: signerB, chain: sepolia, transport: viemHttp(RPC_URL) });

const safeAbi = [
  { type: 'function', name: 'nonce', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'getOwners', stateMutability: 'view', inputs: [], outputs: [{ type: 'address[]' }] },
  { type: 'function', name: 'swapOwner', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'address' }], outputs: [] },
  { type: 'function', name: 'execTransaction', stateMutability: 'payable', inputs: [
    { type: 'address' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'uint8' },
    { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' },
    { type: 'address' }, { type: 'bytes' }], outputs: [{ type: 'bool' }] },
];
const moduleAbi = [
  { type: 'function', name: 'setFinanceAdmin', stateMutability: 'nonpayable', inputs: [{ type: 'address' }], outputs: [] },
  { type: 'function', name: 'financeAdmin', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
];

const SAFE_TX_TYPES = {
  SafeTx: [
    { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' }, { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' }, { name: 'nonce', type: 'uint256' },
  ],
};

async function exec2of2(to, data) {
  const nonce = await pub.readContract({ address: SAFE, abi: safeAbi, functionName: 'nonce' });
  const domain = { chainId: 11155111, verifyingContract: SAFE };
  const message = { to, value: 0n, data, operation: 0, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: ZERO, refundReceiver: ZERO, nonce };
  const sigA = await oldAdmin.signTypedData({ domain, types: SAFE_TX_TYPES, primaryType: 'SafeTx', message });
  const sigB = await signerB.signTypedData({ domain, types: SAFE_TX_TYPES, primaryType: 'SafeTx', message });
  const signers = [
    { addr: oldAdmin.address.toLowerCase(), sig: sigA },
    { addr: signerB.address.toLowerCase(), sig: sigB },
  ].sort((a, b) => (a.addr < b.addr ? -1 : 1));
  for (const s of signers) { const { v } = parseSignature(s.sig); if (v !== 27n && v !== 28n) throw new Error('bad v'); }
  const signatures = '0x' + signers.map((s) => s.sig.slice(2)).join('');
  const hash = await bWallet.writeContract({
    address: SAFE, abi: safeAbi, functionName: 'execTransaction',
    args: [to, 0n, data, 0, 0n, 0n, 0n, ZERO, ZERO, signatures],
  });
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error('execTransaction reverted');
  return hash;
}

// 1) financeAdmin → new
console.log('[rotate] setFinanceAdmin →', newAdmin.address);
const t1 = await exec2of2(MODULE, encodeFunctionData({ abi: moduleAbi, functionName: 'setFinanceAdmin', args: [newAdmin.address] }));
console.log('  tx', t1);

// 2) swapOwner old A → new (prevOwner from the Safe's linked list)
const owners = await pub.readContract({ address: SAFE, abi: safeAbi, functionName: 'getOwners' });
const idx = owners.findIndex((o) => o.toLowerCase() === oldAdmin.address.toLowerCase());
if (idx < 0) throw new Error('old admin is not an owner?');
const prev = idx === 0 ? SENTINEL : owners[idx - 1];
console.log('[rotate] swapOwner', oldAdmin.address, '→', newAdmin.address, '(prev', prev, ')');
const t2 = await exec2of2(SAFE, encodeFunctionData({ abi: safeAbi, functionName: 'swapOwner', args: [prev, oldAdmin.address, newAdmin.address] }));
console.log('  tx', t2);

// 3) sweep old admin gas → new admin (leave a sliver for safety)
const bal = await pub.getBalance({ address: oldAdmin.address });
const keep = 2n * 10n ** 15n;
if (bal > keep) {
  const h = await oldWallet.sendTransaction({ to: newAdmin.address, value: bal - keep });
  await pub.waitForTransactionReceipt({ hash: h });
  console.log('[rotate] swept', (Number(bal - keep) / 1e18).toFixed(4), 'ETH → new admin', h);
}

// verify
const fa = await pub.readContract({ address: MODULE, abi: moduleAbi, functionName: 'financeAdmin' });
const owners2 = await pub.readContract({ address: SAFE, abi: safeAbi, functionName: 'getOwners' });
console.log('[verify] financeAdmin =', fa);
console.log('[verify] owners =', owners2.join(', '));
if (fa.toLowerCase() !== newAdmin.address.toLowerCase()) throw new Error('financeAdmin rotation FAILED');
if (owners2.some((o) => o.toLowerCase() === oldAdmin.address.toLowerCase())) throw new Error('swapOwner FAILED');
console.log('[rotate] DONE — the leaked key now holds no power. Update ADMIN_KEY in .env and restart the provisioner.');
