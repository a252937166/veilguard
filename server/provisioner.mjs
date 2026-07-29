/**
 * VeilGuard provisioner — sponsored delegate onboarding.
 *
 * A visitor connects THEIR OWN wallet and asks to become a delegate. This
 * service (holding the finance-admin + both Safe-owner keys server-side, never
 * in the browser) proposes an encrypted mandate for that address and activates
 * it with a REAL 2-of-2 Safe multisig — exactly how a treasury would onboard a
 * delegate in production. The visitor then submits requestSpend from their own
 * wallet (their own signature, their own gas).
 *
 * POST /api/provision-challenge { address } -> EIP-712 ownership challenge
 * POST /api/provision { address, challengeId, signature } -> mandate result
 * POST /api/demo-decision { runId, requestId, action }
 * POST /api/demo-audit-packet { runId, requestIds }
 * POST /api/governance-execute { to, data, nonce, signer, signature }
 * GET  /api/health
 *
 * Env (see server/OPERATIONS.md): ADMIN_KEY, SIGNER_B_KEY, MODULE, SAFE,
 * RPC_URL, RPC_FALLBACK_URLS, GATEWAY_URL and PORT.
 */
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPublicClient, createWalletClient,
  decodeFunctionData, encodeAbiParameters, encodeFunctionData, isAddress,
  keccak256, parseAbi, parseSignature, recoverTypedDataAddress, stringToBytes,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { createViemHandleClient } from '@iexec-nox/handle';
import MODULE_ABI from './module-frag.json' with { type: 'json' };
import {
  assertDemoRunId,
  assertDemoScenarioIdentity,
  createDemoDecisionService,
  createFileDecisionStore,
  parseDemoRequestId,
  verifyDemoAmount,
} from './lib/demo-decision.mjs';
import { createSerialExecutor, recentRequestIds, sameAddressList } from './lib/demo-security.mjs';
import { createSingleFlight } from './lib/single-flight.mjs';
import { createProvisionChallengeService } from './lib/provision-security.mjs';
import { createGuardedRpcFallback, parseRpcUrls } from './lib/rpc-fallback.mjs';
import { createTreasuryReadinessJournal } from './lib/treasury-readiness.mjs';
import {
  areNoxHandlesResolved,
  resolveThenRetryNoxRead,
  waitUntilNoxSimulatable,
} from './lib/nox-production.mjs';
import { requireSingleReceiptEvent } from './lib/receipt-events.mjs';
import { createSponsoredRateLimitJournal } from './lib/sponsored-rate-limit.mjs';
import { maybeTopUpDemoGas } from './lib/demo-gas-topup.mjs';

const {
  ADMIN_KEY, SIGNER_B_KEY, MODULE, SAFE,
  RPC_URL = 'https://ethereum-sepolia-rpc.publicnode.com',
  RPC_FALLBACK_URLS = '',
  GATEWAY_URL = 'https://gateway-testnets.noxprotocol.dev',
  NOX_COMPUTE = '0x24ef36ec5b626d7dcd09a98f3083c2758f0f77bf',
  SUBGRAPH_URL = 'https://thegraph.ethereum-sepolia-testnet.noxprotocol.io/api/subgraphs/id/9CsccKwvgYFo72zZeU4k4wj2NEBLdWhVE3EUandgmzgo',
  PORT = '4041',
  PROVISION_ENABLED = 'false',                      // opt-in; wallet challenge is mandatory
  PROVISION_CHALLENGE_TTL_MS = '300000',
  ALLOWED_ORIGIN = 'https://veilguard.axiqo.xyz',   // CORS lock
  MAX_PER_DAY = '20',                               // global daily mandate cap
  MAX_DEMO_AUDIT_PER_DAY = '20',                    // sponsored packet gas cap
  DEMO_TREASURY_TOPUP_ENABLED = 'false',
  DEMO_GAS_TOPUP_ENABLED = 'false',
  DEMO_TREASURY_TOPUP_USDC = '400',
  TEST_USDC,
  CONFIDENTIAL_USDC,
} = process.env;

function strictFlag(name, value) {
  if (value !== 'true' && value !== 'false') throw new Error(`${name} must be exactly true or false`);
  return value === 'true';
}

const enabled = strictFlag('PROVISION_ENABLED', PROVISION_ENABLED);
const treasuryTopupEnabled = strictFlag('DEMO_TREASURY_TOPUP_ENABLED', DEMO_TREASURY_TOPUP_ENABLED);
const demoGasTopupEnabled = strictFlag('DEMO_GAS_TOPUP_ENABLED', DEMO_GAS_TOPUP_ENABLED);
const dayCap = Number(MAX_PER_DAY);
const auditDayCap = Number(MAX_DEMO_AUDIT_PER_DAY);
if (!Number.isInteger(dayCap) || dayCap < 1 || !Number.isInteger(auditDayCap) || auditDayCap < 1) {
  throw new Error('daily caps must be positive integers');
}

const ZERO = '0x0000000000000000000000000000000000000000';
const CHAIN_ID = 11155111n;
const HOUR = 3_600_000;
const usdc = (n) => BigInt(Math.round(n * 1e6));
// Sponsored demo policy: auto-execute ≤ 40, budget 300, reserve floor 100.
const POLICY = { autoLimit: usdc(40), budget: usdc(300), reserve: usdc(100), days: 30n };

function parseUsdcAmount(name, value) {
  if (!/^\d+(?:\.\d{1,6})?$/.test(value)) throw new Error(`${name} must be a non-negative USDC amount`);
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}

const treasuryTopupRaw = parseUsdcAmount('DEMO_TREASURY_TOPUP_USDC', DEMO_TREASURY_TOPUP_USDC);
const minimumTreasuryTopupRaw = POLICY.budget + POLICY.reserve;
if (treasuryTopupEnabled) {
  if (!isAddress(TEST_USDC) || !isAddress(CONFIDENTIAL_USDC)) {
    throw new Error('TEST_USDC and CONFIDENTIAL_USDC are required when demo treasury top-up is enabled');
  }
  if (treasuryTopupRaw < minimumTreasuryTopupRaw) {
    throw new Error('DEMO_TREASURY_TOPUP_USDC must cover the full demo budget plus reserve floor');
  }
}

const rpcUrls = parseRpcUrls(
  RPC_URL,
  RPC_FALLBACK_URLS,
  sepolia.rpcUrls.default.http,
);
const rpc = createGuardedRpcFallback({ urls: rpcUrls, chainId: CHAIN_ID });
const pub = createPublicClient({ chain: sepolia, transport: rpc.transport });
const admin = privateKeyToAccount(ADMIN_KEY);
const signerB = privateKeyToAccount(SIGNER_B_KEY);
const adminWallet = createWalletClient({ account: admin, chain: sepolia, transport: rpc.transport });
const signerBWallet = createWalletClient({ account: signerB, chain: sepolia, transport: rpc.transport });

