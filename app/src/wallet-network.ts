import { CHAIN_ID } from './config';
import { BROWSER_RPC_URLS } from './rpc';
import type { Eip1193Provider } from './wallet';

export const SEPOLIA_CHAIN_HEX = '0xaa36a7';

export type WalletNetworkIssue =
  | 'provider-missing'
  | 'read-failed'
  | 'switch-rejected'
  | 'switch-failed'
  | 'request-pending'
  | 'add-rejected'
  | 'add-failed'
  | 'timeout'
  | 'still-wrong-network';

export class WalletNetworkError extends Error {
  readonly issue: WalletNetworkIssue;
  readonly providerCode?: number;

  constructor(
    issue: WalletNetworkIssue,
    message: string,
    options: { cause?: unknown; providerCode?: number } = {},
  ) {
    super(message);
    this.name = 'WalletNetworkError';
    this.issue = issue;
    this.providerCode = options.providerCode;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

const pendingChecks = new WeakMap<Eip1193Provider, Promise<number>>();

const providerCode = (error: unknown): number | undefined => {
  const value = (error as any)?.code ?? (error as any)?.cause?.code;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
  return undefined;
};

const providerMessage = (error: unknown): string => {
  const value = (error as any)?.shortMessage ?? (error as any)?.message;
  return typeof value === 'string' && value.trim() ? value.trim() : 'The wallet returned an unknown error.';
};

async function walletRequest<T>(
  provider: Eip1193Provider,
  args: { method: string; params?: any[] | object },
  timeoutMs: number,
  timeoutLabel: string,
): Promise<T> {
  if (timeoutMs <= 0) return provider.request(args) as Promise<T>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      provider.request(args) as Promise<T>,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new WalletNetworkError(
          'timeout',
          `${timeoutLabel} timed out. Open your wallet and approve or reject the pending request, then retry.`,
        )), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function readWalletChainId(
  provider: Eip1193Provider,
  timeoutMs = 10_000,
): Promise<number> {
  let raw: unknown;
  try {
    raw = await walletRequest<unknown>(
      provider,
      { method: 'eth_chainId' },
      timeoutMs,
      'Reading the wallet network',
    );
  } catch (error) {
    if (error instanceof WalletNetworkError) throw error;
    throw new WalletNetworkError(
      'read-failed',
      `VeilGuard could not read the wallet network: ${providerMessage(error)}`,
      { cause: error, providerCode: providerCode(error) },
    );
  }

  const chainId = typeof raw === 'string' ? Number.parseInt(raw, 16) : Number(raw);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new WalletNetworkError(
      'read-failed',
      'The wallet returned an invalid network identifier. Reconnect the wallet and retry.',
    );
  }
  return chainId;
}

async function requestSwitch(provider: Eip1193Provider, timeoutMs: number): Promise<void> {
  await walletRequest(
    provider,
    { method: 'wallet_switchEthereumChain', params: [{ chainId: SEPOLIA_CHAIN_HEX }] },
    timeoutMs,
    'Switching to Ethereum Sepolia',
  );
}

async function requestAddSepolia(provider: Eip1193Provider, timeoutMs: number): Promise<void> {
  try {
    await walletRequest(
      provider,
      {
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: SEPOLIA_CHAIN_HEX,
          chainName: 'Ethereum Sepolia',
          nativeCurrency: { name: 'Sepolia ETH', symbol: 'ETH', decimals: 18 },
          rpcUrls: [...BROWSER_RPC_URLS],
          blockExplorerUrls: ['https://sepolia.etherscan.io'],
        }],
      },
      timeoutMs,
      'Adding Ethereum Sepolia',
    );
  } catch (error) {
    if (error instanceof WalletNetworkError) throw error;
    const code = providerCode(error);
    throw new WalletNetworkError(
      code === 4001 ? 'add-rejected' : code === -32002 ? 'request-pending' : 'add-failed',
      code === 4001
        ? 'Adding Ethereum Sepolia was cancelled in the wallet. Write actions stay blocked.'
        : code === -32002
          ? 'A wallet network request is already pending. Open the wallet, resolve that request, then retry.'
          : `The wallet could not add Ethereum Sepolia: ${providerMessage(error)}`,
      { cause: error, providerCode: code },
    );
  }
}

async function requestSwitchAfterAdd(provider: Eip1193Provider, timeoutMs: number): Promise<void> {
  try {
    await requestSwitch(provider, timeoutMs);
  } catch (error) {
    if (error instanceof WalletNetworkError) throw error;
    const code = providerCode(error);
    throw new WalletNetworkError(
      code === 4001 ? 'switch-rejected' : code === -32002 ? 'request-pending' : 'switch-failed',
      code === 4001
        ? 'The Sepolia network switch was cancelled in the wallet. Write actions stay blocked.'
        : code === -32002
          ? 'A wallet network request is already pending. Open the wallet, resolve that request, then retry.'
          : `Ethereum Sepolia was added, but the wallet could not select it: ${providerMessage(error)}`,
      { cause: error, providerCode: code },
    );
  }
}

type WalletNetworkOptions = {
  timeoutMs?: number;
  /**
   * Maximum time to observe the post-switch chain id. The first successful
   * switch gets a short grace period; the add-then-switch recovery gets the
   * full period. Set to zero only for deterministic callers/tests that want
   * an immediate postcondition check.
   */
  settleTimeoutMs?: number;
  settlePollIntervalMs?: number;
};

const delay = (ms: number) => (
  ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
);

