import { expect, test, type Page } from '@playwright/test';
import { installVisualFixture } from './fixtures/visual-fixture';

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const SEPOLIA = '0xaa36a7';
const MOCK_WALLET_KEY = 'test.mock.wallet';

type WalletCall = {
  method: string;
  params: unknown;
};

async function installMockWallet(
  page: Page,
  {
    initialChain = '0x1',
    rejectSwitches = 0,
    persist = false,
  }: {
    initialChain?: string;
    rejectSwitches?: number;
    persist?: boolean;
  } = {},
) {
  // Reuse the deterministic read-only RPC fixture so no request reaches
  // Sepolia. The EIP-1193 provider below remains a separate pure wallet mock.
  await installVisualFixture(page, 'landing');

  await page.addInitScript((options) => {
    let chainId = options.initialChain;
    let remainingSwitchRejections = options.rejectSwitches;
    const calls: Array<{ method: string; params: unknown }> = [];
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

    const emit = (event: string, ...args: unknown[]) => {
      listeners.get(event)?.forEach((listener) => listener(...args));
    };

    const provider = {
      request: async ({ method, params }: { method: string; params?: unknown }) => {
        calls.push({ method, params: params ?? null });
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') {
          return [options.account];
        }
        if (method === 'eth_chainId') return chainId;
        if (method === 'wallet_switchEthereumChain') {
          if (remainingSwitchRejections > 0) {
            remainingSwitchRejections -= 1;
            const error = new Error('User cancelled the network switch') as Error & { code: number };
            error.code = 4001;
            throw error;
          }
          chainId = options.sepolia;
          emit('chainChanged', chainId);
          return null;
        }
        if (method === 'wallet_addEthereumChain') return null;
        throw new Error(`Unexpected mock wallet method: ${method}`);
      },
      on: (event: string, listener: (...args: unknown[]) => void) => {
        const eventListeners = listeners.get(event) ?? new Set();
        eventListeners.add(listener);
        listeners.set(event, eventListeners);
      },
      removeListener: (event: string, listener: (...args: unknown[]) => void) => {
        listeners.get(event)?.delete(listener);
      },
    };

    const announce = () => {
      window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
        detail: {
          info: {
            uuid: '00000000-0000-4000-8000-000000000001',
            name: 'Mock Wallet',
            icon: '🧪',
            rdns: options.walletKey,
          },
          provider,
        },
      }));
    };
    window.addEventListener('eip6963:requestProvider', announce);

    Object.defineProperty(window, '__veilguardWalletMock', {
      configurable: true,
      value: {
        calls,
        get chainId() { return chainId; },
      },
    });

    if (options.persist) localStorage.setItem('vg_wallet', options.walletKey);
  }, {
    account: ACCOUNT,
    initialChain,
    rejectSwitches,
    persist,
    sepolia: SEPOLIA,
    walletKey: MOCK_WALLET_KEY,
  });
}

async function connectMockWallet(page: Page) {
  await page.goto('/#/overview');
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  const picker = page.getByRole('dialog', { name: 'Connect a wallet' });
  await expect(picker).toBeVisible();
  await picker.getByRole('button', { name: /Mock Wallet/ }).click();
}

async function walletCalls(page: Page): Promise<WalletCall[]> {
  return page.evaluate(() => (
    (window as any).__veilguardWalletMock.calls.map((call: WalletCall) => ({
      method: call.method,
      params: call.params,
    }))
  ));
}

async function installRacingWallets(page: Page) {
  await installVisualFixture(page, 'landing');
  await page.addInitScript(({ sepolia }) => {
    const calls = { alpha: [] as WalletCall[], beta: [] as WalletCall[] };
    let alphaChain = '0x1';
    let betaChain = '0x1';
    let releaseAlphaSwitch: (() => void) | undefined;

    const alpha = {
      request: async ({ method, params }: { method: string; params?: unknown }) => {
        calls.alpha.push({ method, params: params ?? null });
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') {
          return ['0x1111111111111111111111111111111111111111'];
        }
        if (method === 'eth_chainId') return alphaChain;
        if (method === 'wallet_switchEthereumChain') {
          await new Promise<void>((resolve) => { releaseAlphaSwitch = resolve; });
          alphaChain = sepolia;
          return null;
        }
        if (method === 'wallet_revokePermissions') return null;
        throw new Error(`Unexpected Alpha Wallet method: ${method}`);
      },
    };
    const beta = {
      request: async ({ method, params }: { method: string; params?: unknown }) => {
        calls.beta.push({ method, params: params ?? null });
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') {
          return ['0x2222222222222222222222222222222222222222'];
        }
        if (method === 'eth_chainId') return betaChain;
        if (method === 'wallet_switchEthereumChain') {
          betaChain = sepolia;
          return null;
        }
        if (method === 'wallet_revokePermissions') return null;
        throw new Error(`Unexpected Beta Wallet method: ${method}`);
      },
    };

    const announce = () => {
      for (const [uuid, name, rdns, provider] of [
        ['00000000-0000-4000-8000-00000000000a', 'Alpha Wallet', 'test.alpha.wallet', alpha],
        ['00000000-0000-4000-8000-00000000000b', 'Beta Wallet', 'test.beta.wallet', beta],
      ] as const) {
        window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
          detail: { info: { uuid, name, icon: '🧪', rdns }, provider },
        }));
      }
    };
    window.addEventListener('eip6963:requestProvider', announce);
    Object.defineProperty(window, '__veilguardWalletRace', {
      configurable: true,
      value: {
        calls,
        releaseAlpha: () => {
          if (!releaseAlphaSwitch) throw new Error('Alpha switch has not started');
          releaseAlphaSwitch();
        },
      },
    });
  }, { sepolia: SEPOLIA });
}