const challengeTtlMs = Number(PROVISION_CHALLENGE_TTL_MS);
const provisionChallenges = createProvisionChallengeService({
  chainId: CHAIN_ID,
  module: MODULE,
  ttlMs: challengeTtlMs,
});
const provisionRateLimits = createSponsoredRateLimitJournal({
  filePath: process.env.PROVISION_RATE_JOURNAL_PATH
    ?? join(tmpdir(), `veilguard-provision-rate-${MODULE.toLowerCase()}.json`),
  domain: { kind: 'provision', chainId: CHAIN_ID, module: MODULE, safe: SAFE },
  dailyCap: dayCap,
  subjectWindowMs: HOUR,
});
await provisionRateLimits.load();
const auditRateLimits = createSponsoredRateLimitJournal({
  filePath: process.env.DEMO_AUDIT_RATE_JOURNAL_PATH
    ?? join(tmpdir(), `veilguard-audit-rate-${MODULE.toLowerCase()}.json`),
  domain: { kind: 'audit-packet', chainId: CHAIN_ID, module: MODULE, safe: SAFE },
  dailyCap: auditDayCap,
});
await auditRateLimits.load();

const safeAbi = [
  { type: 'function', name: 'nonce', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'getOwners', stateMutability: 'view', inputs: [], outputs: [{ type: 'address[]' }] },
  { type: 'function', name: 'getThreshold', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'execTransaction', stateMutability: 'payable', inputs: [
    { type: 'address' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'uint8' },
    { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' },
    { type: 'address' }, { type: 'bytes' }], outputs: [{ type: 'bool' }] },
];

const GOVERNANCE_ABI = parseAbi([
  'function activateMandate(uint256 mandateId)',
  'function executeEscalated(uint256 requestId)',
  'function cancelEscalated(uint256 requestId)',
  'function retireMandate(uint256 mandateId)',
  'function unpauseAll()',
]);
const MODULE_RUNTIME_ABI = parseAbi([
  'function financeAdmin() view returns (address)',
  'function nextPacketId() view returns (uint256)',
  'function getAuditPacket(uint256 packetId) view returns (address auditor,uint256 mandateId,uint32 policyVersion,bytes32 manifestHash,uint64 createdAt,uint256[] requestIds,bytes32[] snapshotHandles)',
  'function createAuditPacket(address auditor,uint256 mandateId,uint256[] requestIds) returns (uint256 packetId)',
]);
const MODULE_EVENT_ABI = parseAbi([
  'event MandateProposed(uint256 indexed mandateId,address indexed delegate,uint32 version)',
  'event AuditPacketCreated(uint256 indexed packetId,address indexed auditor,uint256 indexed mandateId,bytes32 manifestHash)',
]);

// Every Safe action shares one critical section. The nonce read, state
// revalidation, signatures, broadcast and receipt all happen under this lock;
// otherwise a watchdog cancellation can invalidate a browser-signed nonce.
const withSafeLock = createSerialExecutor();

function safeMessage(to, data, nonce) {
  return {
    to, value: 0n, data, operation: 0,
    safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: ZERO, refundReceiver: ZERO, nonce,
  };
}

function sortedSignatures(parts) {
  return `0x${parts
    .sort((a, b) => (a.addr.toLowerCase() < b.addr.toLowerCase() ? -1 : 1))
    .map((s) => s.sig.slice(2)).join('')}`;
}

async function broadcastSafe(message, signatures, onProgress) {
  await onProgress?.({ phase: 'broadcasting' });
  const hash = await signerBWallet.writeContract({
    address: SAFE, abi: safeAbi, functionName: 'execTransaction',
    args: [message.to, 0n, message.data, 0, 0n, 0n, 0n, ZERO, ZERO, signatures],
  });
  // Publish and persist the transaction hash before the potentially slow
  // receipt wait so browsers can recover without inviting a duplicate click.
  await onProgress?.({ phase: 'confirming', hash });
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error('Safe execTransaction reverted');
  return hash;
}

// ------- Safe v1.4.1 EIP-712 2-of-2 (pure viem, no API key) -------
async function safeExec2of2Unlocked(to, data, onProgress) {
  await onProgress?.({ phase: 'signing' });
  const nonce = await pub.readContract({ address: SAFE, abi: safeAbi, functionName: 'nonce' });
  const domain = { chainId: CHAIN_ID, verifyingContract: SAFE };
  const types = {
    SafeTx: [
      { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' }, { name: 'operation', type: 'uint8' },
      { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' },
      { name: 'refundReceiver', type: 'address' }, { name: 'nonce', type: 'uint256' },
    ],
  };
  const message = safeMessage(to, data, nonce);
  const sigA = await admin.signTypedData({ domain, types, primaryType: 'SafeTx', message });
  const sigB = await signerB.signTypedData({ domain, types, primaryType: 'SafeTx', message });
  // Safe requires signatures sorted by signer address ascending, concatenated.
  const signers = [
    { addr: admin.address.toLowerCase(), sig: sigA },
    { addr: signerB.address.toLowerCase(), sig: sigB },
  ];
  const signatures = sortedSignatures(signers);
  // sanity: ensure v is 27/28 (viem returns that for EIP-712)
  for (const s of signers) { const { v } = parseSignature(s.sig); if (v !== 27n && v !== 28n) throw new Error('unexpected sig v'); }

  return broadcastSafe(message, signatures, onProgress);
}

const safeExec2of2 = (to, data) => withSafeLock(() => safeExec2of2Unlocked(to, data));

// ---- Verified GOVERNANCE-ONLY Safe execution ----
// signerB (Safe owner B) stays server-side. It only co-signs a canonical SafeTx
// already signed by the other current owner, then broadcasts it under the same
// Safe nonce lock used by the watchdog and provisioner.
const GOV_FUNCTIONS = new Set(['activateMandate', 'executeEscalated', 'cancelEscalated', 'retireMandate', 'unpauseAll']);

const SAFE_TX_TYPES = {
  SafeTx: [
    { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' }, { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' }, { name: 'nonce', type: 'uint256' },
  ],
};

class HttpError extends Error {
  constructor(status, message, details = undefined) {
    super(message); this.status = status; this.details = details;
  }
}

function canonicalGovernanceData(data) {
  let decoded;
  try { decoded = decodeFunctionData({ abi: GOVERNANCE_ABI, data }); }
  catch { throw new HttpError(400, 'governance call is not decodable'); }
  if (!GOV_FUNCTIONS.has(decoded.functionName)) throw new HttpError(403, 'governance action is not allowed');
  const canonical = encodeFunctionData({ abi: GOVERNANCE_ABI, functionName: decoded.functionName, args: decoded.args });
  if (canonical.toLowerCase() !== data.toLowerCase()) throw new HttpError(400, 'governance calldata is not canonical');
  return decoded;
}

async function governanceExecute({ to, data, nonce, signer, signature }) {
  if (!isAddress(to) || to.toLowerCase() !== MODULE.toLowerCase()) throw new HttpError(403, 'target is not the VeilGuard module');
  if (typeof data !== 'string' || !/^0x[0-9a-fA-F]+$/.test(data)) throw new HttpError(400, 'bad calldata');
  if (!isAddress(signer) || !/^0x[0-9a-fA-F]{130}$/.test(signature ?? '')) throw new HttpError(400, 'bad owner A signature');
  if (!/^\d{1,30}$/.test(String(nonce))) throw new HttpError(400, 'bad Safe nonce');
  canonicalGovernanceData(data);

  return withSafeLock(async () => {
    const [onchainNonce, owners, threshold] = await Promise.all([
      pub.readContract({ address: SAFE, abi: safeAbi, functionName: 'nonce' }),
      pub.readContract({ address: SAFE, abi: safeAbi, functionName: 'getOwners' }),
      pub.readContract({ address: SAFE, abi: safeAbi, functionName: 'getThreshold' }),
    ]);
    if (BigInt(nonce) !== onchainNonce) throw new HttpError(409, 'Safe nonce changed — sign the action again');
    if (threshold !== 2n) throw new HttpError(503, 'Safe threshold is not the expected 2-of-2');
    const ownerSet = new Set(owners.map((o) => o.toLowerCase()));
    if (!ownerSet.has(signer.toLowerCase()) || signer.toLowerCase() === signerB.address.toLowerCase()) {
      throw new HttpError(403, 'signer is not the current owner A');
    }
    if (!ownerSet.has(signerB.address.toLowerCase())) throw new HttpError(503, 'server signer is no longer a Safe owner');

    const domain = { chainId: CHAIN_ID, verifyingContract: SAFE };
    const message = safeMessage(to, data, onchainNonce);
    const recovered = await recoverTypedDataAddress({
      domain, types: SAFE_TX_TYPES, primaryType: 'SafeTx', message, signature,
    });
    if (recovered.toLowerCase() !== signer.toLowerCase()) throw new HttpError(403, 'owner A signature does not match signer');

    const sigB = await signerB.signTypedData({ domain, types: SAFE_TX_TYPES, primaryType: 'SafeTx', message });
    const signatures = sortedSignatures([{ addr: signer, sig: signature }, { addr: signerB.address, sig: sigB }]);
    const hash = await broadcastSafe(message, signatures);
    return { hash, nonce: Number(onchainNonce) };
  });
}

// Serialize admin-wallet txs — finalize, provisioning and the demo-mandate
// watchdog all sign with the same account; without a lock they race on nonces.
const withAdminLock = createSerialExecutor();
const adminWrite = (params) => withAdminLock(async () => {
  const estimatedGas = await waitUntilNoxSimulatable(
    'finalize proof exact estimate',
    () => pub.estimateContractGas({ ...params, account: admin }),
  );
  const hash = await adminWallet.writeContract({ ...params, gas: estimatedGas * 125n / 100n });
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error('admin transaction reverted');
  return hash;
});
const adminProposeMandate = (params) => withAdminLock(async () => {
  // Retry only the exact read-only estimate while fresh Nox external inputs
  // propagate. The write is opened exactly once after this barrier succeeds.
  const estimatedGas = await waitUntilNoxSimulatable(
    'proposeMandate external-input exact estimate',
    () => pub.estimateContractGas({ ...params, account: admin }),
  );
  const hash = await adminWallet.writeContract({ ...params, gas: estimatedGas * 125n / 100n });
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error('mandate proposal reverted');
  const event = requireSingleReceiptEvent({
    abi: MODULE_EVENT_ABI,
    contract: MODULE,
    receipt: rc,
    eventName: 'MandateProposed',
    label: 'mandate proposal receipt',
  });
  const mandateId = BigInt(event.args.mandateId);
  if (
    mandateId < 1n
    || String(event.args.delegate).toLowerCase() !== String(params.args[0]).toLowerCase()
    || BigInt(event.args.version) !== mandateId
  ) {
    throw new Error('MandateProposed event does not match the submitted proposal');
  }
  return { hash, mandateId };
});

let handleClient;
async function getHandleClient() {
  if (!handleClient) {
    handleClient = await createViemHandleClient(
      { ...adminWallet, getAddresses: async () => [admin.address] },
      { smartContractAddress: NOX_COMPUTE, gatewayUrl: GATEWAY_URL, subgraphUrl: SUBGRAPH_URL },
    );
  }
  return handleClient;
}

// ------- proof-gated finalize (keeper) -------
// Anyone may submit finalize(id, proof); the on-chain proof decides the outcome,
// so this courier can only DELAY a result, never change one. Running it here lets
// the delegate's outcome just "appear" with no second wallet popup.
const SWEEP_ENABLED = strictFlag('SWEEP_ENABLED', process.env.SWEEP_ENABLED ?? 'true');
const SWEEP_MS = Number(process.env.SWEEP_MS ?? 15_000);
const finalizingIds = new Set();
const NOX_STATUS_URL = `${GATEWAY_URL}/v0/public/handles/status`;

async function decryptNoxHandle(label, handle) {
  const hc = await getHandleClient();
  return resolveThenRetryNoxRead({
    statusUrl: NOX_STATUS_URL,
    handles: [handle],
    label,
    operation: () => hc.decrypt(handle),
    usability: {
      shouldRetry: (error) => !/not authorized|does not exist|permission/i.test(
        `${error?.shortMessage ?? error?.message ?? error}`,
      ),
    },
  });
}

/** Finalize one request if it is still pending and its decision is provable. */
async function finalizeRequest(id) {
  id = BigInt(id);
  const key = String(id);
  if (finalizingIds.has(key)) return { skipped: 'in-flight' };
  // Own the request before the first RPC/Gateway await. The HTTP courier and
  // background sweep can discover the same ready handle in the same frame;
  // locking later would allow both to decrypt and compete for the admin nonce.
  finalizingIds.add(key);
  try {
    const r = await pub.readContract({ address: MODULE, abi: MODULE_ABI, functionName: 'getRequest', args: [id] });
    if (Number(r[5]) !== 1) return { skipped: 'not-pending', state: Number(r[5]) };
    const decisionHandle = r[7];
    if (!(await areNoxHandlesResolved(NOX_STATUS_URL, [decisionHandle]))) {
      return { skipped: 'tee-not-ready' };
    }
    const hc = await getHandleClient();
    const { decryptionProof } = await resolveThenRetryNoxRead({
      statusUrl: NOX_STATUS_URL,
      handles: [decisionHandle],
      label: 'provisioner decision public decrypt',
      operation: () => hc.publicDecrypt(decisionHandle),
    });
    const hash = await adminWrite({
      address: MODULE, abi: MODULE_ABI, functionName: 'finalize', args: [id, decryptionProof],
    });
    return { ok: true, hash };
  } finally { finalizingIds.delete(key); }
}

/**
 * Background sweep: self-heal pending requests whose TEE decision is provable.
 * Escalations are never silently approved. Unanswered demo approvals are
 * cancelled after three minutes, returning escrow and restoring the budget.
 */
const DEMO_DECISION_WINDOW_MS = Number(process.env.DEMO_DECISION_WINDOW_MS ?? 3 * 60_000);
const NON_DEMO_CANCEL_MS = Number(process.env.NON_DEMO_CANCEL_MS ?? 30 * 60_000);
if (!Number.isFinite(DEMO_DECISION_WINDOW_MS) || DEMO_DECISION_WINDOW_MS < 60_000) {
  throw new Error('DEMO_DECISION_WINDOW_MS must be at least 60000');
}
const isDemoDelegate = (a) => DEMO_DELEGATES.some((d) => d.toLowerCase() === a.toLowerCase());
const safeActionIds = new Set();
let sweeping = false;
async function sweepFinalize() {
  if (sweeping) return;
  sweeping = true;
  try {
    const nextId = await pub.readContract({ address: MODULE, abi: MODULE_ABI, functionName: 'nextRequestId' });
    for (let i = 1n; i < nextId; i++) {
      const key = String(i);
      if (finalizingIds.has(key) || safeActionIds.has(key)) continue;
      const r = await pub.readContract({ address: MODULE, abi: MODULE_ABI, functionName: 'getRequest', args: [i] });
      const state = Number(r[5]);
      if (state === 1) {
        if (!(await areNoxHandlesResolved(NOX_STATUS_URL, [r[7]]))) continue;
        try { await finalizeRequest(i); console.log(`[sweep] finalized #${i}`); }
        catch (e) { console.log(`[sweep] #${i} finalize failed: ${e?.shortMessage ?? e?.message}`); }
      } else if (state === 3) {
        const cancelAfter = isDemoDelegate(r[1]) ? DEMO_DECISION_WINDOW_MS : NON_DEMO_CANCEL_MS;
        safeActionIds.add(key);
        try {
          const result = await demoDecisionService.expire({ requestId: i, windowMs: cancelAfter });
          if (result.ok) console.log(`[sweep] escalation #${i} expired unapproved — cancelled by committee ${result.hash}`);
        } catch (e) {
          console.log(`[sweep] #${i} cancel failed: ${e?.shortMessage ?? e?.message}`);
        } finally { safeActionIds.delete(key); }
      }
    }
  } catch (e) {
    console.log(`[sweep] error: ${e?.shortMessage ?? e?.message}`);
  } finally {
    sweeping = false;
    void refreshDemoMandateIfDrained().catch((e) => console.log(`[demo] refresh failed: ${e?.shortMessage ?? e?.message}`));
  }
}
if (SWEEP_ENABLED) setInterval(sweepFinalize, SWEEP_MS);

// ---- shared-demo watchdog: keep BOTH demo delegates deterministic ----
// The public demo policy is auto≤40 / budget 300 / reserve 100. The watchdog
// (a) self-provisions a mandate for any demo delegate that lacks one (this is
// how the violation delegate bootstraps), (b) replaces mandates whose budget
// dropped below the floor, and (c) tops up the delegates' Sepolia gas — so
// every judge sees reproducible outcomes with zero manual setup.
const DEMO_RECIPIENTS = Object.freeze({
  routine: process.env.DEMO_CLOUDNODE_RECIPIENT ?? process.env.DEMO_RECIPIENT ?? '0x04EBe79419f42f12748ABa1502331E336219B1F7',
  approval: process.env.DEMO_SHIELDOPS_RECIPIENT ?? '0xe32148E45C3B1F8a692BeC3BAA0079AD103A4c6B',
  violation: process.env.DEMO_ATLAS_RECIPIENT ?? '0x6152F8EBE4e9B35C5042E095Fc0e4Af98C6A347d',
});
const DEMO_RECIPIENT_LIST = Object.values(DEMO_RECIPIENTS);
const DEMO_DELEGATES = [
  process.env.DEMO_DELEGATE ?? '0x17ee5ad7e4b40cadafad27c5f68f74d02c7fd532',        // main demo delegate (guided missions)
  process.env.VIOLATION_DELEGATE ?? '0xdfc0c6e0baed0948d8ba22a4917438938f2a40f4',   // blocked-scenario delegate
  process.env.FREEPLAY_DELEGATE ?? '0x2fc2dc420540b3a93d6fa45f07c536c305a96497',    // free-play delegate (visitor sandboxing)
];
const DEMO_AUDITOR = process.env.DEMO_AUDITOR ?? '0x09eeE433992D869A7f3a572CC6AB9068B426C0A6';
for (const [key, address] of Object.entries({ ...DEMO_RECIPIENTS, auditor: DEMO_AUDITOR })) {
  if (!isAddress(address)) throw new Error(`invalid demo ${key} address`);
}
if (new Set(DEMO_RECIPIENT_LIST.map((a) => a.toLowerCase())).size !== DEMO_RECIPIENT_LIST.length) {
  throw new Error('demo recipient addresses must be distinct');
}
const REFRESH_MIN_BUDGET = usdc(150);
const REFRESH_CHECK_MS = Number(process.env.REFRESH_CHECK_MS ?? 2 * 60_000);
const GAS_FLOOR = 3n * 10n ** 15n;   // 0.003 ETH
const GAS_TOPUP = 10n * 10n ** 15n;  // 0.01 ETH
const treasuryReadinessPath = process.env.TREASURY_READINESS_JOURNAL_PATH
  ?? join(tmpdir(), `veilguard-treasury-readiness-${MODULE.toLowerCase()}.json`);
const treasuryReadiness = createTreasuryReadinessJournal({
  filePath: treasuryReadinessPath,
  module: MODULE,
  safe: SAFE,
});
await treasuryReadiness.load();
let lastTreasuryError = null;
let lastTreasuryTopupAt = null;

const testUsdcAbi = [
  {
    type: 'function', name: 'faucet', stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }], outputs: [],
  },
  {
    type: 'function', name: 'approve', stateMutability: 'nonpayable',
    inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ type: 'bool' }],
  },
];
const confidentialUsdcAbi = [{
  type: 'function', name: 'wrap', stateMutability: 'nonpayable',
  inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
  outputs: [{ type: 'bytes32' }],
}];