async function waitForSepoliaSettlement(
  provider: Eip1193Provider,
  {
    settleTimeoutMs,
    settlePollIntervalMs,
    readTimeoutMs,
  }: {
    settleTimeoutMs: number;
    settlePollIntervalMs: number;
    readTimeoutMs: number;
  },
): Promise<{ selected?: number; lastReadError?: unknown }> {
  const deadline = Date.now() + settleTimeoutMs;
  let selected: number | undefined;
  let lastReadError: unknown;

  // EIP-3326 and EIP-1193 do not guarantee that the request Promise, the
  // chainChanged event and eth_chainId visibility settle in the same turn.
  // Poll the authoritative chain id instead of trusting response/event order.
  do {
    try {
      selected = await readWalletChainId(provider, Math.min(readTimeoutMs, 2_000));
      lastReadError = undefined;
      if (selected === CHAIN_ID) return { selected };
    } catch (error) {
      // A provider can transiently reject eth_chainId while its network client
      // is being replaced. Keep the last error and fail closed after the bound.
      lastReadError = error;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await delay(Math.min(settlePollIntervalMs, remainingMs));
  } while (true);

  return { selected, lastReadError };
}

async function ensureSepoliaNetworkOnce(
  provider: Eip1193Provider | undefined,
  options: WalletNetworkOptions = {},
): Promise<number> {
  if (!provider) {
    throw new WalletNetworkError(
      'provider-missing',
      'No active wallet provider is available. Reconnect your wallet and retry.',
    );
  }

  const timeoutMs = options.timeoutMs ?? 60_000;
  const settleTimeoutMs = options.settleTimeoutMs ?? 10_000;
  const settlePollIntervalMs = options.settlePollIntervalMs ?? 250;
  if (!Number.isFinite(settleTimeoutMs) || settleTimeoutMs < 0) {
    throw new Error('Wallet network settlement timeout must be non-negative.');
  }
  if (!Number.isFinite(settlePollIntervalMs) || settlePollIntervalMs <= 0) {
    throw new Error('Wallet network settlement poll interval must be positive.');
  }
  const current = await readWalletChainId(provider, Math.min(timeoutMs, 10_000));
  if (current === CHAIN_ID) return current;

  let addedBeforeSuccessfulSwitch = false;
  try {
    await requestSwitch(provider, timeoutMs);
  } catch (error) {
    if (error instanceof WalletNetworkError) throw error;
    const code = providerCode(error);
    if (code === 4001) {
      throw new WalletNetworkError(
        'switch-rejected',
        'The Sepolia network switch was cancelled in the wallet. VeilGuard remains connected, but write actions stay blocked.',
        { cause: error, providerCode: code },
      );
    }
    if (code === -32002) {
      throw new WalletNetworkError(
        'request-pending',
        'A wallet network request is already pending. Open the wallet, resolve that request, then retry.',
        { cause: error, providerCode: code },
      );
    }
    if (code !== 4902) {
      throw new WalletNetworkError(
        'switch-failed',
        `The wallet could not switch to Ethereum Sepolia: ${providerMessage(error)}`,
        { cause: error, providerCode: code },
      );
    }

    await requestAddSepolia(provider, timeoutMs);
    addedBeforeSuccessfulSwitch = true;
    // EIP-3085 does not require a wallet to select a newly added chain.
    await requestSwitchAfterAdd(provider, timeoutMs);
  }

  const settlement = await waitForSepoliaSettlement(provider, {
    // A switch after EIP-3085 recovery gets the full confirmation window. A
    // direct successful switch gets a short grace window before recovery.
    settleTimeoutMs: addedBeforeSuccessfulSwitch
      ? settleTimeoutMs
      : Math.min(settleTimeoutMs, 2_000),
    settlePollIntervalMs,
    readTimeoutMs: Math.min(timeoutMs, 10_000),
  });
  if (settlement.selected === CHAIN_ID) return settlement.selected;

  if (addedBeforeSuccessfulSwitch) {
    throw new WalletNetworkError(
      'still-wrong-network',
      settlement.lastReadError
        ? 'Ethereum Sepolia was added, but the wallet network could not be verified. Reopen the wallet, select Sepolia, and retry.'
        : 'Ethereum Sepolia was added, but the wallet remained on another network. Select Sepolia in the wallet and retry.',
    );
  }

  // Live OKX evidence shows that a direct switch can resolve successfully yet
  // remain unapplied, including after repeating switch. A single canonical
  // EIP-3085 add request is the standards-safe recovery: it opens the wallet's
  // approval path, after which EIP-3085 still requires one explicit switch.
  // There are no loops and explicit add/switch failures are never retried.
  await requestAddSepolia(provider, timeoutMs);
  await requestSwitchAfterAdd(provider, timeoutMs);

  const finalSettlement = await waitForSepoliaSettlement(provider, {
    settleTimeoutMs,
    settlePollIntervalMs,
    readTimeoutMs: Math.min(timeoutMs, 10_000),
  });
  if (finalSettlement.selected === CHAIN_ID) return finalSettlement.selected;

  throw new WalletNetworkError(
    'still-wrong-network',
    finalSettlement.lastReadError
      ? 'Ethereum Sepolia was added and selected, but the wallet network could not be verified. Reopen the wallet and retry.'
      : 'Ethereum Sepolia was added, but the wallet remained on another network after selection. Select Sepolia in the wallet and retry.',
  );
}

export function ensureSepoliaNetwork(
  provider: Eip1193Provider | undefined,
  options: WalletNetworkOptions = {},
): Promise<number> {
  if (!provider) return ensureSepoliaNetworkOnce(provider, options);
  const existing = pendingChecks.get(provider);
  if (existing) return existing;
  const pending = ensureSepoliaNetworkOnce(provider, options);
  pendingChecks.set(provider, pending);
  void pending.finally(() => {
    if (pendingChecks.get(provider) === pending) pendingChecks.delete(provider);
  }).catch(() => {
    // The caller owns the original rejection. This catch only consumes the
    // cleanup promise returned by finally().
  });
  return pending;
}
