import deployments from './deployments.json';
import moduleAbiJson from './module-abi.json';

export const RPC_URL = 'https://ethereum-sepolia-rpc.publicnode.com';
export const GATEWAY = 'https://gateway-testnets.noxprotocol.dev';
export const CHAIN_ID = 11155111;
export const PROVISION_API = '/api/provision';
export const FINALIZE_API = '/api/finalize';

export const ADDR = deployments.contracts as {
  TestUSDC: `0x${string}`;
  ConfidentialUSDC: `0x${string}`;
  Safe: `0x${string}`;
  VeilGuardModule: `0x${string}`;
  NoxCompute: `0x${string}`;
};
export const ROLES = deployments.roles as Record<string, `0x${string}`>;

export const moduleAbi = moduleAbiJson as any[];

export const erc20Abi = [
  { type: 'function', name: 'faucet', stateMutability: 'nonpayable', inputs: [{ name: 'amount', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

export const wrapperAbi = [
  { type: 'function', name: 'wrap', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'confidentialBalanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'bytes32' }] },
] as const;

export const safeAbi = [
  { type: 'function', name: 'getOwners', stateMutability: 'view', inputs: [], outputs: [{ type: 'address[]' }] },
  { type: 'function', name: 'execTransaction', stateMutability: 'payable', inputs: [
    { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' }, { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' }, { name: 'refundReceiver', type: 'address' },
    { name: 'signatures', type: 'bytes' }], outputs: [{ type: 'bool' }] },
] as const;

export const MANDATE_STATES = ['None', 'Draft', 'Active', 'Retired'];
export const REQUEST_STATES = ['None', 'Requested', 'Executed', 'AwaitingSafeApproval', 'Blocked', 'Cancelled', 'Expired'];
export const DECISION_LABEL: Record<number, string> = { 1: 'WITHIN MANDATE', 2: 'APPROVAL REQUIRED', 3: 'BLOCKED' };
/** Friendly names for known payout addresses — raw hex is not a product UI. */
export const VENDOR_NAMES: Record<string, string> = {
  '0xc4ba09787f46441a517467fc12af459d8268c60f': 'Demo Vendor',
  '0x04ebe79419f42f12748aba1502331e336219b1f7': 'CloudNode',
  '0xe32148e45c3b1f8a692bec3baa0079ad103a4c6b': 'ShieldOps',
  '0x6152f8ebe4e9b35c5042e095fc0e4af98c6a347d': 'Atlas Contractor',
};
export const vendorName = (a?: string) => (a ? VENDOR_NAMES[a.toLowerCase()] : undefined);

export const REASON_LABEL: Record<number, string> = { 0: '—', 1: 'policy budget', 2: 'treasury balance', 3: 'treasury reserve' };

export const fmt = (v: bigint | number) => (Number(v) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 });
export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Parse a user amount string to 6-decimal base units, rejecting junk. */
export function parseUsdc(input: string): bigint {
  const s = input.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new Error('amount must be a positive number with ≤ 6 decimals');
  const [whole, frac = ''] = s.split('.');
  const base = BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, '0'));
  if (base <= 0n) throw new Error('amount must be greater than zero');
  if (base > 10_000_000_000_000n) throw new Error('amount too large');
  return base;
}
/** kept for tests/scripts that pass numbers */
export const usdc = (n: number) => BigInt(Math.round(n * 1e6));
export const isAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a.trim());
export const scan = (a: string) => `https://sepolia.etherscan.io/address/${a}`;
export const scanTx = (h: string) => `https://sepolia.etherscan.io/tx/${h}`;