async function fundDemoTreasury() {
  if (!treasuryTopupEnabled) {
    throw new HttpError(
      503,
      'demo treasury top-up is disabled; refusing to refresh a policy budget without backing assets',
    );
  }
  try {
    const result = await withAdminLock(async () => {
      const send = async (params, label) => {
        const hash = await adminWallet.writeContract(params);
        const receipt = await pub.waitForTransactionReceipt({ hash });
        if (receipt.status !== 'success') throw new Error(`${label} reverted`);
        return hash;
      };
      await send({
        address: TEST_USDC, abi: testUsdcAbi, functionName: 'faucet',
        args: [treasuryTopupRaw],
      }, 'treasury faucet');
      await send({
        address: TEST_USDC, abi: testUsdcAbi, functionName: 'approve',
        args: [CONFIDENTIAL_USDC, treasuryTopupRaw],
      }, 'treasury wrapper approval');
      await send({
        address: CONFIDENTIAL_USDC, abi: confidentialUsdcAbi, functionName: 'wrap',
        args: [SAFE, treasuryTopupRaw],
      }, 'treasury wrap');
      return { fundedAt: new Date().toISOString(), topupRaw: treasuryTopupRaw };
    });
    lastTreasuryTopupAt = result.fundedAt;
    lastTreasuryError = null;
    return result;
  } catch (error) {
    lastTreasuryError = error?.shortMessage ?? error?.message ?? 'treasury top-up failed';
    throw error;
  }
}

