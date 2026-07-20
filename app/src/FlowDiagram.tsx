/**
 * Semantic architecture flow. It remains readable without CSS, by screen readers,
 * and at narrow widths where the previous fixed-width SVG required horizontal scrolling.
 */
export function FlowDiagram() {
  return (
    <figure className="flow-architecture flowsvg" aria-labelledby="flow-architecture-title">
      <figcaption className="flow-architecture__caption">
        <span className="flow-architecture__label">End-to-end architecture</span>
        <h3 id="flow-architecture-title">One confidential request, three verifiable outcomes</h3>
        <p>The policy and amount stay encrypted while governance, escrow and final outcomes remain independently inspectable on Sepolia.</p>
      </figcaption>

      <ol className="flow-architecture__steps">
        <li className="flow-architecture__step flow-architecture__step--governance">
          <header className="flow-architecture__step-head">
            <span className="flow-architecture__step-index" aria-hidden="true">1</span>
            <div><h4>Govern the mandate</h4><p>A finance admin proposes; the Safe decides.</p></div>
          </header>
          <div className="flow-architecture__actors">
            <article className="flow-architecture__actor">
              <span className="flow-architecture__actor-role">Finance Admin</span>
              <b>Propose encrypted controls</b>
              <code>proposeMandate</code>
            </article>
            <span className="flow-architecture__call" aria-label="then">Encrypted limits →</span>
            <article className="flow-architecture__actor flow-architecture__actor--module">
              <span className="flow-architecture__actor-role">VeilGuardModule</span>
              <b>Bind policy to the Safe</b>
              <span>Safe module · escrow holder</span>
            </article>
            <span className="flow-architecture__call" aria-label="authorized by">← 2-of-2 activation</span>
            <article className="flow-architecture__actor">
              <span className="flow-architecture__actor-role">Safe multisig</span>
              <b>Activate and govern</b>
              <span>Two distinct owner signatures</span>
            </article>
          </div>
        </li>

        <li className="flow-architecture__step">
          <header className="flow-architecture__step-head">
            <span className="flow-architecture__step-index" aria-hidden="true">2</span>
            <div><h4>Submit a payment request</h4><p>The delegate chooses an allowed recipient and encrypts the amount.</p></div>
          </header>
          <div className="flow-architecture__request">
            <div><span>Delegate knows</span><b>Recipient · purpose · own request</b></div>
            <div><span>Submitted on-chain</span><b>Encrypted amount handle</b></div>
            <div><span>Delegate never sees</span><b>Policy limits · budget · reserve floor</b></div>
          </div>
        </li>

        <li className="flow-architecture__step flow-architecture__step--tee">
          <header className="flow-architecture__step-head">
            <span className="flow-architecture__step-index" aria-hidden="true">3</span>
            <div><h4>Evaluate inside the Nox TEE</h4><p>Computation runs on ciphertext; no policy value is decrypted on-chain.</p></div>
          </header>
          <div className="flow-architecture__tee">
            <ol className="flow-architecture__checks" aria-label="Confidential policy checks">
              <li><span>Budget check</span><code>safeSub(budget, amount)</code></li>
              <li><span>Balance and reserve</span><code>compare encrypted balance</code></li>
              <li><span>Auto-limit check</span><code>le(amount, autoLimit)</code></li>
              <li><span>Decision encoding</span><code>select → 1 · 2 · 3</code></li>
            </ol>
            <p className="flow-architecture__privacy-note">The Safe lends its encrypted balance handle only for this computation. The TEE returns a proof-backed decision, not plaintext policy data.</p>
          </div>
        </li>

        <li className="flow-architecture__step">
          <header className="flow-architecture__step-head">
            <span className="flow-architecture__step-index" aria-hidden="true">4</span>
            <div><h4>Reserve first, finalize by proof</h4><p>Escrow and encrypted policy accounting update atomically with the request.</p></div>
          </header>
          <div className="flow-architecture__settlement">
            <div><b>Atomic escrow</b><span>Blocked outcomes reserve encrypted zero; public transfers do not reveal the private decision.</span></div>
            <div><b>Untrusted keeper</b><span>Anyone may submit <code>finalize(proof)</code>. The keeper can delay a result, never choose one.</span></div>
          </div>
        </li>

        <li className="flow-architecture__step flow-architecture__step--outcomes">
          <header className="flow-architecture__step-head">
            <span className="flow-architecture__step-index" aria-hidden="true">5</span>
            <div><h4>Publish one public outcome</h4><p>The state is visible; confidential inputs and reasons remain hidden.</p></div>
          </header>
          <ul className="flow-architecture__outcomes">
            <li className="flow-architecture__outcome flow-architecture__outcome--ok">
              <span>Within mandate</span><b>Direct execution</b><p>Confidential funds reach the recipient without committee action.</p>
            </li>
            <li className="flow-architecture__outcome flow-architecture__outcome--warn">
              <span>Approval required</span><b>Safe decision</b><p>Funds stay in escrow until the 2-of-2 Safe approves or returns them.</p>
            </li>
            <li className="flow-architecture__outcome flow-architecture__outcome--bad">
              <span>Blocked</span><b>No funds move</b><p>The reason remains encrypted and is visible only to an authorised viewer.</p>
            </li>
          </ul>
        </li>

        <li className="flow-architecture__step flow-architecture__step--audit">
          <header className="flow-architecture__step-head">
            <span className="flow-architecture__step-index" aria-hidden="true">6</span>
            <div><h4>Disclose an immutable audit scope</h4><p>The finance admin selects terminal requests and grants fresh snapshot handles to one auditor.</p></div>
          </header>
          <div className="flow-architecture__proof">
            <div><span>Auditor receives</span><b>Fixed policy snapshots · selected request values · manifest hash</b></div>
            <div><span>Auditor never receives</span><b>Live policy state · future versions · unrelated requests</b></div>
          </div>
        </li>
      </ol>
    </figure>
  );
}
