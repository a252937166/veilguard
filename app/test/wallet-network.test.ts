import { describe, expect, test, vi } from 'vitest';
import { BROWSER_RPC_URLS } from '../src/rpc';
import type { Eip1193Provider } from '../src/wallet';
import {
  ensureSepoliaNetwork,
  SEPOLIA_CHAIN_HEX,
  WalletNetworkError,
} from '../src/wallet-network';

const provider = (request: Eip1193Provider['request']): Eip1193Provider => ({ request });

describe('wallet network guard', () => {
  test('does not request a switch when the wallet is already on Sepolia', async () => {
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_chainId') return SEPOLIA_CHAIN_HEX;
      throw new Error(`unexpected method ${method}`);
    });

    await expect(ensureSepoliaNetwork(provider(request))).resolves.toBe(11155111);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({ method: 'eth_chainId' });
  });

  test('switches a known wallet network and verifies the final chain', async () => {
    let chainId = '0x1';
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_chainId') return chainId;
      if (method === 'wallet_switchEthereumChain') {
        chainId = SEPOLIA_CHAIN_HEX;
        return null;
      }
      throw new Error(`unexpected method ${method}`);
    });

    await expect(ensureSepoliaNetwork(provider(request))).resolves.toBe(11155111);
    expect(request.mock.calls.map(([args]) => args.method)).toEqual([
      'eth_chainId',
      'wallet_switchEthereumChain',
      'eth_chainId',
    ]);
  });

  test('waits for a successful switch whose chain id becomes visible asynchronously', async () => {
    let switchResolved = false;
    let postSwitchReads = 0;
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_chainId') {
        if (!switchResolved) return '0x1';
        postSwitchReads += 1;
        return postSwitchReads >= 3 ? SEPOLIA_CHAIN_HEX : '0x1';
      }
      if (method === 'wallet_switchEthereumChain') {
        switchResolved = true;
        return null;
      }
      throw new Error(`unexpected method ${method}`);
    });

    await expect(ensureSepoliaNetwork(provider(request), {
      settleTimeoutMs: 25,
      settlePollIntervalMs: 1,
    })).resolves.toBe(11155111);
    expect(request.mock.calls.filter(([args]) => args.method === 'wallet_switchEthereumChain')).toHaveLength(1);
    expect(postSwitchReads).toBeGreaterThanOrEqual(3);
  });

  test('recovers with canonical add then one switch when a wallet silently ignores direct switch', async () => {
    let chainId = '0x1';
    let switchCalls = 0;
    const request = vi.fn(async ({ method, params }: { method: string; params?: any[] }) => {
      if (method === 'eth_chainId') return chainId;
      if (method === 'wallet_switchEthereumChain') {
        switchCalls += 1;
        if (switchCalls === 2) chainId = SEPOLIA_CHAIN_HEX;
        return null;
      }
      if (method === 'wallet_addEthereumChain') {
        expect(params?.[0]).toEqual({
          chainId: SEPOLIA_CHAIN_HEX,
          chainName: 'Ethereum Sepolia',
          nativeCurrency: { name: 'Sepolia ETH', symbol: 'ETH', decimals: 18 },
          rpcUrls: BROWSER_RPC_URLS,
          blockExplorerUrls: ['https://sepolia.etherscan.io'],
        });
        return null;
      }
      throw new Error(`unexpected method ${method}`);
    });

    await expect(ensureSepoliaNetwork(provider(request), {
      settleTimeoutMs: 0,
      settlePollIntervalMs: 1,
    })).resolves.toBe(11155111);
    expect(switchCalls).toBe(2);
    expect(request.mock.calls.map(([args]) => args.method)).toEqual([
      'eth_chainId',
      'wallet_switchEthereumChain',
      'eth_chainId',
      'wallet_addEthereumChain',
      'wallet_switchEthereumChain',
      'eth_chainId',
    ]);
  });

  test('adds an unknown Sepolia chain, explicitly switches, then verifies it', async () => {
    let chainId = '0x1';
    let switchCalls = 0;
    const request = vi.fn(async ({ method, params }: { method: string; params?: any[] }) => {
      if (method === 'eth_chainId') return chainId;
      if (method === 'wallet_switchEthereumChain') {
        switchCalls += 1;
        if (switchCalls === 1) throw Object.assign(new Error('unknown chain'), { code: 4902 });
        chainId = SEPOLIA_CHAIN_HEX;
        return null;
      }
      if (method === 'wallet_addEthereumChain') {
        expect(params?.[0]).toEqual(expect.objectContaining({
          chainId: SEPOLIA_CHAIN_HEX,
          chainName: 'Ethereum Sepolia',
          rpcUrls: BROWSER_RPC_URLS,
        }));
        return null;
      }
      throw new Error(`unexpected method ${method}`);
    });

    await expect(ensureSepoliaNetwork(provider(request))).resolves.toBe(11155111);
    expect(request.mock.calls.map(([args]) => args.method)).toEqual([
      'eth_chainId',
      'wallet_switchEthereumChain',
      'wallet_addEthereumChain',
      'wallet_switchEthereumChain',
      'eth_chainId',
    ]);
  });

  test('surfaces a cancelled switch and never attempts to add the chain', async () => {
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_chainId') return '0x1';
      if (method === 'wallet_switchEthereumChain') {
        throw Object.assign(new Error('user rejected'), { code: 4001 });
      }
      throw new Error(`unexpected method ${method}`);
    });

    await expect(ensureSepoliaNetwork(provider(request))).rejects.toMatchObject({
      name: 'WalletNetworkError',
      issue: 'switch-rejected',
      providerCode: 4001,
      message: expect.stringContaining('cancelled'),
    });
    expect(request.mock.calls.map(([args]) => args.method)).not.toContain('wallet_addEthereumChain');
  });

  test('reports an already pending wallet network request', async () => {
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_chainId') return '0x1';
      throw Object.assign(new Error('request already pending'), { code: -32002 });
    });

    await expect(ensureSepoliaNetwork(provider(request))).rejects.toMatchObject({
      issue: 'request-pending',
      providerCode: -32002,
      message: expect.stringContaining('already pending'),
    });
  });

  test('surfaces an add-chain cancellation without retrying a write request', async () => {
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_chainId') return '0x1';
      if (method === 'wallet_switchEthereumChain') {
        throw Object.assign(new Error('unknown chain'), { code: 4902 });
      }
      if (method === 'wallet_addEthereumChain') {
        throw Object.assign(new Error('cancelled'), { code: 4001 });
      }
      throw new Error(`unexpected method ${method}`);
    });

    await expect(ensureSepoliaNetwork(provider(request))).rejects.toMatchObject({
      issue: 'add-rejected',
      providerCode: 4001,
      message: expect.stringContaining('cancelled'),
    });
    expect(request).toHaveBeenCalledTimes(3);
  });

  test('reports an already pending add-chain request without retrying', async () => {
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_chainId') return '0x1';
      if (method === 'wallet_switchEthereumChain') {
        throw Object.assign(new Error('unknown chain'), { code: 4902 });
      }
      if (method === 'wallet_addEthereumChain') {
        throw Object.assign(new Error('request already pending'), { code: -32002 });
      }
      throw new Error(`unexpected method ${method}`);
    });

    await expect(ensureSepoliaNetwork(provider(request))).rejects.toMatchObject({
      issue: 'request-pending',
      providerCode: -32002,
      message: expect.stringContaining('already pending'),
    });
    expect(request).toHaveBeenCalledTimes(3);
  });

  test('fails closed after one add-then-switch recovery when the wallet remains on another chain', async () => {
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_chainId') return '0x1';
      if (method === 'wallet_switchEthereumChain') return null;
      if (method === 'wallet_addEthereumChain') return null;
      throw new Error(`unexpected method ${method}`);
    });

    await expect(ensureSepoliaNetwork(provider(request), {
      settleTimeoutMs: 0,
      settlePollIntervalMs: 1,
    })).rejects.toMatchObject({
      issue: 'still-wrong-network',
    });
    expect(request.mock.calls.filter(([args]) => args.method === 'wallet_switchEthereumChain')).toHaveLength(2);
    expect(request.mock.calls.filter(([args]) => args.method === 'wallet_addEthereumChain')).toHaveLength(1);
  });

  test.each([
    [4001, 'add-rejected'],
    [-32002, 'request-pending'],
    [1234, 'add-failed'],
  ])('maps recovery add error %s without another switch', async (code, issue) => {
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_chainId') return '0x1';
      if (method === 'wallet_switchEthereumChain') return null;
      if (method === 'wallet_addEthereumChain') {
        throw Object.assign(new Error('recovery add failed'), { code });
      }
      throw new Error(`unexpected method ${method}`);
    });

    await expect(ensureSepoliaNetwork(provider(request), {
      settleTimeoutMs: 0,
      settlePollIntervalMs: 1,
    })).rejects.toMatchObject({ issue, providerCode: code });
    expect(request.mock.calls.filter(([args]) => args.method === 'wallet_switchEthereumChain')).toHaveLength(1);
    expect(request.mock.calls.filter(([args]) => args.method === 'wallet_addEthereumChain')).toHaveLength(1);
  });

  test('times out a wallet request that never settles', async () => {
    const request = vi.fn(() => new Promise(() => {}));

    await expect(ensureSepoliaNetwork(provider(request), { timeoutMs: 5 })).rejects.toEqual(
      expect.objectContaining<Partial<WalletNetworkError>>({
        issue: 'timeout',
        message: expect.stringContaining('timed out'),
      }),
    );
  });

  test('coalesces concurrent checks for the same injected provider', async () => {
    let chainId = '0x1';
    let releaseSwitch!: () => void;
    const switchGate = new Promise<void>((resolve) => { releaseSwitch = resolve; });
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_chainId') return chainId;
      if (method === 'wallet_switchEthereumChain') {
        await switchGate;
        chainId = SEPOLIA_CHAIN_HEX;
        return null;
      }
      throw new Error(`unexpected method ${method}`);
    });
    const injected = provider(request);

    const first = ensureSepoliaNetwork(injected);
    const second = ensureSepoliaNetwork(injected);
    expect(first).toBe(second);
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith(expect.objectContaining({
      method: 'wallet_switchEthereumChain',
    })));
    releaseSwitch();
    await expect(Promise.all([first, second])).resolves.toEqual([11155111, 11155111]);
    expect(request.mock.calls.filter(([args]) => args.method === 'wallet_switchEthereumChain')).toHaveLength(1);
  });
});