const adminSend = (to, value) => withAdminLock(async () => {
  const hash = await adminWallet.sendTransaction({ to, value });
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error('admin transfer reverted');
  return hash;
});

let refreshing = false;
let lastBudgetCheck = 0;

async function refreshDemoMandateIfDrained() {
  if (refreshing || Date.now() - lastBudgetCheck < REFRESH_CHECK_MS) return;
  lastBudgetCheck = Date.now();
  refreshing = true;
  try {
    for (const delegate of DEMO_DELEGATES) {
      try {
        // gas top-up
        const bal = await pub.getBalance({ address: delegate });
        const gasReadiness = await maybeTopUpDemoGas({
          balance: bal,
          floor: GAS_FLOOR,
          enabled: demoGasTopupEnabled,
          topup: () => adminSend(delegate, GAS_TOPUP),
        });
        if (!gasReadiness.ready) {
          console.log(`[demo] ${delegate} gas is below the floor; automatic top-up is disabled`);
          continue;
        }
        if (gasReadiness.toppedUp) {
          console.log(`[demo] topped up ${delegate} with 0.01 ETH gas`);
        }
        // mandate freshness
        const id = await pub.readContract({ address: MODULE, abi: MODULE_ABI, functionName: 'activeMandateOf', args: [delegate] });
        let needsFresh = id === 0n;
        if (!needsFresh) {
          try {
            const m = await pub.readContract({ address: MODULE, abi: MODULE_ABI, functionName: 'getMandate', args: [id] });
            if (!sameAddressList(m[8], DEMO_RECIPIENT_LIST)) {
              needsFresh = true;
              console.log(`[demo] ${delegate} mandate #${id} recipient schema is stale — refreshing`);
            }
            const budget = BigInt((await decryptNoxHandle(
              'watchdog mandate budget decrypt',
              m[6],
            )).value);
            if (budget < REFRESH_MIN_BUDGET) {
              needsFresh = true;
              console.log(`[demo] ${delegate} mandate #${id} budget ${budget} below floor — refreshing`);
            }
          } catch (e) {
            const msg = `${e?.shortMessage ?? e?.message ?? e}`;
            if (
              /not authorized|does not exist/i.test(msg)
              || e?.code === 'NOX_OPERATION_NOT_RETRYABLE'
            ) {
              // pre-rotation mandate: its handles are granted to the RETIRED admin.
              // Replace it so the new admin can monitor the budget again.
              needsFresh = true;
              console.log(`[demo] ${delegate} mandate #${id} has legacy (pre-rotation) handles — refreshing`);
            } else { throw e; }
          }
        } else {
          console.log(`[demo] ${delegate} has no active mandate — provisioning`);
        }
        if (
          !needsFresh
          && (
            !treasuryTopupEnabled
            || !treasuryReadiness.isReady(delegate, id, minimumTreasuryTopupRaw)
          )
        ) {
          needsFresh = true;
          console.log(`[demo] ${delegate} mandate #${id} lacks treasury funding evidence — refreshing fail-closed`);
        }
        if (!needsFresh) continue;
        // an in-flight request occupies the slot; activation would revert — retry next cycle
        const nextR = await pub.readContract({ address: MODULE, abi: MODULE_ABI, functionName: 'nextRequestId' });
        let busySlot = false;
        for (let i = 1n; i < nextR; i++) {
          const r = await pub.readContract({ address: MODULE, abi: MODULE_ABI, functionName: 'getRequest', args: [i] });
          if ([1, 3].includes(Number(r[5])) && r[1].toLowerCase() === delegate.toLowerCase()) { busySlot = true; break; }
        }
        if (busySlot) continue;
        // Never reset a confidential policy budget unless backing test assets
        // were explicitly added to the Safe first. This top-up is intentionally
        // separate from the encrypted policy values and cannot alter a decision
        // by loosening its limit, budget or reserve floor.
        const funding = await fundDemoTreasury();
        const hc = await getHandleClient();
        const [l, b, f] = await Promise.all([
          hc.encryptInput(POLICY.autoLimit, 'uint256', MODULE),
          hc.encryptInput(POLICY.budget, 'uint256', MODULE),
          hc.encryptInput(POLICY.reserve, 'uint256', MODULE),
        ]);
        const now = BigInt(Math.floor(Date.now() / 1000));
        const { mandateId } = await adminProposeMandate({
          address: MODULE, abi: MODULE_ABI, functionName: 'proposeMandate',
          args: [delegate, 0n, now + POLICY.days * 86_400n, DEMO_RECIPIENT_LIST,
            l.handle, l.handleProof, b.handle, b.handleProof, f.handle, f.handleProof],
        });
        await safeExec2of2(MODULE, encodeFunctionData({ abi: MODULE_ABI, functionName: 'activateMandate', args: [mandateId] }));
        await treasuryReadiness.record({
          delegate,
          mandateId,
          topupRaw: funding.topupRaw,
          fundedAt: funding.fundedAt,
        });
        console.log(`[demo] fresh mandate #${mandateId} activated for ${delegate} (2-of-2)`);
      } catch (e) {
        console.log(`[demo] ${delegate} refresh failed: ${e?.shortMessage ?? e?.message}`);
      }
    }
  } finally { refreshing = false; }
}

