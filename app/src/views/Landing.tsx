import { ADDR, scan, short } from '../config';
import { FlowDiagram } from '../FlowDiagram';

const FEATURES = [
  {
    title: 'Confidential State',
    body: 'Auto-limit, budget and reserve floor live on-chain as encrypted handles — not plaintext in a mapping.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3l7 3v5c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6l7-3z" />
        <rect x="9" y="11" width="6" height="5" rx="1" /><path d="M10.5 11V9.5a1.5 1.5 0 013 0V11" />
      </svg>
    ),
  },
  {
    title: 'Confidential Compute',
    body: 'The whole decision — budget, balance and reserve checks — runs on ciphertext inside a TEE. Select-only logic, no revert oracles.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <rect x="7" y="7" width="10" height="10" rx="2" /><path d="M10 10h4v4h-4z" />
        <path d="M9 3v2M15 3v2M9 19v2M15 19v2M3 9h2M3 15h2M19 9h2M19 15h2" />
      </svg>
    ),
  },
  {
    title: 'Confidential Execution',
    body: 'Payouts move as ERC-7984 confidential transfers, atomically reserved in the same tx. Amounts stay encrypted end to end.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 8h13M13 4l4 4-4 4" /><path d="M20 16H7M11 20l-4-4 4-4" />
      </svg>
    ),
  },
  {
    title: 'Selective Disclosure',
    body: 'Per-handle viewer grants — signers see escalated amounts, auditors get immutable snapshots, the public gets three states.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" /><circle cx="12" cy="12" r="2.6" />
      </svg>
    ),
  },
];

