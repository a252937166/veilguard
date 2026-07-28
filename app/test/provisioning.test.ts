import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hashTypedData } from 'viem';
import { ADDR, CHAIN_ID, PROVISION_API, PROVISION_CHALLENGE_API } from '../src/config';
import {
  fetchProvisionAvailability,
  provisionConnectedWallet,
  validateProvisionChallenge,
} from '../src/provisioning';

const account = '0x1111111111111111111111111111111111111111' as const;
const nowMs = 1_000_000;
const expiresAtSeconds = Math.ceil((nowMs + 300_000) / 1000);
const challengeId = `0x${'12'.repeat(32)}` as const;
const signature = `0x${'34'.repeat(65)}` as const;

const canonicalChallenge = () => ({
  ok: true,
  challengeId,
  expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
  typedData: {
    domain: {
      name: 'VeilGuard Provisioning',
      version: '1',
      chainId: CHAIN_ID,
      verifyingContract: ADDR.VeilGuardModule,
    },
    types: {
      Provision: [
        { name: 'applicant', type: 'address' },
        { name: 'nonce', type: 'bytes32' },
        { name: 'expiresAt', type: 'uint64' },
      ],
    },
    primaryType: 'Provision',
    message: {
      applicant: account,
      nonce: challengeId,
      expiresAt: String(expiresAtSeconds),
    },
  },
});

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

beforeEach(() => vi.restoreAllMocks());

describe('provision health gate', () => {
  it('fails closed when the provision health contract is absent', async () => {
    const availability = await fetchProvisionAvailability(
      vi.fn(async () => response({ ok: true, sweep: true })) as any,
    );
    expect(availability.operational).toBe(false);
    expect(availability.detail).toMatch(/shared demo delegate/i);
  });

  it('opens only when challenge, treasury and deployment identity are all healthy', async () => {
    const availability = await fetchProvisionAvailability(
      vi.fn(async () => response({
        ok: true,
        module: ADDR.VeilGuardModule,
        safe: ADDR.Safe,
        provision: { enabled: true, operational: true, required: true, defaultEnabled: false },
        treasury: { topupEnabled: true, policyRefreshGuarded: true },
        rpc: { fallbackConfigured: true, broadcastStrategy: 'single-endpoint-no-retry' },
      })) as any,
    );
    expect(availability).toMatchObject({ operational: true });
  });

  it('rejects an operational response for another module', async () => {
    const availability = await fetchProvisionAvailability(
      vi.fn(async () => response({
        ok: true,
        module: '0x2222222222222222222222222222222222222222',
        safe: ADDR.Safe,
        provision: { enabled: true, operational: true, required: true, defaultEnabled: false },
        treasury: { topupEnabled: true, policyRefreshGuarded: true },
        rpc: { fallbackConfigured: true, broadcastStrategy: 'single-endpoint-no-retry' },
      })) as any,
    );
    expect(availability.operational).toBe(false);
  });
});

describe('provision challenge validation', () => {
  it('accepts only the exact canonical Sepolia challenge', () => {
    expect(validateProvisionChallenge(canonicalChallenge(), account, nowMs)).toMatchObject({
      challengeId,
      typedData: { primaryType: 'Provision' },
    });
  });

  it.each([
    ['chain', (value: any) => { value.typedData.domain.chainId = 1; }, /domain/i],
    ['module', (value: any) => { value.typedData.domain.verifyingContract = '0x2222222222222222222222222222222222222222'; }, /domain/i],
    ['applicant', (value: any) => { value.typedData.message.applicant = '0x2222222222222222222222222222222222222222'; }, /another wallet/i],
    ['nonce', (value: any) => { value.typedData.message.nonce = `0x${'99'.repeat(32)}`; }, /nonce is inconsistent/i],
    ['schema', (value: any) => { value.typedData.types.Provision[2].type = 'uint256'; }, /schema/i],
    ['extra domain field', (value: any) => { value.typedData.domain.salt = `0x${'77'.repeat(32)}`; }, /domain/i],
    ['expiry', (value: any) => { value.expiresAt = new Date(nowMs - 1_000).toISOString(); }, /expiry is inconsistent/i],
  ])('rejects a mismatched %s before opening a wallet prompt', (_label, mutate, pattern) => {
    const value = canonicalChallenge();
    mutate(value);
    expect(() => validateProvisionChallenge(value, account, nowMs)).toThrow(pattern);
  });
});

describe('wallet-verified provision flow', () => {
  it('sends a MetaMask/OKX-compatible canonical v4 payload, then posts the one-time proof', async () => {
    const phases: string[] = [];
    const walletRequests: Array<{ method: string; params?: any }> = [];
    const provider = {
      request: vi.fn(async (request: { method: string; params?: any }) => {
        walletRequests.push(request);
        if (request.method === 'eth_accounts') return [account];
        if (request.method === 'eth_signTypedData_v4') return signature;
        throw new Error(`unexpected wallet method ${request.method}`);
      }),
    };
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === PROVISION_CHALLENGE_API) {
        expect(JSON.parse(String(init?.body))).toEqual({ address: account });
        return response(canonicalChallenge());
      }
      if (url === PROVISION_API) {
        expect(JSON.parse(String(init?.body))).toEqual({
          address: account,
          challengeId,
          signature,
        });
        return response({ ok: true, mandateId: 17, reused: false });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    await expect(provisionConnectedWallet({
      account,
      provider,
      fetchFn: fetchFn as any,
      ensureNetwork: vi.fn(async () => CHAIN_ID),
      now: () => nowMs,
      onPhase: (phase) => phases.push(phase),
    })).resolves.toEqual({ mandateId: 17, reused: false });

    expect(phases).toEqual(['network', 'challenge', 'signing', 'provisioning']);
    expect(walletRequests.map(({ method }) => method)).toEqual([
      'eth_accounts',
      'eth_signTypedData_v4',
      'eth_accounts',
    ]);
    const signedPayload = JSON.parse(walletRequests[1].params[1]);
    expect(signedPayload.domain).toMatchObject({
      chainId: CHAIN_ID,
      verifyingContract: ADDR.VeilGuardModule,
    });
    expect(signedPayload.types).toEqual({
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      Provision: canonicalChallenge().typedData.types.Provision,
    });
    expect(signedPayload.primaryType).toBe('Provision');
    expect(signedPayload.message).toEqual(canonicalChallenge().typedData.message);
    expect(hashTypedData(signedPayload)).toBe(hashTypedData(canonicalChallenge().typedData));
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('never requests a challenge when the connected wallet account changed', async () => {
    const fetchFn = vi.fn();
    await expect(provisionConnectedWallet({
      account,
      provider: {
        request: vi.fn(async () => ['0x2222222222222222222222222222222222222222']),
      },
      fetchFn: fetchFn as any,
      ensureNetwork: vi.fn(async () => CHAIN_ID),
    })).rejects.toThrow(/account changed/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
