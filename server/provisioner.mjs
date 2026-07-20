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
 * POST /api/provision { address } -> { mandateId, proposeTx, activateTx }
 * POST /api/demo-decision { runId, requestId, action }
 * POST /api/demo-audit-packet { runId, requestIds }
 * POST /api/governance-execute { to, data, nonce, signer, signature }
 * GET  /api/health
 *
 * Env (see provisioner.env): ADMIN_KEY, SIGNER_B_KEY, MODULE, SAFE, RPC_URL,
 * GATEWAY_URL, PORT.
 */
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPublicClient, createWalletClient, http as viemHttp,
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
import { createSerialExecutor, sameAddressList } from './lib/demo-security.mjs';

const {
  ADMIN_KEY, SIGNER_B_KEY, MODULE, SAFE,
  RPC_URL = 'https://ethereum-sepolia-rpc.publicnode.com',
  GATEWAY_URL = 'https://gateway-testnets.noxprotocol.dev',
  NOX_COMPUTE = '0x24ef36ec5b626d7dcd09a98f3083c2758f0f77bf',
  SUBGRAPH_URL = 'https://thegraph.ethereum-sepolia-testnet.noxprotocol.io/api/subgraphs/id/9CsccKwvgYFo72zZeU4k4wj2NEBLdWhVE3EUandgmzgo',
  PORT = '4041',
  PROVISION_ENABLED = 'true',                       // emergency kill switch
  ALLOWED_ORIGIN = 'https://veilguard.axiqo.xyz',   // CORS lock
  MAX_PER_DAY = '20',                               // global daily mandate cap
  MAX_DEMO_AUDIT_PER_DAY = '20',                    // sponsored packet gas cap
} = process.env;

const enabled = PROVISION_ENABLED !== 'false';
const dayCap = Number(MAX_PER_DAY);
const auditDayCap = Number(MAX_DEMO_AUDIT_PER_DAY);
if (!Number.isInteger(dayCap) || dayCap < 1 || !Number.isInteger(auditDayCap) || auditDayCap < 1) {
  throw new Error('daily caps must be positive integers');
}

const ZERO = '0x0000000000000000000000000000000000000000';
const CHAIN_ID = 11155111n;
const usdc = (n) => BigInt(Math.round(n * 1e6));
// Sponsored demo policy: auto-execute ≤ 40, budget 300, reserve floor 100.
const POLICY = { autoLimit: usdc(40), budget: usdc(300), reserve: usdc(100), days: 30n };

const pub = createPublicClient({ chain: sepolia, transport: viemHttp(RPC_URL) });
const admin = privateKeyToAccount(ADMIN_KEY);
const signerB = privateKeyToAccount(SIGNER_B_KEY);
const adminWallet = createWalletClient({ account: admin, chain: sepolia, transport: viemHttp(RPC_URL) });
const signerBWallet = createWalletClient({ account: signerB, chain: sepolia, transport: viemHttp(RPC_URL) });

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
  const hash = await adminWallet.writeContract(params);
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error('admin transaction reverted');
  return hash;
});
const adminProposeMandate = (params) => withAdminLock(async () => {
  // Capture the contract-assigned id inside the same account nonce boundary;
  // reading nextMandateId after releasing the lock can attribute another
  // concurrent proposal to this caller.
  const mandateId = await pub.readContract({ address: MODULE, abi: MODULE_ABI, functionName: 'nextMandateId' });
  const hash = await adminWallet.writeContract(params);
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error('mandate proposal reverted');
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
const SWEEP_ENABLED = process.env.SWEEP_ENABLED !== 'false';
const SWEEP_MS = Number(process.env.SWEEP_MS ?? 15_000);
const finalizingIds = new Set();

async function decisionResolved(handle) {
  try {
    const r = await fetch(`${GATEWAY_URL}/v0/public/handles/status`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handles: [handle] }),
      signal: AbortSignal.timeout(6_000),
    });
    if (!r.ok) return false;
    const d = await r.json();
    return d?.payload?.statuses?.[0]?.resolved === true;
  } catch { return false; }
}

