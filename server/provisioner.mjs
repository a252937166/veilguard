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
 * GET  /api/health
 *
 * Env (see provisioner.env): ADMIN_KEY, SIGNER_B_KEY, MODULE, SAFE, RPC_URL,
 * GATEWAY_URL, PORT.
 */
import http from 'node:http';
import {
  createPublicClient, createWalletClient, http as viemHttp,
  encodeFunctionData, hashTypedData, isAddress, parseSignature, toFunctionSelector,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { createViemHandleClient } from '@iexec-nox/handle';
import MODULE_ABI from './module-frag.json' with { type: 'json' };

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
} = process.env;

const enabled = PROVISION_ENABLED !== 'false';
const dayCap = Number(MAX_PER_DAY);

const ZERO = '0x0000000000000000000000000000000000000000';
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
  { type: 'function', name: 'execTransaction', stateMutability: 'payable', inputs: [
    { type: 'address' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'uint8' },
    { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' },
    { type: 'address' }, { type: 'bytes' }], outputs: [{ type: 'bool' }] },
];

// ------- Safe v1.4.1 EIP-712 2-of-2 (pure viem, no API key) -------
async function safeExec2of2(to, data) {
  const nonce = await pub.readContract({ address: SAFE, abi: safeAbi, functionName: 'nonce' });
  const domain = { chainId: 11155111, verifyingContract: SAFE };
  const types = {
    SafeTx: [
      { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' }, { name: 'operation', type: 'uint8' },
      { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' },
      { name: 'refundReceiver', type: 'address' }, { name: 'nonce', type: 'uint256' },
    ],
  };
  const message = {
    to, value: 0n, data, operation: 0,
    safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: ZERO, refundReceiver: ZERO, nonce,
  };
  const sigA = await admin.signTypedData({ domain, types, primaryType: 'SafeTx', message });
  const sigB = await signerB.signTypedData({ domain, types, primaryType: 'SafeTx', message });
  // Safe requires signatures sorted by signer address ascending, concatenated.
  const signers = [
    { addr: admin.address.toLowerCase(), sig: sigA },
    { addr: signerB.address.toLowerCase(), sig: sigB },
  ].sort((a, b) => (a.addr < b.addr ? -1 : 1));
  const signatures = ('0x' + signers.map((s) => s.sig.slice(2)).join('')) ;
  // sanity: ensure v is 27/28 (viem returns that for EIP-712)
  for (const s of signers) { const { v } = parseSignature(s.sig); if (v !== 27n && v !== 28n) throw new Error('unexpected sig v'); }

  const hash = await signerBWallet.writeContract({
    address: SAFE, abi: safeAbi, functionName: 'execTransaction',
    args: [to, 0n, data, 0, 0n, 0n, 0n, ZERO, ZERO, signatures],
  });
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error('Safe execTransaction reverted');
  return hash;
}

// ---- Owner-B co-signature for GOVERNANCE-ONLY Safe txs ----
// signerB (Safe owner B) stays server-side. It will only co-sign a SafeTx whose
// target is the module and whose call is a bounded governance action. This is
// what makes the browser 2-of-2 safe: possessing owner A alone can never reach
// threshold, and owner B refuses anything that could drain or brick the Safe.
const GOV_SELECTORS = new Set([
  toFunctionSelector('function activateMandate(uint256)'),
  toFunctionSelector('function executeEscalated(uint256)'),
  toFunctionSelector('function cancelEscalated(uint256)'),
  toFunctionSelector('function retireMandate(uint256)'),
  toFunctionSelector('function unpauseAll()'),
]);

const SAFE_TX_TYPES = {
  SafeTx: [
    { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' }, { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' }, { name: 'nonce', type: 'uint256' },
  ],
};

async function cosignGovernance(to, data, nonce) {
  if (to.toLowerCase() !== MODULE.toLowerCase()) throw new Error('co-sign refused: target is not the module');
  const selector = data.slice(0, 10).toLowerCase();
  if (!GOV_SELECTORS.has(selector)) throw new Error('co-sign refused: not a governance call');
  const onchainNonce = await pub.readContract({ address: SAFE, abi: safeAbi, functionName: 'nonce' });
  if (BigInt(nonce) !== onchainNonce) throw new Error('co-sign refused: stale nonce');
  const domain = { chainId: 11155111, verifyingContract: SAFE };
  const message = { to, value: 0n, data, operation: 0, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: ZERO, refundReceiver: ZERO, nonce: onchainNonce };
  const signature = await signerB.signTypedData({ domain, types: SAFE_TX_TYPES, primaryType: 'SafeTx', message });
  return { signature, signer: signerB.address, nonce: Number(onchainNonce) };
}

// Serialize admin-wallet txs — finalize, provisioning and the demo-mandate
// watchdog all sign with the same account; without a lock they race on nonces.
let adminChain = Promise.resolve();
function withAdminLock(fn) {
  const p = adminChain.then(fn, fn);
  adminChain = p.catch(() => {});
  return p;
}
const adminWrite = (params) => withAdminLock(async () => {
  const hash = await adminWallet.writeContract(params);
  await pub.waitForTransactionReceipt({ hash });
  return hash;
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
 * Background sweep: self-heal any pending request the TEE can already prove,
 * and act as the demo's treasury committee — escalated requests are approved
 * after a short review window with a REAL Safe 2-of-2 execTransaction (both
 * owner keys live only on this server; neither is ever shipped to a browser).
 */
const AUTO_APPROVE_MS = Number(process.env.AUTO_APPROVE_MS ?? 45_000);
const approvingIds = new Set();
async function sweepFinalize() {
  try {
    const nextId = await pub.readContract({ address: MODULE, abi: MODULE_ABI, functionName: 'nextRequestId' });
    for (let i = 1n; i < nextId; i++) {
      const key = String(i);
      if (finalizingIds.has(key) || approvingIds.has(key)) continue;
      const r = await pub.readContract({ address: MODULE, abi: MODULE_ABI, functionName: 'getRequest', args: [i] });
      const state = Number(r[5]);
      if (state === 1) {
        if (!(await decisionResolved(r[7]))) continue;
        try { await finalizeRequest(i); console.log(`[sweep] finalized #${i}`); }
        catch (e) { console.log(`[sweep] #${i} finalize failed: ${e?.shortMessage ?? e?.message}`); }
      } else if (state === 3) {
        // AwaitingSafeApproval — approve after the review window
        if (Date.now() - Number(r[4]) * 1000 < AUTO_APPROVE_MS) continue;
        approvingIds.add(key);
        try {
          const data = encodeFunctionData({ abi: MODULE_ABI, functionName: 'executeEscalated', args: [i] });
          const hash = await safeExec2of2(MODULE, data);
          console.log(`[sweep] escalation #${i} approved by committee 2-of-2 ${hash}`);
        } catch (e) {
          console.log(`[sweep] #${i} approve failed: ${e?.shortMessage ?? e?.message}`);
        } finally { approvingIds.delete(key); }
      }
    }
  } catch (e) { console.log(`[sweep] error: ${e?.shortMessage ?? e?.message}`); }
  refreshDemoMandateIfDrained();
}
if (SWEEP_ENABLED) setInterval(sweepFinalize, SWEEP_MS);

// ---- shared-demo watchdog: keep BOTH demo delegates deterministic ----
// The public demo policy is auto≤40 / budget 300 / reserve 100. The watchdog
// (a) self-provisions a mandate for any demo delegate that lacks one (this is
// how the violation delegate bootstraps), (b) replaces mandates whose budget
// dropped below the floor, and (c) tops up the delegates' Sepolia gas — so
// every judge sees reproducible outcomes with zero manual setup.
const DEMO_RECIPIENT = process.env.DEMO_RECIPIENT ?? '0xc4ba09787f46441a517467fc12af459d8268c60f';
const DEMO_DELEGATES = [
  process.env.DEMO_DELEGATE ?? '0x17ee5ad7e4b40cadafad27c5f68f74d02c7fd532',        // main demo delegate
  process.env.VIOLATION_DELEGATE ?? '0xdfc0c6e0baed0948d8ba22a4917438938f2a40f4',   // blocked-scenario delegate
];
const REFRESH_MIN_BUDGET = usdc(100);
const REFRESH_CHECK_MS = Number(process.env.REFRESH_CHECK_MS ?? 5 * 60_000);
const GAS_FLOOR = 3n * 10n ** 15n;   // 0.003 ETH
const GAS_TOPUP = 10n * 10n ** 15n;  // 0.01 ETH

const adminSend = (to, value) => withAdminLock(async () => {
  const hash = await adminWallet.sendTransaction({ to, value });
  await pub.waitForTransactionReceipt({ hash });
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
          const m = await pub.readContract({ address: MODULE, abi: MODULE_ABI, functionName: 'getMandate', args: [id] });
          const hc = await getHandleClient();
          const budget = BigInt((await hc.decrypt(m[6])).value);
          needsFresh = budget < REFRESH_MIN_BUDGET;
          if (needsFresh) console.log(`[demo] ${delegate} mandate #${id} budget ${budget} below floor — refreshing`);
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
        await adminWrite({
          address: MODULE, abi: MODULE_ABI, functionName: 'proposeMandate',
          args: [delegate, 0n, now + POLICY.days * 86_400n, [DEMO_RECIPIENT, delegate],
            l.handle, l.handleProof, b.handle, b.handleProof, f.handle, f.handleProof],
        });
        const mandateId = (await pub.readContract({ address: MODULE, abi: MODULE_ABI, functionName: 'nextMandateId' })) - 1n;
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
  const proposeTx = await adminWrite({
    address: MODULE, abi: MODULE_ABI, functionName: 'proposeMandate',
    args: [address, 0n, now + POLICY.days * 86_400n, [address],
      l.handle, l.handleProof, b.handle, b.handleProof, f.handle, f.handleProof],
  });
  const mandateId = (await pub.readContract({ address: MODULE, abi: MODULE_ABI, functionName: 'nextMandateId' })) - 1n;

  const activateData = encodeFunctionData({ abi: MODULE_ABI, functionName: 'activateMandate', args: [mandateId] });
  const activateTx = await safeExec2of2(MODULE, activateData);

  return { mandateId: Number(mandateId), proposeTx, activateTx };
}

// ------- http -------
const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': ALLOWED_ORIGIN, 'Vary': 'Origin', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' });
  res.end(JSON.stringify(obj));
};

http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  if (req.url === '/api/health') return json(res, 200, { ok: true, enabled, module: MODULE, safe: SAFE, dayCount, dayCap, sweep: SWEEP_ENABLED, finalizing: finalizingIds.size });
  if (req.method === 'POST' && req.url === '/api/cosign') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4000) req.destroy(); });
    req.on('end', async () => {
      try {
        const { to, data, nonce } = JSON.parse(body || '{}');
        if (!isAddress(to) || typeof data !== 'string' || !data.startsWith('0x')) return json(res, 400, { error: 'bad request' });
        const result = await cosignGovernance(to, data, nonce);
        json(res, 200, { ok: true, ...result });
      } catch (e) {
        json(res, 400, { error: e?.shortMessage ?? e?.message ?? 'co-sign failed' });
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
