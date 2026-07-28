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

async function ensureSepoliaNetworkOnce(
  provider: Eip1193Provider | undefined,
  options: { timeoutMs?: number } = {},
): Promise<number> {
  if (!provider) {
    throw new WalletNetworkError(
      'provider-missing',
      'No active wallet provider is available. Reconnect your wallet and retry.',
    );
  }

  const timeoutMs = options.timeoutMs ?? 60_000;
  const current = await readWalletChainId(provider, Math.min(timeoutMs, 10_000));
  if (current === CHAIN_ID) return current;

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
    } catch (addError) {
      if (addError instanceof WalletNetworkError) throw addError;
      const addCode = providerCode(addError);
      throw new WalletNetworkError(
        addCode === 4001 ? 'add-rejected' : addCode === -32002 ? 'request-pending' : 'add-failed',
        addCode === 4001
          ? 'Adding Ethereum Sepolia was cancelled in the wallet. Write actions stay blocked.'
          : addCode === -32002
            ? 'A wallet network request is already pending. Open the wallet, resolve that request, then retry.'
          : `The wallet could not add Ethereum Sepolia: ${providerMessage(addError)}`,
        { cause: addError, providerCode: addCode },
      );
    }

    // EIP-3085 does not require a wallet to select a newly added chain.
    try {
      await requestSwitch(provider, timeoutMs);
    } catch (switchAfterAddError) {
      if (switchAfterAddError instanceof WalletNetworkError) throw switchAfterAddError;
      const switchCode = providerCode(switchAfterAddError);
      throw new WalletNetworkError(
        switchCode === 4001 ? 'switch-rejected' : switchCode === -32002 ? 'request-pending' : 'switch-failed',
        switchCode === 4001
          ? 'The Sepolia network switch was cancelled in the wallet. Write actions stay blocked.'
          : switchCode === -32002
            ? 'A wallet network request is already pending. Open the wallet, resolve that request, then retry.'
            : `Ethereum Sepolia was added, but the wallet could not select it: ${providerMessage(switchAfterAddError)}`,
        { cause: switchAfterAddError, providerCode: switchCode },
      );
    }
  }

  const selected = await readWalletChainId(provider, Math.min(timeoutMs, 10_000));
  if (selected !== CHAIN_ID) {
    throw new WalletNetworkError(
      'still-wrong-network',
      'The wallet did not switch to Ethereum Sepolia. Select Sepolia in the wallet and retry.',
    );
  }
  return selected;
}

export function ensureSepoliaNetwork(
  provider: Eip1193Provider | undefined,
  options: { timeoutMs?: number } = {},
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