// ------- rate limiting -------
let inFlight = false;

const moduleReadAbi = MODULE_ABI;

/** Idempotency: if this address already holds an active mandate, reuse it. */
async function existingActiveMandate(address) {
  const id = await pub.readContract({ address: MODULE, abi: moduleReadAbi, functionName: 'activeMandateOf', args: [address] });
  return id > 0n ? Number(id) : 0;
}

async function provision(address) {
  const funding = await fundDemoTreasury();
  const hc = await getHandleClient();
  const [l, b, f] = await Promise.all([
    hc.encryptInput(POLICY.autoLimit, 'uint256', MODULE),
    hc.encryptInput(POLICY.budget, 'uint256', MODULE),
    hc.encryptInput(POLICY.reserve, 'uint256', MODULE),
  ]);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const proposal = await adminProposeMandate({
    address: MODULE, abi: MODULE_ABI, functionName: 'proposeMandate',
    args: [address, 0n, now + POLICY.days * 86_400n, [address],
      l.handle, l.handleProof, b.handle, b.handleProof, f.handle, f.handleProof],
  });
  const { hash: proposeTx, mandateId } = proposal;

  const activateData = encodeFunctionData({ abi: MODULE_ABI, functionName: 'activateMandate', args: [mandateId] });
  const activateTx = await safeExec2of2(MODULE, activateData);
  await treasuryReadiness.record({
    delegate: address,
    mandateId,
    topupRaw: funding.topupRaw,
    fundedAt: funding.fundedAt,
  });

  return { mandateId: Number(mandateId), proposeTx, activateTx };
}

// ------- demo readiness probe -------
// "Run scenario" must be deterministic: before running, the client asks whether
// this delegate is actually ready (mandate, slot, cooldown, gas, budget). If it
// is not, we kick an async refresh and tell the client why.
const budgetCache = new Map(); // delegate -> { at, budget }
async function delegateBudget(delegate, mandateId) {
  const c = budgetCache.get(delegate);
  if (c && Date.now() - c.at < 60_000) return c.budget;
  const m = await pub.readContract({ address: MODULE, abi: MODULE_ABI, functionName: 'getMandate', args: [mandateId] });
  const budget = BigInt((await decryptNoxHandle(
    'demo readiness mandate budget decrypt',
    m[6],
  )).value);
  budgetCache.set(delegate, { at: Date.now(), budget });
  return budget;
}
function kickRefresh() {
  lastBudgetCheck = 0;
  void refreshDemoMandateIfDrained()
    .catch((error) => console.log(`[demo] refresh failed: ${error?.shortMessage ?? error?.message}`));
}

