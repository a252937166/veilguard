import { createWalletClient, http, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { RPC_URL } from './config';

/**
 * DEMO MODE — intentionally public testnet keys, LOW-POWER ROLES ONLY.
 *
 * These two Sepolia demo keys are embedded on purpose so anyone can experience
 * the product without installing a wallet:
 *
 *  - the DELEGATE key demonstrates the core claim: even WITH the delegate's
 *    private key you cannot overspend — the confidential policy, not key
 *    custody, is what contains the delegate;
 *  - the AUDITOR key only carries read-grants on immutable snapshots.
 *
 * The powerful roles (finance admin, Safe owners) are NOT embedded — the
 * finance-admin key can propose mandates and a Safe-owner key contributes to
 * the 2-of-2 threshold, so publishing either would let anyone reshape the
 * treasury's policies. Escalation approvals in the demo are performed
 * server-side by the real 2-of-2 committee (both owner keys stay off-client),
 * and the Signer view shows the resulting on-chain evidence read-only.
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

/**
 * Dedicated low-power delegate for the "Policy violation" scenario. Blocked
 * requests put THE SUBMITTING DELEGATE in a 10-minute anti-probing cooldown, so
 * the violation mission signs with its own key — the main demo delegate never
 * gets frozen. Same intentionally-public delegate class as DEMO_ROLES.delegate.
 */
export const VIOLATION_DELEGATE = {
  key: '0x9b07dcbf4dd18fcdd352b14e58ef7c59c3af2cc5f279aab34185fdcea9504cc6' as `0x${string}`,
  address: '0xDFC0c6e0BAeD0948D8BA22A4917438938F2a40F4' as `0x${string}`,
};

/**
 * Dedicated delegate for shared-demo Free Play. Visitors can type ANY amount
 * here — if it gets blocked, only THIS delegate cools down, never the guided
 * missions. Same intentionally-public low-power class as the other two.
 */
export const FREEPLAY_DELEGATE = {
  key: '0x7662318d3b60a91622c6c9918ce1f4ad1df877414dab4e9d8dac105d03be2a11' as `0x${string}`,
  address: '0x2Fc2DC420540B3A93D6FA45F07c536c305a96497' as `0x${string}`,
};

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

/** Wallet client for the violation-scenario delegate (never shown as a role). */
export function violationWallet(): WalletClient {
  let c = clients.get('violation');
  if (!c) {
    c = createWalletClient({
      account: privateKeyToAccount(VIOLATION_DELEGATE.key),
      chain: sepolia,
      transport: http(RPC_URL),
    });
    clients.set('violation', c);
  }
  return c;
}

export function freeplayWallet(): WalletClient {
  let c = clients.get('freeplay');
  if (!c) {
    c = createWalletClient({
      account: privateKeyToAccount(FREEPLAY_DELEGATE.key),
      chain: sepolia,
      transport: http(RPC_URL),
    });
    clients.set('freeplay', c);
  }
  return c;
}

/** address(lowercase) -> demo wallet, for transparent signer routing. */
export function demoWalletByAddress(addr: string): WalletClient | undefined {
  if (addr.toLowerCase() === VIOLATION_DELEGATE.address.toLowerCase()) return violationWallet();
  if (addr.toLowerCase() === FREEPLAY_DELEGATE.address.toLowerCase()) return freeplayWallet();
  for (const role of Object.keys(DEMO_ROLES) as DemoRole[]) {
    if (demoAddress(role).toLowerCase() === addr.toLowerCase()) return demoWallet(role);
  }
  return undefined;
}
