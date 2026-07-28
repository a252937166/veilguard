import { getTypesForEIP712Domain, serializeTypedData } from 'viem';
import { ADDR, CHAIN_ID, PROVISION_API, PROVISION_CHALLENGE_API } from './config';
import { ensureAccountOnSepolia, getActiveProvider } from './nox';
import type { Eip1193Provider } from './wallet';

export type ProvisionAvailability = {
  operational: boolean;
  detail: string;
};

export type ProvisionPhase = 'network' | 'challenge' | 'signing' | 'provisioning';

type ProvisionTypedData = {
  domain: {
    name: 'VeilGuard Provisioning';
    version: '1';
    chainId: number;
    verifyingContract: `0x${string}`;
  };
  types: {
    Provision: [
      { name: 'applicant'; type: 'address' },
      { name: 'nonce'; type: 'bytes32' },
      { name: 'expiresAt'; type: 'uint64' },
    ];
  };
  primaryType: 'Provision';
  message: {
    applicant: `0x${string}`;
    nonce: `0x${string}`;
    expiresAt: string;
  };
};

type ProvisionChallenge = {
  challengeId: `0x${string}`;
  expiresAt: string;
  typedData: ProvisionTypedData;
};

/**
 * EIP-1193 wallets expect the v4 wire payload to include the canonical
 * EIP712Domain schema. The provisioner intentionally omits that derived schema
 * from its challenge response, so add it locally and let viem normalize the
 * exact JSON sent to MetaMask/OKX.
 */
function serializeProvisionChallengeForWallet(challenge: ProvisionChallenge): string {
  const { domain, types, primaryType, message } = challenge.typedData;
  return serializeTypedData({
    domain,
    types: {
      EIP712Domain: getTypesForEIP712Domain({ domain }),
      ...types,
    },
    primaryType,
    // viem's type-level uint validation expects bigint even though the EIP-712
    // JSON wire representation is a decimal string.
    message: { ...message, expiresAt: BigInt(message.expiresAt) },
  } as any);
}

function addressEqual(actual: unknown, expected: string): boolean {
  return typeof actual === 'string'
    && /^0x[0-9a-fA-F]{40}$/.test(actual)
    && actual.toLowerCase() === expected.toLowerCase();
}

async function jsonResponse(response: Response, fallback: string): Promise<any> {
  let body;
  try { body = await response.json(); }
  catch { throw new Error(fallback); }
  if (!response.ok) throw new Error(body?.error ?? fallback);
  return body;
}

export async function fetchProvisionAvailability(
  fetchFn: typeof fetch = fetch,
): Promise<ProvisionAvailability> {
  try {
    const response = await fetchFn('/api/health', {
      signal: AbortSignal.timeout(6_000),
      headers: { Accept: 'application/json' },
    });
    const health = await jsonResponse(response, 'Provisioner health is unavailable');
    const operational = health?.ok === true
      && health?.provision?.enabled === true
      && health?.provision?.operational === true
      && health?.provision?.required === true
      && health?.provision?.defaultEnabled === false
      && health?.treasury?.topupEnabled === true
      && health?.treasury?.policyRefreshGuarded === true
      && health?.rpc?.fallbackConfigured === true
      && health?.rpc?.broadcastStrategy === 'single-endpoint-no-retry'
      && addressEqual(health?.module, ADDR.VeilGuardModule)
      && addressEqual(health?.safe, ADDR.Safe);
    return {
      operational,
      detail: operational
        ? 'Wallet-verified sponsored onboarding is available'
        : 'Self-service onboarding is closed; use the pre-funded shared demo delegate',
    };
  } catch {
    return {
      operational: false,
      detail: 'Self-service onboarding cannot be verified; use the pre-funded shared demo delegate',
    };
  }
}

/**
 * Validate every security-relevant field before asking an injected wallet to
 * sign. This prevents a compromised/misrouted API from turning onboarding into
 * an arbitrary EIP-712 signature prompt.
 */