async function demoReady(delegate) {
  if (!isDemoDelegate(delegate)) return { ready: false, reason: 'not a demo delegate' };
  const mandateId = await pub.readContract({ address: MODULE, abi: MODULE_ABI, functionName: 'activeMandateOf', args: [delegate] });
  if (mandateId === 0n) { kickRefresh(); return { ready: false, reason: 'demo mandate is being provisioned — ready in ~2 min' }; }
  const mandate = await pub.readContract({ address: MODULE, abi: MODULE_ABI, functionName: 'getMandate', args: [mandateId] });
  if (!sameAddressList(mandate[8], DEMO_RECIPIENT_LIST)) {
    kickRefresh();
    return { ready: false, reason: 'demo recipient policy is being refreshed — ready in ~2 min' };
  }
  if (
    !treasuryTopupEnabled
    || !treasuryReadiness.isReady(delegate, mandateId, minimumTreasuryTopupRaw)
  ) {
    kickRefresh();
    return {
      ready: false,
      reason: treasuryTopupEnabled
        ? 'demo treasury funding evidence is being refreshed — ready in ~2 min'
        : 'demo treasury top-up is disabled — policy budget will not be refreshed without backing assets',
    };
  }
  const cool = await pub.readContract({ address: MODULE, abi: MODULE_ABI, functionName: 'cooldownUntil', args: [delegate] });
  const coolLeft = Number(cool) - Math.floor(Date.now() / 1000);
  if (coolLeft > 0) return { ready: false, reason: 'anti-probing cooldown', cooldownLeft: coolLeft };
  const nextR = await pub.readContract({ address: MODULE, abi: MODULE_ABI, functionName: 'nextRequestId' });
  const recentIds = recentRequestIds(nextR);
  const recent = recentIds.length ? await pub.multicall({
    allowFailure: true,
    contracts: recentIds.map((requestId) => ({
      address: MODULE,
      abi: MODULE_ABI,
      functionName: 'getRequest',
      args: [requestId],
    })),
  }) : [];
  for (const item of recent) {
    if (item.status !== 'success') throw item.error;
    const r = item.result;
    if ([1, 3].includes(Number(r[5])) && r[1].toLowerCase() === delegate.toLowerCase()) {
      return { ready: false, reason: 'a payment is already in flight — it clears in under a minute' };
    }
  }
  const bal = await pub.getBalance({ address: delegate });
  if (bal < GAS_FLOOR) {
    if (!demoGasTopupEnabled) {
      return { ready: false, reason: 'demo delegate gas is below the required floor and automatic top-up is disabled' };
    }
    kickRefresh();
    return { ready: false, reason: 'demo delegate is being topped up with gas — retry in ~1 min' };
  }
  try {
    const budget = await delegateBudget(delegate, mandateId);
    if (budget < REFRESH_MIN_BUDGET) { kickRefresh(); return { ready: false, reason: 'demo budget is being refreshed — ready in ~2 min' }; }
  } catch { /* budget probe failing is not fatal — the request itself will tell */ }
  return { ready: true };
}

// ------- run-bound judge decisions -------
// The run id never appears in plaintext on-chain. The request memo commits to
// it together with the scenario, mandate and delegate, preventing a visitor
// from using this endpoint to approve an unrelated escalation.
const DEMO_SCENARIOS = Object.freeze({
  routine: { delegateIndex: 0, recipient: DEMO_RECIPIENTS.routine, amount: usdc(25), states: new Set([2]) },
  approval: { delegateIndex: 0, recipient: DEMO_RECIPIENTS.approval, amount: usdc(60), states: new Set([2, 5]) },
  violation: { delegateIndex: 1, recipient: DEMO_RECIPIENTS.violation, amount: usdc(600), states: new Set([4]) },
});

const assertRunId = assertDemoRunId;
const requestIdFrom = parseDemoRequestId;

async function assertFinanceAdmin() {
  const current = await pub.readContract({ address: MODULE, abi: MODULE_RUNTIME_ABI, functionName: 'financeAdmin' });
  if (current.toLowerCase() !== admin.address.toLowerCase()) {
    throw new HttpError(503, 'configured finance admin is not the current on-chain finance admin');
  }
}

function assertScenarioIdentity(r, runId, scenario) {
  const spec = DEMO_SCENARIOS[scenario];
  return assertDemoScenarioIdentity({
    request: r,
    runId,
    scenarioName: scenario,
    spec: spec ? { ...spec, delegate: DEMO_DELEGATES[spec.delegateIndex] } : undefined,
    chainId: CHAIN_ID,
    module: MODULE,
  });
}

async function decryptAndVerifyAmount(r, spec) {
  return verifyDemoAmount({
    request: r,
    spec,
    assertFinanceAdmin,
    decryptAmount: async (handle) => {
      return (await decryptNoxHandle('demo request amount decrypt', handle)).value;
    },
  });
}

const decisionJournalPath = process.env.DEMO_DECISION_JOURNAL_PATH
  ?? join(tmpdir(), `veilguard-demo-decisions-${MODULE.toLowerCase()}.json`);
const demoDecisionService = createDemoDecisionService({
  readRequest: (id) => pub.readContract({
    address: MODULE, abi: MODULE_ABI, functionName: 'getRequest', args: [id],
  }),
  assertIdentity: (request, runId) => assertScenarioIdentity(request, runId, 'approval'),
  verifyAmount: decryptAndVerifyAmount,
  readActiveMandate: (delegate) => pub.readContract({
    address: MODULE, abi: MODULE_ABI, functionName: 'activeMandateOf', args: [delegate],
  }),
  executeUnlocked: (id, action, onProgress) => {
    const functionName = action === 'approve' ? 'executeEscalated' : 'cancelEscalated';
    const data = encodeFunctionData({ abi: MODULE_ABI, functionName, args: [id] });
    return safeExec2of2Unlocked(MODULE, data, onProgress);
  },
  recoverBroadcast: async (hash) => {
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error('Safe execTransaction reverted');
    return receipt;
  },
  withSafeLock,
  store: createFileDecisionStore(decisionJournalPath),
  decisionWindowMs: DEMO_DECISION_WINDOW_MS,
});
// ------- run-bound audit packet bundles -------
async function validateAuditRequest(runId, id) {
  const r = await pub.readContract({ address: MODULE, abi: MODULE_ABI, functionName: 'getRequest', args: [id] });
  let scenario;
  for (const [candidate, spec] of Object.entries(DEMO_SCENARIOS)) {
    if (
      r[1].toLowerCase() === DEMO_DELEGATES[spec.delegateIndex].toLowerCase()
      && r[2].toLowerCase() === spec.recipient.toLowerCase()
    ) { scenario = candidate; break; }
  }
  if (!scenario) throw new HttpError(403, `request #${id} is not a Launch Day scenario`);
  const spec = assertScenarioIdentity(r, runId, scenario);
  if (!spec.states.has(Number(r[5]))) throw new HttpError(409, `request #${id} is not in the required terminal state`);
  await decryptAndVerifyAmount(r, spec);
  return { id, mandateId: r[0], scenario, state: Number(r[5]) };
}

