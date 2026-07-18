import { ADDR, scan, short } from '../config';
import { FlowDiagram } from '../FlowDiagram';

export function Landing({ onLaunch, onTry }: { onLaunch: () => void; onTry: () => void }) {
  return (
    <div className="landing">
      <section className="lhero">
        <div className="lbadge"><span className="dot" /> Live on Ethereum Sepolia · powered by iExec Nox</div>
        <h1>Safe controls <em>who</em> can spend.<br />VeilGuard keeps the policy itself <em>confidential</em>.</h1>
        <p className="lsub">
          A Safe Module that enforces <b>encrypted</b> spending policies — per-payment auto-limits,
          delegated budgets and a minimum treasury reserve — evaluated inside a TEE. The chain only
          ever learns <b>execute&nbsp;/&nbsp;escalate&nbsp;/&nbsp;blocked</b>, never the numbers.
        </p>
        <div className="lcta">
          <button className="btn primary big" onClick={onLaunch}>▶ Guided live demo</button>
          <button className="btn big trybtn" onClick={onTry}>⚡ Try a role — no wallet needed</button>
          <a className="btn big ghost" href="#how">How it works</a>
        </div>
        <div className="lstrip">
          <div><span className="lnum">encrypted</span><span className="llabel">budgets · limits · reserve</span></div>
          <div><span className="lnum">≈5s</span><span className="llabel">TEE decision on Sepolia</span></div>
          <div><span className="lnum">3</span><span className="llabel">public outcomes, zero numbers</span></div>
          <div><span className="lnum">4</span><span className="llabel">roles, one confidential loop</span></div>
        </div>
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
          <div className="lcard out"><span className="pill warn">APPROVAL REQUIRED</span><p>Above the auto-limit. Funds stay reserved while a real Safe multisig proposal is collected. Only signers can decrypt the amount.</p></div>
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
        <div className="lgrid four">
          <div className="lcard nox"><h3>🔐 Confidential state</h3><p>Auto-limit, budget and reserve floor live on-chain as encrypted handles — not plaintext in a mapping.</p></div>
          <div className="lcard nox"><h3>🧮 Confidential compute</h3><p>The whole decision — budget, real-balance and reserve checks — runs on ciphertext with select-only logic. No branching, no revert oracles.</p></div>
          <div className="lcard nox"><h3>💸 Confidential execution</h3><p>Payouts move as ERC-7984 confidential transfers; amounts stay encrypted end to end.</p></div>
          <div className="lcard nox"><h3>👁 Selective disclosure</h3><p>Per-handle, irrevocable-by-design viewer grants — signers see escalated amounts, auditors get immutable snapshots, the public gets three states.</p></div>
        </div>
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
          <button className="btn primary big" onClick={onLaunch}>▶ Launch the live demo</button>
        </div>
      </section>
    </div>
  );
}