export function validateProvisionChallenge(
  payload: unknown,
  account: `0x${string}`,
  nowMs = Date.now(),
): ProvisionChallenge {
  const candidate = payload as any;
  const challengeId = candidate?.challengeId;
  const typedData = candidate?.typedData;
  const domain = typedData?.domain;
  const message = typedData?.message;
  const provisionTypes = typedData?.types?.Provision;
  const exactKeys = (value: unknown, expected: string[]) => (
    !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
  );

  if (!/^0x[0-9a-fA-F]{64}$/.test(challengeId ?? '')) {
    throw new Error('Provisioner returned an invalid challenge nonce');
  }
  if (
    !exactKeys(typedData, ['domain', 'types', 'primaryType', 'message'])
    || !exactKeys(domain, ['name', 'version', 'chainId', 'verifyingContract'])
    || domain?.name !== 'VeilGuard Provisioning'
    || domain?.version !== '1'
    || domain?.chainId !== CHAIN_ID
    || !addressEqual(domain?.verifyingContract, ADDR.VeilGuardModule)
  ) {
    throw new Error('Provisioner challenge domain does not match VeilGuard on Sepolia');
  }
  if (typedData?.primaryType !== 'Provision') {
    throw new Error('Provisioner challenge has an unexpected primary type');
  }
  const expectedTypes = [
    ['applicant', 'address'],
    ['nonce', 'bytes32'],
    ['expiresAt', 'uint64'],
  ];
  if (
    !exactKeys(typedData?.types, ['Provision'])
    || !Array.isArray(provisionTypes)
    || provisionTypes.length !== expectedTypes.length
    || provisionTypes.some((field: any, index: number) =>
      field?.name !== expectedTypes[index][0] || field?.type !== expectedTypes[index][1])
  ) {
    throw new Error('Provisioner challenge schema is not canonical');
  }
  if (!addressEqual(message?.applicant, account)) {
    throw new Error('Provisioner challenge is bound to another wallet');
  }
  if (!exactKeys(message, ['applicant', 'nonce', 'expiresAt'])) {
    throw new Error('Provisioner challenge message is not canonical');
  }
  if (
    typeof message?.nonce !== 'string'
    || message.nonce.toLowerCase() !== challengeId.toLowerCase()
  ) {
    throw new Error('Provisioner challenge nonce is inconsistent');
  }

  if (!/^\d{1,20}$/.test(message?.expiresAt ?? '')) {
    throw new Error('Provisioner challenge expiry is invalid');
  }
  let messageExpiry;
  try { messageExpiry = BigInt(message.expiresAt); }
  catch { throw new Error('Provisioner challenge expiry is invalid'); }
  const responseExpiry = Date.parse(candidate?.expiresAt);
  if (
    messageExpiry < 1n
    || !Number.isSafeInteger(Number(messageExpiry))
    || !Number.isFinite(responseExpiry)
    || Number(messageExpiry) * 1_000 !== responseExpiry
    || new Date(responseExpiry).toISOString() !== candidate?.expiresAt
  ) {
    throw new Error('Provisioner challenge expiry is inconsistent');
  }
  const remainingMs = responseExpiry - nowMs;
  if (remainingMs < 15_000 || remainingMs > 15 * 60_000 + 1_000) {
    throw new Error('Provisioner challenge is expired or outside the allowed lifetime');
  }

  return candidate as ProvisionChallenge;
}

export async function provisionConnectedWallet({
  account,
  onPhase,
  fetchFn = fetch,
  provider = getActiveProvider(),
  now = () => Date.now(),
  ensureNetwork = ensureAccountOnSepolia,
}: {
  account: `0x${string}`;
  onPhase?: (phase: ProvisionPhase) => void;
  fetchFn?: typeof fetch;
  provider?: Eip1193Provider;
  now?: () => number;
  ensureNetwork?: typeof ensureAccountOnSepolia;
}): Promise<{ mandateId: number; reused: boolean }> {
  if (!provider) throw new Error('No injected wallet provider is connected');

  onPhase?.('network');
  const chainId = await ensureNetwork(account);
  if (chainId !== CHAIN_ID) throw new Error('Wallet is not connected to Ethereum Sepolia');
  const accounts = (await provider.request({ method: 'eth_accounts' })) as unknown;
  if (
    !Array.isArray(accounts)
    || !accounts.some((candidate) => addressEqual(candidate, account))
  ) {
    throw new Error('Connected wallet account changed before provisioning');
  }

  onPhase?.('challenge');
  const challengeResponse = await fetchFn(PROVISION_CHALLENGE_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: account }),
    signal: AbortSignal.timeout(10_000),
  });
  const challengePayload = await jsonResponse(challengeResponse, 'Could not create provisioning challenge');
  const challenge = validateProvisionChallenge(challengePayload, account, now());

  onPhase?.('signing');
  const signature = await provider.request({
    method: 'eth_signTypedData_v4',
    params: [account, serializeProvisionChallengeForWallet(challenge)],
  });
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new Error('Wallet returned an invalid provisioning signature');
  }
  const accountsAfterSigning = (await provider.request({ method: 'eth_accounts' })) as unknown;
  if (
    !Array.isArray(accountsAfterSigning)
    || !accountsAfterSigning.some((candidate) => addressEqual(candidate, account))
  ) {
    throw new Error('Connected wallet account changed after signing');
  }

  onPhase?.('provisioning');
  const provisionResponse = await fetchFn(PROVISION_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      address: account,
      challengeId: challenge.challengeId,
      signature,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const result = await jsonResponse(provisionResponse, 'Provisioning failed');
  const mandateId = Number(result?.mandateId);
  if (!Number.isSafeInteger(mandateId) || mandateId < 1) {
    throw new Error('Provisioner returned an invalid mandate id');
  }
  return { mandateId, reused: result?.reused === true };
}
