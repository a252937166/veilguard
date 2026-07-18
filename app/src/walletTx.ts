import type { Abi } from 'viem';
import { makeWalletClient, publicClient } from './nox';

/**
 * Robust wallet write for injected wallets (MetaMask & co).
 *
 * Fixes the "stuck at ② — no confirmation popup" failure modes:
 *  1. Pre-flights the call with `estimateContractGas` on OUR fallback RPC —
 *     a tx that would revert fails HERE, instantly and with a decodable reason,
 *     before the wallet is ever involved.
 *  2. Passes the explicit `gas` limit on, so the wallet doesn't have to run its
 *     own eth_estimateGas through its (possibly slow/blocked) default RPC
 *     before it can show the popup.
 *  3. Escalating hints: MetaMask often fails to auto-open a second popup right
 *     after a previous one closed — the request just sits queued behind the
 *     toolbar icon. After 12s we tell the user exactly that; a hard timeout
 *     keeps the UI from hanging forever.
 */
export async function walletWrite(opts: {
  account: `0x${string}`;
  address: `0x${string}`;
  abi: Abi | readonly unknown[];
  functionName: string;
  args: readonly unknown[];
  /** live status line updater (flowbar) */
  onHint?: (msg: string) => void;
  /** wallet-popup hints only make sense for injected wallets, not demo local keys */
  injected?: boolean;
  timeoutMs?: number;
}): Promise<`0x${string}`> {
  const { account, address, abi, functionName, args, onHint, injected = true, timeoutMs = 150_000 } = opts;

  // 1) pre-flight on our RPC: early revert detection + a gas limit for the wallet
  const gas = await publicClient.estimateContractGas({
    account, address, abi: abi as Abi, functionName: functionName as any, args: args as any,
  });

  const wallet = makeWalletClient(account);
  const t0 = Date.now();
  const timers: any[] = [];
  if (injected && onHint) {
    timers.push(setTimeout(() => onHint(
      '② No popup? Click the wallet (🦊) icon in your browser toolbar — the confirmation is queued there. MetaMask often fails to auto-open a second window.',
    ), 12_000));
    timers.push(setTimeout(() => onHint(
      '② Still waiting… open the MetaMask popup from the toolbar icon and approve (or reject) the pending transaction. If MetaMask shows nothing, click its icon, unlock it, and retry.',
    ), 40_000));
  }
  try {
    const hash = await Promise.race([
      wallet.writeContract({
        address, abi: abi as Abi, functionName: functionName as any, args: args as any,
        gas: (gas * 125n) / 100n,
        chain: wallet.chain, account: wallet.account!,
      }),
      new Promise<never>((_, rej) => timers.push(setTimeout(
        () => rej(new Error('wallet confirmation timed out — open your wallet from the toolbar icon and check for a pending request. If you approve it later, the transaction still goes through.')),
        timeoutMs,
      ))),
    ]);
    console.info(`[walletTx] ${functionName} confirmed in wallet after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return hash;
  } finally {
    timers.forEach(clearTimeout);
  }
}