/** Finalize one request if it is still pending and its decision is provable. */
async function finalizeRequest(id) {
  id = BigInt(id);
  const key = String(id);
  if (finalizingIds.has(key)) return { skipped: 'in-flight' };
  const r = await pub.readContract({ address: MODULE, abi: MODULE_ABI, functionName: 'getRequest', args: [id] });
  if (Number(r[5]) !== 1) return { skipped: 'not-pending', state: Number(r[5]) };
  const decisionHandle = r[7];
  if (!(await decisionResolved(decisionHandle))) return { skipped: 'tee-not-ready' };
  finalizingIds.add(key);
  try {
    const hc = await getHandleClient();
    const { decryptionProof } = await hc.publicDecrypt(decisionHandle);
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
        if (!(await decisionResolved(r[7]))) continue;
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
        if (bal < GAS_FLOOR) {
          await adminSend(delegate, GAS_TOPUP);
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
            const hc = await getHandleClient();
            const budget = BigInt((await hc.decrypt(m[6])).value);
            if (budget < REFRESH_MIN_BUDGET) {
              needsFresh = true;
              console.log(`[demo] ${delegate} mandate #${id} budget ${budget} below floor — refreshing`);
            }
          } catch (e) {
            const msg = `${e?.shortMessage ?? e?.message ?? e}`;
            if (/not authorized|does not exist/i.test(msg)) {
              // pre-rotation mandate: its handles are granted to the RETIRED admin.
              // Replace it so the new admin can monitor the budget again.
              needsFresh = true;
              console.log(`[demo] ${delegate} mandate #${id} has legacy (pre-rotation) handles — refreshing`);
            } else { throw e; }
          }
        } else {
          console.log(`[demo] ${delegate} has no active mandate — provisioning`);
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
        console.log(`[demo] fresh mandate #${mandateId} activated for ${delegate} (2-of-2)`);
      } catch (e) {
        console.log(`[demo] ${delegate} refresh failed: ${e?.shortMessage ?? e?.message}`);
      }
    }
  } finally { refreshing = false; }
}

// ------- rate limiting -------
const lastByAddr = new Map();
const HOUR = 3600_000;
let inFlight = false;
let dayStart = 0;        // stamped lazily (Date.now unavailable pre-request in cron, fine here)
let dayCount = 0;

const moduleReadAbi = MODULE_ABI;

/** Idempotency: if this address already holds an active mandate, reuse it. */
async function existingActiveMandate(address) {
  const id = await pub.readContract({ address: MODULE, abi: moduleReadAbi, functionName: 'activeMandateOf', args: [address] });
  return id > 0n ? Number(id) : 0;
}

async function provision(address) {
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
  const hc = await getHandleClient();
  const budget = BigInt((await hc.decrypt(m[6])).value);
  budgetCache.set(delegate, { at: Date.now(), budget });
  return budget;
}
function kickRefresh() { lastBudgetCheck = 0; refreshDemoMandateIfDrained(); }

async function demoReady(delegate) {
  if (!isDemoDelegate(delegate)) return { ready: false, reason: 'not a demo delegate' };
  const mandateId = await pub.readContract({ address: MODULE, abi: MODULE_ABI, functionName: 'activeMandateOf', args: [delegate] });
  if (mandateId === 0n) { kickRefresh(); return { ready: false, reason: 'demo mandate is being provisioned — ready in ~2 min' }; }
  const mandate = await pub.readContract({ address: MODULE, abi: MODULE_ABI, functionName: 'getMandate', args: [mandateId] });
  if (!sameAddressList(mandate[8], DEMO_RECIPIENT_LIST)) {
    kickRefresh();
    return { ready: false, reason: 'demo recipient policy is being refreshed — ready in ~2 min' };
  }
  const cool = await pub.readContract({ address: MODULE, abi: MODULE_ABI, functionName: 'cooldownUntil', args: [delegate] });
  const coolLeft = Number(cool) - Math.floor(Date.now() / 1000);
  if (coolLeft > 0) return { ready: false, reason: 'anti-probing cooldown', cooldownLeft: coolLeft };
  const nextR = await pub.readContract({ address: MODULE, abi: MODULE_ABI, functionName: 'nextRequestId' });
  for (let i = nextR - 1n; i > 0n && i > nextR - 30n; i--) {
    const r = await pub.readContract({ address: MODULE, abi: MODULE_ABI, functionName: 'getRequest', args: [i] });
    if ([1, 3].includes(Number(r[5])) && r[1].toLowerCase() === delegate.toLowerCase()) {
      return { ready: false, reason: 'a payment is already in flight — it clears in under a minute' };
    }
  }
  const bal = await pub.getBalance({ address: delegate });
  if (bal < GAS_FLOOR) { kickRefresh(); return { ready: false, reason: 'demo delegate is being topped up with gas — retry in ~1 min' }; }
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
      const hc = await getHandleClient();
      return (await hc.decrypt(handle)).value;
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
    const now = Date.now();
    if (now - auditDayStart > 24 * HOUR) { auditDayStart = now; auditDayCount = 0; }
    if (auditDayCount >= auditDayCap) throw new HttpError(429, 'daily sponsored audit packet cap reached');
    await assertFinanceAdmin();
    const packetId = await pub.readContract({ address: MODULE, abi: MODULE_RUNTIME_ABI, functionName: 'nextPacketId' });
    const hash = await adminWallet.writeContract({
      address: MODULE, abi: MODULE_RUNTIME_ABI, functionName: 'createAuditPacket',
      args: [DEMO_AUDITOR, mandateId, requestIds],
    });
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== 'success') throw new Error('audit packet transaction reverted');
    auditDayCount++;
    const packet = await pub.readContract({ address: MODULE, abi: MODULE_RUNTIME_ABI, functionName: 'getAuditPacket', args: [packetId] });
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

