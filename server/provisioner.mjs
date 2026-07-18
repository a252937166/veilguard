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
  encodeFunctionData, hashTypedData, isAddress, parseSignature,
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
  const proposeTx = await adminWallet.writeContract({
    address: MODULE, abi: MODULE_ABI, functionName: 'proposeMandate',
    args: [address, 0n, now + POLICY.days * 86_400n, [address],
      l.handle, l.handleProof, b.handle, b.handleProof, f.handle, f.handleProof],
  });
  await pub.waitForTransactionReceipt({ hash: proposeTx });
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
  if (req.url === '/api/health') return json(res, 200, { ok: true, enabled, module: MODULE, safe: SAFE, dayCount, dayCap });
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