function sameIds(a, b) {
  return a.length === b.length && a.every((id, index) => BigInt(id) === BigInt(b[index]));
}

async function findAuditPacket(mandateId, requestIds) {
  const next = await pub.readContract({ address: MODULE, abi: MODULE_RUNTIME_ABI, functionName: 'nextPacketId' });
  const floor = next > 200n ? next - 200n : 1n;
  let cursor = next - 1n;
  while (cursor >= floor) {
    const ids = [];
    while (ids.length < 20 && cursor >= floor) { ids.push(cursor); cursor--; }
    const results = await pub.multicall({
      allowFailure: true,
      contracts: ids.map((id) => ({
        address: MODULE, abi: MODULE_RUNTIME_ABI, functionName: 'getAuditPacket', args: [id],
      })),
    });
    for (let index = 0; index < results.length; index++) {
      if (results[index].status !== 'success') continue;
      const packet = results[index].result;
      if (
        packet[0].toLowerCase() === DEMO_AUDITOR.toLowerCase()
        && packet[1] === mandateId
        && sameIds(packet[5], requestIds)
      ) return { packetId: ids[index], manifestHash: packet[3], reused: true };
    }
  }
  return null;
}

async function createOrReuseAuditPacket(mandateId, requestIds) {
  return withAdminLock(async () => {
    const existing = await findAuditPacket(mandateId, requestIds);
    if (existing) return existing;
    await assertFinanceAdmin();
    // Consume persistent sponsored quota before any estimate or broadcast.
    await auditRateLimits.consume('audit-packet');
    const params = {
      address: MODULE, abi: MODULE_RUNTIME_ABI, functionName: 'createAuditPacket',
      args: [DEMO_AUDITOR, mandateId, requestIds],
    };
    const estimatedGas = await waitUntilNoxSimulatable(
      'createAuditPacket exact estimate',
      () => pub.estimateContractGas({ ...params, account: admin }),
    );
    const hash = await adminWallet.writeContract({ ...params, gas: estimatedGas * 125n / 100n });
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== 'success') throw new Error('audit packet transaction reverted');
    const event = requireSingleReceiptEvent({
      abi: MODULE_EVENT_ABI,
      contract: MODULE,
      receipt: rc,
      eventName: 'AuditPacketCreated',
      label: 'audit packet receipt',
    });
    const packetId = BigInt(event.args.packetId);
    if (
      packetId < 1n
      || String(event.args.auditor).toLowerCase() !== DEMO_AUDITOR.toLowerCase()
      || BigInt(event.args.mandateId) !== BigInt(mandateId)
    ) {
      throw new Error('AuditPacketCreated event does not match the submitted packet');
    }
    const packet = await pub.readContract({ address: MODULE, abi: MODULE_RUNTIME_ABI, functionName: 'getAuditPacket', args: [packetId] });
    if (
      packet[0].toLowerCase() !== DEMO_AUDITOR.toLowerCase()
      || BigInt(packet[1]) !== BigInt(mandateId)
      || !sameIds(packet[5], requestIds)
      || String(packet[3]).toLowerCase() !== String(event.args.manifestHash).toLowerCase()
    ) {
      throw new Error('stored audit packet does not match its receipt event');
    }
    return { packetId, manifestHash: packet[3], hash, reused: false };
  });
}

async function performDemoAuditPacket({ runId, requestIds }) {
  assertRunId(runId);
  if (!Array.isArray(requestIds) || requestIds.length < 1 || requestIds.length > 8) {
    throw new HttpError(400, 'select between 1 and 8 requestIds');
  }
  const ids = requestIds.map(requestIdFrom).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (new Set(ids.map(String)).size !== ids.length) throw new HttpError(400, 'requestIds must be unique');
  const verified = await Promise.all(ids.map((id) => validateAuditRequest(runId, id)));
  const groups = new Map();
  for (const request of verified) {
    const key = String(request.mandateId);
    if (!groups.has(key)) groups.set(key, { mandateId: request.mandateId, requestIds: [] });
    groups.get(key).requestIds.push(request.id);
  }

  const packets = [];
  for (const group of [...groups.values()].sort((a, b) => (a.mandateId < b.mandateId ? -1 : 1))) {
    const result = await createOrReuseAuditPacket(group.mandateId, group.requestIds);
    packets.push({
      packetId: Number(result.packetId), mandateId: Number(group.mandateId),
      requestIds: group.requestIds.map(Number), manifestHash: result.manifestHash,
      tx: result.hash, reused: result.reused,
    });
  }
  const packetIds = packets.map((p) => BigInt(p.packetId));
  const bundleId = keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256[]' }],
    [keccak256(stringToBytes(runId)), MODULE, packetIds],
  ));
  return {
    ok: true, bundleId, bundleKind: 'ui-aggregate', onchainObject: false,
    auditor: DEMO_AUDITOR, packets,
    selectedRequests: verified.map(({ id, scenario, state }) => ({ requestId: Number(id), scenario, state })),
    fixedPolicyFields: ['autoLimit', 'budgetLeft', 'reserveFloor'],
  };
}

// Multi-mandate packet creation spans several Sepolia transactions and can
// outlive any sane browser timeout. The job is acknowledged with 202 up front
// and continues server-owned; polls of the same scope key pick up the cached
// terminal result (success stays redeliverable, an error is delivered once).
const auditFlights = createSingleFlight();
function startDemoAuditPacket(input) {
  assertRunId(input.runId);
  if (!Array.isArray(input.requestIds)) throw new HttpError(400, 'requestIds must be an array');
  const ids = input.requestIds.map(requestIdFrom).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const key = `${input.runId}:${ids.map(String).join(',')}`;
  return auditFlights.take(key, () => performDemoAuditPacket({ ...input, requestIds: ids }));
}