export function Landing({ onLaunch, onVerify, onConnect }: { onLaunch: () => void; onVerify: () => void; onConnect: () => void }) {
  return (
    <div className="landing">
      <section className="lhero">
        <div className="lhero-glow" />
        <div className="lhero-inner">
          <div className="lbadge"><span className="dot" /> Live on Ethereum Sepolia · powered by iExec Nox</div>
          <h1 className="lhero-title">
            Confidential Payments.<br />
            <span className="grad">Transparent Governance.</span>
          </h1>
          <p className="lhero-sub">
            A Safe Module that enforces <b>encrypted</b> spending policies — per-payment auto-limits,
            delegated budgets and a minimum treasury reserve — evaluated inside a TEE. The chain only
            ever learns <b>execute&nbsp;/&nbsp;escalate&nbsp;/&nbsp;blocked</b>, never the numbers.
          </p>
          <div className="lcta">
            <button className="btn primary big" onClick={onLaunch}>▶ Start interactive demo</button>
            <button className="btn big ghost" onClick={onVerify}>🧾 Verify on-chain</button>
          </div>
          <button className="lconnect" onClick={onConnect}>or connect my own wallet →</button>
          <div className="lstats">
            <div><span className="lstat-num">4</span><span className="lstat-lbl">Governed roles</span></div>
            <div><span className="lstat-num">100%</span><span className="lstat-lbl">On-chain proofs</span></div>
            <div><span className="lstat-num">3</span><span className="lstat-lbl">Public outcomes</span></div>
            <div><span className="lstat-num grad-num">0</span><span className="lstat-lbl">Numbers leaked</span></div>
          </div>
        </div>
      </section>

      <section className="lfeatures">
        {FEATURES.map((f) => (
          <div className="feat" key={f.title}>
            <span className="feat-ico">{f.icon}</span>
            <h3>{f.title}</h3>
            <p>{f.body}</p>
          </div>
        ))}
      </section>

      <section className="lsec">
        <h2>Why treasuries need this</h2>
        <p className="llead">
          Companies and DAOs want to delegate day-to-day spending without publishing their internal
          finances. On a transparent chain, every allowance module leaks the numbers that matter:
          how big each team's budget is, how much is left, at what amount extra approval kicks in,
          and how close the treasury is to its cash floor. Competitors and counterparties read along.
        </p>
        <div className="lgrid">
          <div className="lcard"><h3>Finance leads</h3><p>Delegate routine payouts without publishing budgets, limits or the reserve line — and without signing every small payment.</p></div>
          <div className="lcard"><h3>Operators</h3><p>Submit a payment, get an answer — executable, needs approval, or blocked. You never see the full policy, so it can't be probed out of you.</p></div>
          <div className="lcard"><h3>Auditors</h3><p>Receive a scoped, immutable snapshot of exactly the policy version and requests you're mandated to review. Nothing more, ever.</p></div>
        </div>
      </section>

      <section className="lsec">
        <h2>Three outcomes. Zero numbers revealed.</h2>
        <p className="llead">A delegate submits an encrypted amount. The decision is computed on ciphertext and funds are atomically reserved in the same transaction — a blocked request reserves an encrypted zero, indistinguishable on-chain.</p>
        <div className="lgrid">
          <div className="lcard out"><span className="pill ok">WITHIN MANDATE</span><p>Satisfies every encrypted rule. A confidential ERC-7984 transfer executes immediately; the private budget shrinks. Nobody learns the amount.</p></div>
          <div className="lcard out"><span className="pill warn">APPROVAL REQUIRED</span><p>Above the auto-limit. Funds stay reserved until a real 2-of-2 Safe multisig approves. Only signers can decrypt the amount.</p></div>
          <div className="lcard out"><span className="pill bad">BLOCKED</span><p>Budget, balance or reserve rule violated. No funds move, the budget is untouched, and the coarse reason stays private to the delegate and admin.</p></div>
        </div>
      </section>

      <section className="lsec" id="nox">
        <h2>What makes it possible — iExec Nox</h2>
        <p className="llead">
          Nox is a confidential computing layer: on-chain smart contracts hand encrypted values
          (<span className="mono">euint256</span> handles) to off-chain Trusted Execution Environments, which
          compute on the plaintext <b>inside sealed hardware</b> and never expose it on-chain. VeilGuard
          puts that at the center — not as a last-mile wrapper on one transfer, but across the whole policy.
        </p>
        <p className="lnote">Remove Nox and every number becomes public again — the product collapses into an ordinary allowance module. That's the point: the sponsor tech is the core, not a coat of paint.</p>
      </section>

      <section className="lsec" id="how">
        <h2>How it works</h2>
        <p className="llead">One confidential loop, four roles. The policy is proposed encrypted, evaluated on ciphertext inside the TEE against the Safe's real balance, and enforced through proof-gated on-chain execution.</p>
        <FlowDiagram />
      </section>

      <section className="lsec">
        <h2>Live on Ethereum Sepolia</h2>
        <p className="llead">The full confidential loop is deployed and exercised on-chain — an encrypted mandate is active and real spend requests have executed, escalated and been blocked. No mock data.</p>
        <div className="tbl"><table>
          <tbody>
            <tr><td>VeilGuardModule</td><td><a href={scan(ADDR.VeilGuardModule)} target="_blank" rel="noopener" className="mono">{ADDR.VeilGuardModule}</a></td></tr>
            <tr><td>Safe (v1.4.1, module enabled)</td><td><a href={scan(ADDR.Safe)} target="_blank" rel="noopener" className="mono">{ADDR.Safe}</a></td></tr>
            <tr><td>cUSDC (ERC-7984 wrapper)</td><td><a href={scan(ADDR.ConfidentialUSDC)} target="_blank" rel="noopener" className="mono">{ADDR.ConfidentialUSDC}</a></td></tr>
            <tr><td>Nox NoxCompute</td><td><a href={scan(ADDR.NoxCompute)} target="_blank" rel="noopener" className="mono">{short(ADDR.NoxCompute)}</a></td></tr>
          </tbody>
        </table></div>
        <div className="lcta center">
          <button className="btn primary big" onClick={onLaunch}>▶ Start interactive demo</button>
        </div>
      </section>
    </div>
  );
}