function expectNoWalletWrites(calls: WalletCall[]) {
  expect(calls.map((call) => call.method)).not.toEqual(expect.arrayContaining([
    'eth_sendTransaction',
    'eth_sign',
    'personal_sign',
    'eth_signTypedData',
    'eth_signTypedData_v4',
  ]));
}

test('explicit connection switches a wrong-network wallet to Sepolia', async ({ page }) => {
  await installMockWallet(page);
  await connectMockWallet(page);

  await expect(page.locator('.toast')).toHaveText('Wallet connected and switched to Ethereum Sepolia.');
  await expect(page.getByRole('button', { name: /Wrong network/ })).toHaveCount(0);

  await page.getByRole('button', { name: /Mock Wallet menu/ }).click();
  await expect(page.getByRole('dialog', { name: /wallet and account menu/i }).locator('.wp-net')).toHaveText('● Sepolia');

  const calls = await walletCalls(page);
  expect(calls).toContainEqual({
    method: 'wallet_switchEthereumChain',
    params: [{ chainId: SEPOLIA }],
  });
  expectNoWalletWrites(calls);
});

test('a cancelled switch keeps the wallet connected and a visible retry succeeds', async ({ page }) => {
  await installMockWallet(page, { rejectSwitches: 1 });
  await connectMockWallet(page);

  await expect(page.locator('.toast')).toContainText('network switch was cancelled');
  await expect(page.getByRole('button', { name: /Mock Wallet menu/ })).toBeVisible();
  const retry = page.getByRole('button', { name: /Wrong network.*switch to Sepolia/i });
  await expect(retry).toBeVisible();
  await retry.click();

  await expect(page.locator('.toast')).toHaveText('Wallet switched to Ethereum Sepolia.');
  await expect(retry).toHaveCount(0);

  const calls = await walletCalls(page);
  expect(calls.filter((call) => call.method === 'wallet_switchEthereumChain')).toHaveLength(2);
  expectNoWalletWrites(calls);
});

test('persisted-wallet restore reads authorization and chain without prompting a switch', async ({ page }) => {
  await installMockWallet(page, { persist: true });
  await page.goto('/#/overview');

  await expect(page.getByRole('button', { name: /Mock Wallet menu/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Wrong network.*switch to Sepolia/i })).toBeVisible();
  await expect.poll(async () => (await walletCalls(page)).map((call) => call.method))
    .toEqual(expect.arrayContaining(['eth_accounts', 'eth_chainId']));

  const calls = await walletCalls(page);
  expect(new Set(calls.map((call) => call.method))).toEqual(new Set(['eth_accounts', 'eth_chainId']));
  expectNoWalletWrites(calls);
});

test('a pending switch from a disconnected wallet cannot satisfy the next wallet connection', async ({ page }) => {
  await installRacingWallets(page);
  await page.goto('/#/overview');

  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await page.getByRole('dialog', { name: 'Connect a wallet' })
    .getByRole('button', { name: /Alpha Wallet/ })
    .click();
  await expect(page.getByRole('button', { name: /Alpha Wallet menu/ })).toBeVisible();

  await page.getByRole('button', { name: /Alpha Wallet menu/ }).click();
  await page.getByRole('button', { name: /Disconnect/ }).click();
  await expect(page.getByRole('button', { name: 'Connect wallet' })).toBeVisible();

  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await page.getByRole('dialog', { name: 'Connect a wallet' })
    .getByRole('button', { name: /Beta Wallet/ })
    .click();
  await expect(page.locator('.toast')).toHaveText('Wallet connected and switched to Ethereum Sepolia.');

  const beforeRelease = await page.evaluate(() => (window as any).__veilguardWalletRace.calls);
  expect(beforeRelease.beta.filter((call: WalletCall) => call.method === 'wallet_switchEthereumChain')).toHaveLength(1);

  await page.evaluate(() => (window as any).__veilguardWalletRace.releaseAlpha());
  await expect(page.getByRole('button', { name: /Beta Wallet menu/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Alpha Wallet menu/ })).toHaveCount(0);

  const calls = await page.evaluate(() => (window as any).__veilguardWalletRace.calls);
  expectNoWalletWrites([...calls.alpha, ...calls.beta]);
});