// ------- http -------
const json = (res, code, obj) => {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  });
  res.end(JSON.stringify(obj));
};
const parseJsonObject = (body) => {
  let value;
  try { value = JSON.parse(body || '{}'); }
  catch { throw new HttpError(400, 'request body must be valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'request body must be a JSON object');
  return value;
};

http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  if (req.url === '/api/health') {
    const treasuryStatus = treasuryReadiness.status();
    const provisionRateStatus = provisionRateLimits.status();
    const auditRateStatus = auditRateLimits.status();
    return json(res, 200, {
      ok: true, enabled, module: MODULE, safe: SAFE,
      dayCount: provisionRateStatus.dailyCount, dayCap,
      provision: {
        enabled,
        operational: enabled
          && treasuryTopupEnabled
          && provisionRateStatus.healthy
          && provisionRateStatus.remainingToday > 0,
        defaultEnabled: false,
        rateLimit: provisionRateStatus,
        ...provisionChallenges.status(),
      },
      treasury: {
        topupEnabled: treasuryTopupEnabled,
        gasTopupEnabled: demoGasTopupEnabled,
        policyRefreshGuarded: true,
        configuredTopupRaw: String(treasuryTopupRaw),
        requiredTopupRaw: String(minimumTreasuryTopupRaw),
        lastTopupAt: lastTreasuryTopupAt,
        lastTopupFailed: lastTreasuryError !== null,
        ...treasuryStatus,
      },
      rpc: rpc.status(),
      sweep: SWEEP_ENABLED, finalizing: finalizingIds.size,
      decisions: demoDecisionService.processingCount, auditJobs: auditFlights.inFlight,
      auditDayCount: auditRateStatus.dailyCount, auditDayCap,
      auditRateLimit: auditRateStatus,
      demoDecisionWindowSeconds: Math.floor(DEMO_DECISION_WINDOW_MS / 1000),
    });
  }
  if (req.method === 'POST' && req.url === '/api/cosign') {
    return json(res, 410, { error: 'legacy co-sign endpoint removed; use /api/governance-execute' });
  }
  if (req.method === 'POST' && req.url === '/api/governance-execute') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 12_000) req.destroy(); });
    req.on('end', async () => {
      try {
        const result = await governanceExecute(parseJsonObject(body));
        json(res, 200, { ok: true, ...result });
      } catch (e) {
        json(res, e?.status ?? 500, { error: e?.shortMessage ?? e?.message ?? 'governance execution failed', ...(e?.details ? { details: e.details } : {}) });
      }
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/api/demo-decision') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1200) req.destroy(); });
    req.on('end', async () => {
      try {
        const result = await demoDecisionService.handle(parseJsonObject(body));
        json(res, result.status, result.body);
      } catch (e) {
        json(res, e?.status ?? 500, { error: e?.shortMessage ?? e?.message ?? 'demo decision failed', ...(e?.details ? { details: e.details } : {}) });
      }
    });
    return;
  }
  if (req.method === 'GET' && req.url?.startsWith('/api/demo-decision?')) {
    void (async () => {
      try {
        const url = new URL(req.url, 'http://localhost');
        const result = await demoDecisionService.attest({
          runId: url.searchParams.get('runId'),
          requestId: url.searchParams.get('requestId'),
        });
        json(res, result.status, result.body);
      } catch (e) {
        json(res, e?.status ?? 500, { error: e?.shortMessage ?? e?.message ?? 'decision attestation failed' });
      }
    })();
    return;
  }
  if (req.method === 'POST' && req.url === '/api/demo-audit-packet') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2000) req.destroy(); });
    req.on('end', async () => {
      try {
        const started = startDemoAuditPacket(parseJsonObject(body));
        if (started.processing) return json(res, 202, { ok: true, processing: true });
        if (started.error) throw started.error;
        json(res, 200, started.result);
      } catch (e) {
        json(res, e?.status ?? 500, { error: e?.shortMessage ?? e?.message ?? 'audit packet creation failed', ...(e?.details ? { details: e.details } : {}) });
      }
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/api/demo-ready') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 300) req.destroy(); });
    req.on('end', async () => {
      try {
        const { delegate } = JSON.parse(body || '{}');
        if (!isAddress(delegate)) return json(res, 400, { error: 'bad delegate' });
        json(res, 200, await demoReady(delegate));
      } catch (e) {
        json(res, 500, { error: e?.shortMessage ?? e?.message ?? 'probe failed' });
      }
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/api/finalize') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 200) req.destroy(); });
    req.on('end', async () => {
      try {
        const { requestId } = JSON.parse(body || '{}');
        const idStr = String(requestId);
        if (!/^\d{1,9}$/.test(idStr) || Number(idStr) < 1) return json(res, 400, { error: 'bad requestId' });
        const parsedRequestId = BigInt(idStr);
        if (!finalizingIds.has(idStr)) {
          // Proof generation plus a Sepolia receipt can outlive a browser or
          // reverse-proxy request timeout. Accept the idempotent courier job
          // immediately and let the client follow the exact request on-chain.
          void finalizeRequest(parsedRequestId).then((result) => {
            if (result?.hash) console.log(`[finalize] request #${idStr} published ${result.hash}`);
          }).catch((error) => {
            console.log(`[finalize] request #${idStr} failed: ${error?.shortMessage ?? error?.message ?? error}`);
          });
        }
        json(res, 202, { ok: true, processing: true, requestId: Number(parsedRequestId) });
      } catch (e) {
        json(res, 500, { error: e?.shortMessage ?? e?.message ?? 'finalize failed' });
      }
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/api/provision-challenge') {
    if (!enabled) {
      return json(res, 503, {
        error: 'self-service provisioning is currently disabled — use the shared demo Delegate/Auditor instead',
      });
    }
    if (!treasuryTopupEnabled) {
      return json(res, 503, {
        error: 'self-service provisioning is unavailable until treasury top-up is configured',
      });
    }
    const rateStatus = provisionRateLimits.status();
    if (!rateStatus.healthy) {
      return json(res, 503, {
        error: 'self-service provisioning is unavailable while persistent rate accounting is unhealthy',
      });
    }
    if (rateStatus.remainingToday <= 0) {
      return json(res, 429, {
        error: 'daily demo provisioning cap reached — use the shared demo Delegate/Auditor for now',
      });
    }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 500) req.destroy(); });
    req.on('end', () => {
      try {
        const { address } = parseJsonObject(body);
        json(res, 200, { ok: true, ...provisionChallenges.issue(address) });
      } catch (e) {
        json(res, e?.status ?? 500, { error: e?.message ?? 'challenge creation failed' });
      }
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/api/provision') {
    if (!enabled) return json(res, 503, { error: 'self-service provisioning is currently disabled — use the shared demo Delegate/Auditor instead' });
    if (!treasuryTopupEnabled) {
      return json(res, 503, {
        error: 'self-service provisioning is unavailable until treasury top-up is configured',
      });
    }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1000) req.destroy(); });
    req.on('end', async () => {
      try {
        const { address, challengeId, signature } = parseJsonObject(body);
        if (!isAddress(address)) return json(res, 400, { error: 'invalid address' });
        await provisionChallenges.verify({ address, challengeId, signature });
        // idempotent: reuse an already-active mandate instead of creating spam
        const existing = await existingActiveMandate(address);
        if (existing) return json(res, 200, { ok: true, mandateId: existing, reused: true });

        if (inFlight) return json(res, 503, { error: 'another provisioning is in progress — try again in a few seconds' });
        inFlight = true;
        try {
          // Persist quota consumption before treasury funding, proof creation or
          // any broadcast. A crash/ambiguous response cannot reopen the budget.
          await provisionRateLimits.consume(address);
          const result = await provision(address);
          json(res, 200, { ok: true, ...result });
        } finally { inFlight = false; }
      } catch (e) {
        console.error('provision error:', e?.shortMessage ?? e?.message ?? e);
        json(res, e?.status ?? 500, { error: e?.shortMessage ?? e?.message ?? 'provisioning failed' });
      }
    });
    return;
  }
  json(res, 404, { error: 'not found' });
}).listen(Number(PORT), '127.0.0.1', () => console.log(`[provisioner] listening on 127.0.0.1:${PORT} · module ${MODULE}`));
