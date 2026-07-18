import ev from '../demo-evidence.json';
import { scanTx } from '../config';

const Tx = ({ hash, label }: { hash?: string; label: string }) =>
  hash && hash.startsWith('0x') ? (
    <a href={scanTx(hash)} target="_blank" rel="noopener" className="mono alink">{label} ↗</a>
  ) : (
    <span className="muted">—</span>
  );

/**
 * On-chain evidence matrix — the exact transactions behind each outcome, frozen
 * from one clean Sepolia run. Judges can verify every claim without trusting the
 * UI: every hash links to Etherscan.
 */
export function EvidenceMatrix() {
  const r = ev.requests as any;
  return (
    <div className="card">
      <h3>
        On-chain evidence <small>one clean run · mandate #{ev.mandate.id} · real 2-of-{ev.threshold} Safe governance</small>
      </h3>
      <div className="tbl"><table>
        <thead>
          <tr><th>Flow</th><th>Request tx</th><th>Finalize (proof-gated)</th><th>Safe 2-of-2</th><th>TEE</th><th>Outcome</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Mandate activation</td>
            <td><Tx hash={ev.mandate.proposeTx} label="propose" /></td>
            <td className="muted">—</td>
            <td><Tx hash={ev.mandate.activation.executeTxHash} label="activate 2/2" /></td>
            <td className="muted">—</td>
            <td><span className="pill dim">ACTIVE</span></td>
          </tr>
          <tr>
            <td>Direct spend (#{r.within.id})</td>
            <td><Tx hash={r.within.requestTx} label="request" /></td>
            <td><Tx hash={r.within.finalizeTx} label="finalize" /></td>
            <td className="muted">not needed</td>
            <td className="mono">{ev.teeLatencySec.within}s</td>
            <td><span className="pill ok">EXECUTED</span></td>
          </tr>
          <tr>
            <td>Escalated (#{r.escalated.id})</td>
            <td><Tx hash={r.escalated.requestTx} label="request" /></td>
            <td><Tx hash={r.escalated.finalizeTx} label="finalize" /></td>
            <td><Tx hash={r.escalated.approval.executeTxHash} label="approve 2/2" /></td>
            <td className="mono">{ev.teeLatencySec.escalated}s</td>
            <td><span className="pill warn">APPROVED</span></td>
          </tr>
          <tr>
            <td>Blocked (#{r.blocked.id})</td>
            <td><Tx hash={r.blocked.requestTx} label="request" /></td>
            <td><Tx hash={r.blocked.finalizeTx} label="finalize" /></td>
            <td className="muted">no funds move</td>
            <td className="mono">{ev.teeLatencySec.blocked}s</td>
            <td><span className="pill bad">BLOCKED</span></td>
          </tr>
          <tr>
            <td>Selective disclosure</td>
            <td className="muted">covers #{(ev.packet as any).requestIds.join(', #')}</td>
            <td className="muted">—</td>
            <td className="muted">—</td>
            <td className="muted">—</td>
            <td><Tx hash={(ev.packet as any).createTx} label="packet tx" /></td>
          </tr>
        </tbody>
      </table></div>
      <p className="muted" style={{ marginTop: 10, fontSize: 12.5 }}>
        Frozen at commit <span className="mono">{ev.commit}</span> · {new Date(ev.generatedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC.
        TEE latency is single-run, not a percentile. Activation and escalation each required <b>two</b> distinct
        owner signatures (threshold {ev.threshold}) — a single owner cannot act alone.
      </p>
    </div>
  );
}

export const EVIDENCE = ev;
