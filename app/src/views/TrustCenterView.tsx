import evidence from '../demo-evidence.json';
import { ADDR, scan, short } from '../config';

type TrustCenterMode = 'contracts' | 'provenance';

const contracts = [
  { name: 'VeilGuardModule', address: ADDR.VeilGuardModule, purpose: 'Policy enforcement, request lifecycle and audit snapshots' },
  { name: 'Safe', address: ADDR.Safe, purpose: 'Threshold treasury and exception governance' },
  { name: 'ConfidentialUSDC', address: ADDR.ConfidentialUSDC, purpose: 'Confidential treasury asset wrapper' },
  { name: 'TestUSDC', address: ADDR.TestUSDC, purpose: 'Sepolia test asset used at the public entry point' },
] as const;

export function TrustCenterView({ mode }: { mode: TrustCenterMode }) {
  if (mode === 'contracts') {
    return (
      <>
        <div className="dash-head">
          <div><p className="workspace-kicker">Trust center</p><h2 className="dash-title">Contracts</h2><p className="dash-sub">Canonical Sepolia addresses used by this UI. Every link leaves the product and opens the public explorer.</p></div>
          <span className="pill ok">CHAIN ID 11155111</span>
        </div>
        <div className="contract-registry">
          {contracts.map((contract) => (
            <a key={contract.name} className="contract-object" href={scan(contract.address)} target="_blank" rel="noopener noreferrer">
              <span><b>{contract.name}</b><small>{contract.purpose}</small></span>
              <code>{contract.address}</code>
              <span className="proof-link-label">Open Etherscan <span aria-hidden="true">↗</span></span>
            </a>
          ))}
        </div>
        <div className="inline-alert neutral">VeilGuardModule ABI is unchanged by this operations-desk release. The v1 audit schema remains fixed to three policy snapshots plus amount and reason per request.</div>
      </>
    );
  }

  return (
    <>
      <div className="dash-head">
        <div><p className="workspace-kicker">Trust center</p><h2 className="dash-title">Build provenance</h2><p className="dash-sub">Separate the currently loaded interface from the frozen evidence run used for judge verification.</p></div>
        <span className="pill tee">REPRODUCIBLE CLAIMS</span>
      </div>
      <div className="provenance-grid">
        <section className="card provenance-card">
          <p className="workbench-kicker">Current interface</p>
          <h3>UI build</h3>
          <dl>
            <div><dt>Build commit</dt><dd className="mono">{__UI_BUILD_SHA__}</dd></div>
            <div><dt>Network</dt><dd>Ethereum Sepolia</dd></div>
            <div><dt>Module</dt><dd className="mono">{short(ADDR.VeilGuardModule)}</dd></div>
          </dl>
          <p>The live workspace reads current objects from the module and indexes transactions when event access is available.</p>
        </section>
        <section className="card provenance-card">
          <p className="workbench-kicker">Frozen verification source</p>
          <h3>Evidence run</h3>
          <dl>
            <div><dt>Evidence commit</dt><dd className="mono">{evidence.commit}</dd></div>
            <div><dt>Captured</dt><dd>{new Date(evidence.generatedAt).toLocaleString()}</dd></div>
            <div><dt>Safe threshold</dt><dd>{evidence.threshold}-of-{evidence.threshold}</dd></div>
          </dl>
          <p>Frozen records do not update with the current session and are labeled as such in the Flow Explorer.</p>
        </section>
      </div>
      <section className="card provenance-boundary">
        <h3>Evidence boundary</h3>
        <ul>
          <li>Public chain state proves transitions, recipients, ciphertext handles and transaction consequences.</li>
          <li>Authorized decryption proves only the values granted to that actor; the public view never mirrors them.</li>
          <li>A Review Bundle is a UI grouping over packet IDs, never represented as a single contract object.</li>
          <li>Single-run TEE latency is labeled as a measurement, not a percentile or service-level promise.</li>
        </ul>
      </section>
    </>
  );
}
