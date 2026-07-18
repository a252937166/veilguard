import { createWalletClient, http, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { RPC_URL } from './config';

/**
 * DEMO MODE — intentionally public testnet keys.
 *
 * These two Sepolia demo keys are embedded on purpose so anyone can experience
 * the product without installing a wallet:
 *
 *  - the DELEGATE key demonstrates the core claim: even WITH the delegate's
 *    private key you cannot overspend — the confidential policy, not key
 *    custody, is what contains the delegate;
 *  - the AUDITOR key only carries read-grants on immutable snapshots.
 *
 * The powerful roles (finance admin, Safe signer) are NOT embedded: a Safe
 * owner key would let anyone rewrite the treasury and deface the demo.
 * Keys hold a few cents of testnet ETH for gas. Do not reuse anywhere.
 */
export const DEMO_ROLES = {
  delegate: {
    label: 'Delegate',
    icon: '🧑‍💼',
    blurb: 'Submit encrypted spend requests and watch the TEE decide. You hold the real key — the policy is what stops you overspending.',
    key: '0x542fe27a6c79622ecf81ed14b4440a16eba591229c028a47021d6850340ff5d0' as `0x${string}`,
  },
  auditor: {
    label: 'Auditor',
    icon: '🕵️',
    blurb: 'Decrypt the immutable disclosure snapshots the finance admin granted you — and nothing else.',
    key: '0xa9a218faa7d53652f1da5a0c77ce7d4bdd6e182915be07bb53fd6247458dcd33' as `0x${string}`,
  },
} as const;

export type DemoRole = keyof typeof DEMO_ROLES;

const clients = new Map<string, WalletClient>();

export function demoWallet(role: DemoRole): WalletClient {
  let c = clients.get(role);
  if (!c) {
    c = createWalletClient({
      account: privateKeyToAccount(DEMO_ROLES[role].key),
      chain: sepolia,
      transport: http(RPC_URL),
    });
    clients.set(role, c);
  }
  return c;
}

export function demoAddress(role: DemoRole): `0x${string}` {
  return demoWallet(role).account!.address;
}

/** address(lowercase) -> demo wallet, for transparent signer routing. */
export function demoWalletByAddress(addr: string): WalletClient | undefined {
  for (const role of Object.keys(DEMO_ROLES) as DemoRole[]) {
    if (demoAddress(role).toLowerCase() === addr.toLowerCase()) return demoWallet(role);
  }
  return undefined;
}
