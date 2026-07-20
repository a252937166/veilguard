import { encodeAbiParameters, keccak256, stringToBytes } from 'viem';
import { ADDR, CHAIN_ID } from './config';

export type DemoScenarioKey = 'routine' | 'approval' | 'violation';

export type DemoScenario = {
  key: DemoScenarioKey;
  vendor: string;
  purpose: string;
  amount: string;
  recipient: `0x${string}`;
  urgency?: string;
  isolatedDelegate?: boolean;
};

export const DEMO_RECIPIENTS = {
  cloudNode: '0x04EBe79419f42f12748ABa1502331E336219B1F7',
  shieldOps: '0xe32148E45C3B1F8a692BeC3BAA0079AD103A4c6B',
  atlas: '0x6152F8EBE4e9B35C5042E095Fc0e4Af98C6A347d',
} as const satisfies Record<string, `0x${string}`>;

export const DEMO_SCENARIOS: readonly DemoScenario[] = [
  {
    key: 'routine',
    vendor: 'CloudNode',
    purpose: 'Infrastructure renewal',
    amount: '25',
    recipient: DEMO_RECIPIENTS.cloudNode,
  },
  {
    key: 'approval',
    vendor: 'ShieldOps',
    purpose: 'Emergency security response',
    amount: '60',
    recipient: DEMO_RECIPIENTS.shieldOps,
    urgency: 'Urgent',
  },
  {
    key: 'violation',
    vendor: 'Atlas Contractor',
    purpose: 'New supplier invoice',
    amount: '600',
    recipient: DEMO_RECIPIENTS.atlas,
    urgency: 'New counterparty',
    isolatedDelegate: true,
  },
] as const;

export const scenarioByKey = (key: DemoScenarioKey) =>
  DEMO_SCENARIOS.find((scenario) => scenario.key === key)!;

const MEMO_DOMAIN = keccak256(stringToBytes('VEILGUARD_DEMO_RUN_V1'));

/**
 * Binds a public-demo request to one browser run without exposing the run id.
 * The server recomputes this before exercising its tightly-scoped Safe power.
 */
export function demoMemoHash(
  runId: string,
  scenario: DemoScenarioKey,
  mandateId: bigint,
  delegate: `0x${string}`,
): `0x${string}` {
  return keccak256(encodeAbiParameters(
    [
      { type: 'bytes32' },
      { type: 'uint256' },
      { type: 'address' },
      { type: 'bytes32' },
      { type: 'bytes32' },
      { type: 'uint256' },
      { type: 'address' },
    ],
    [
      MEMO_DOMAIN,
      BigInt(CHAIN_ID),
      ADDR.VeilGuardModule,
      keccak256(stringToBytes(runId)),
      keccak256(stringToBytes(scenario)),
      mandateId,
      delegate,
    ],
  ));
}

export type DemoRequestIdentity = {
  id: string | number | bigint;
  mandateId: bigint;
  delegate: `0x${string}`;
  recipient: `0x${string}`;
  memoHash: `0x${string}`;
  state: number;
};

/**
 * Read-only recovery scan used before Restart. It does not trust the currently
 * selected card or local tracking record; the domain-separated on-chain memo
 * and scenario recipient must both match the active run.
 */
export function runBoundScenarioRequests<T extends DemoRequestIdentity>(
  runId: string,
  scenario: DemoScenarioKey,
  requests: readonly T[],
): T[] {
  const expectedRecipient = scenarioByKey(scenario).recipient.toLowerCase();
  return requests.filter((request) => request.recipient.toLowerCase() === expectedRecipient
    && request.memoHash.toLowerCase() === demoMemoHash(
      runId,
      scenario,
      request.mandateId,
      request.delegate,
    ).toLowerCase());
}

/**
 * Resolves narrative metadata only when the request cryptographically belongs
 * to this exact demo run. Recipient-only matching is intentionally forbidden:
 * Free Play may pay the same vendor with a different amount or purpose.
 */
export function trustedDemoScenarioForRequest<T extends DemoRequestIdentity>(
  runId: string | undefined,
  request: T | undefined,
): DemoScenario | undefined {
  if (!runId || !request) return undefined;
  return DEMO_SCENARIOS.find((scenario) => (
    runBoundScenarioRequests(runId, scenario.key, [request]).length === 1
  ));
}
