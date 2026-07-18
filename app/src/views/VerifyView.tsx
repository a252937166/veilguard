import { ADDR, scan, short } from '../config';
import { EVIDENCE, EvidenceMatrix } from './Evidence';

/**
 * Verify — everything a skeptical judge needs in one place, out of the way of
 * the product flow: the frozen evidence run, live contract addresses, and the
 * exact build provenance.
 */
export function VerifyView() {
  return (
    <>
      <div className="dash-head">
        <div>
          <h2 className="dash-title">Verify on-chain</h2>
          <p className="dash-sub">Don't trust the UI — check every claim on Sepolia yourself.</p>
        </div>
      </div>

      <EvidenceMatrix />

      <div className="card">
        <h3>Deployed contracts <small>all live on Ethereum Sepolia</small></h3>
        <div className="tbl"><table>
          <tbody>
            <tr><td>VeilGuardModule</td><td><a href={scan(ADDR.VeilGuardModule)} target="_blank" rel="noopener" className="mono alink">{ADDR.VeilGuardModule}</a></td></tr>
            <tr><td>Safe (v1.4.1 · 2-of-2 · module enabled)</td><td><a href={scan(ADDR.Safe)} target="_blank" rel="noopener" className="mono alink">{ADDR.Safe}</a></td></tr>
            <tr><td>cUSDC (ERC-7984 wrapper)</td><td><a href={scan(ADDR.ConfidentialUSDC)} target="_blank" rel="noopener" className="mono alink">{ADDR.ConfidentialUSDC}</a></td></tr>
            <tr><td>TestUSDC (faucet ERC-20)</td><td><a href={scan(ADDR.TestUSDC)} target="_blank" rel="noopener" className="mono alink">{ADDR.TestUSDC}</a></td></tr>
            <tr><td>Nox NoxCompute</td><td><a href={scan(ADDR.NoxCompute)} target="_blank" rel="noopener" className="mono alink">{short(ADDR.NoxCompute)}</a></td></tr>
          </tbody>
        </table></div>
      </div>

      <div className="grid2">
        <div className="card">
          <h3>Build provenance</h3>
          <div className="tbl"><table>
            <tbody>
              <tr><td>UI build</td><td><span className="mono">{__UI_BUILD_SHA__}</span></td></tr>
              <tr><td>Evidence run</td><td><span className="mono">{EVIDENCE.commit}</span> · {new Date(EVIDENCE.generatedAt).toISOString().slice(0, 10)}</td></tr>
              <tr><td>Source</td><td><a href="https://github.com/a252937166/veilguard" target="_blank" rel="noopener">github.com/a252937166/veilguard ↗</a></td></tr>
            </tbody>
          </table></div>
          <p className="muted" style={{ marginTop: 8, fontSize: 12.5 }}>
            The evidence matrix is frozen at the evidence-run commit; the UI you are using may be newer.
          </p>
        </div>
        <div className="card">
          <h3>What "verify" means here</h3>
          <p className="muted" style={{ fontSize: 13.5 }}>
            Outcomes are <b>proof-gated</b>: a request only finalizes with the Nox gateway's signed
            decryption proof, checked on-chain — the keeper that submits it can delay a result, never
            change one. Governance is a real <b>2-of-2 Safe</b>: activation and escalation approvals
            each carry two distinct owner signatures you can inspect in the linked transactions.
          </p>
        </div>
      </div>
    </>
  );
}