const auditJobs = new Map();
let auditDayStart = 0;
let auditDayCount = 0;
function startDemoAuditPacket(input) {
  assertRunId(input.runId);
  if (!Array.isArray(input.requestIds)) throw new HttpError(400, 'requestIds must be an array');
  const ids = input.requestIds.map(requestIdFrom).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const key = `${input.runId}:${ids.map(String).join(',')}`;
  const existing = auditJobs.get(key);
  if (existing) return { processing: true };
  const promise = performDemoAuditPacket({ ...input, requestIds: ids });
  auditJobs.set(key, promise);
  promise.finally(() => auditJobs.delete(key)).catch(() => {});
  return { processing: false, promise };
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
  if (req.url === '/api/health') return json(res, 200, {
    ok: true, enabled, module: MODULE, safe: SAFE, dayCount, dayCap,
    sweep: SWEEP_ENABLED, finalizing: finalizingIds.size,
    decisions: demoDecisionService.processingCount, auditJobs: auditJobs.size,
    auditDayCount, auditDayCap,
    demoDecisionWindowSeconds: Math.floor(DEMO_DECISION_WINDOW_MS / 1000),
  });
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
        json(res, 200, await started.promise);
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
        const result = await finalizeRequest(BigInt(idStr));
        json(res, 200, { ok: true, ...result });
      } catch (e) {
        json(res, 500, { error: e?.shortMessage ?? e?.message ?? 'finalize failed' });
      }
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/api/provision') {
    if (!enabled) return json(res, 503, { error: 'self-service provisioning is currently disabled — use the shared demo Delegate/Auditor instead' });
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1000) req.destroy(); });
    req.on('end', async () => {
      try {
        const { address } = JSON.parse(body || '{}');
        if (!isAddress(address)) return json(res, 400, { error: 'invalid address' });
        const key = address.toLowerCase();

        // idempotent: reuse an already-active mandate instead of creating spam
        const existing = await existingActiveMandate(address);
        if (existing) return json(res, 200, { ok: true, mandateId: existing, reused: true });

        const prev = lastByAddr.get(key);
        if (prev && Date.now() - prev < HOUR) return json(res, 429, { error: 'already provisioned recently — one provision per address per hour' });

        // global daily cap (anti gas-drain / mandate-spam)
        const now = Date.now();
        if (now - dayStart > 24 * HOUR) { dayStart = now; dayCount = 0; }
        if (dayCount >= dayCap) return json(res, 429, { error: 'daily demo provisioning cap reached — please use the shared demo Delegate/Auditor for now' });

        if (inFlight) return json(res, 503, { error: 'another provisioning is in progress — try again in a few seconds' });
        inFlight = true;
        try {
          const result = await provision(address);
          lastByAddr.set(key, Date.now());
          dayCount++;
          json(res, 200, { ok: true, ...result });
        } finally { inFlight = false; }
      } catch (e) {
        console.error('provision error:', e?.shortMessage ?? e?.message ?? e);
        json(res, 500, { error: e?.shortMessage ?? e?.message ?? 'provisioning failed' });
      }
    });
    return;
  }
  json(res, 404, { error: 'not found' });
}).listen(Number(PORT), '127.0.0.1', () => console.log(`[provisioner] listening on 127.0.0.1:${PORT} · module ${MODULE}`));
