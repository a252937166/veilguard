import { useEffect, useMemo, useState } from 'react';
import { DEMO_SCENARIOS } from '../demo-scenarios';
import { loadDemoSession } from '../demo-session';
import { completeMission } from '../missions';
import { formatAppRoute } from '../routes';
import { useApp } from '../App';

type BuilderStep = 'select' | 'review' | 'create';
type PacketResult = {
  bundleId: `0x${string}`;
  bundleKind: 'ui-aggregate';
  onchainObject: false;
  packets: Array<{
    packetId: number;
    mandateId: number;
    requestIds: number[];
    manifestHash: `0x${string}`;
    tx?: `0x${string}`;
    reused: boolean;
  }>;
  fixedPolicyFields: string[];
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function DisclosureView() {
  const { requests, startDemo, toast } = useApp();
  const [step, setStep] = useState<BuilderStep>('select');
  const [session, setSession] = useState(loadDemoSession);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<PacketResult | null>(null);

  useEffect(() => {
    const update = () => setSession(loadDemoSession());
    window.addEventListener('vg-demo-session', update);
    window.addEventListener('vg-missions', update);
    return () => {
      window.removeEventListener('vg-demo-session', update);
      window.removeEventListener('vg-missions', update);
    };
  }, []);

  const missionIds = useMemo(() => session ? [
    session.missions.routine.requestId,
    session.missions.approval.requestId,
    session.missions.violation.requestId,
  ].filter((id): id is string => !!id) : [], [session]);

  const scope = useMemo(() => missionIds.map((id, index) => ({
    id,
    scenario: DEMO_SCENARIOS[index],
    request: requests.find((request) => String(request.id) === id),
  })), [missionIds, requests]);

  const allTerminal = scope.length === 3 && scope.every(({ request }) => request && [2, 4, 5, 6].includes(request.state));
  const allSelected = scope.length === 3 && scope.every(({ id }) => selected.has(id));

  useEffect(() => {
    if (scope.length === 3 && !selected.size) setSelected(new Set(scope.map(({ id }) => id)));
  }, [scope, selected.size]);

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const create = async () => {
    if (!session || !allSelected || !allTerminal) return;
    setBusy(true);
    setError('');
    try {
      const body = { runId: session.runId, requestIds: scope.map(({ id }) => id) };
      let output: PacketResult | null = null;
      for (let attempt = 0; attempt < 45; attempt++) {
        const response = await fetch('/api/demo-audit-packet', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await response.json().catch(() => ({}));
        if (response.status === 202) { await sleep(2_000); continue; }
        if (!response.ok) throw new Error(data.error ?? `packet service returned ${response.status}`);
        output = data as PacketResult;
        break;
      }
      if (!output) throw new Error('packet creation is still processing; retry to resume it');
      setResult(output);
      setStep('create');
      completeMission('audit', {
        packetIds: output.packets.map((packet) => packet.packetId),
        includedRequestIds: scope.map(({ id }) => id),
        runId: session.runId,
      });
      toast(`${output.packets.length} on-chain audit packet${output.packets.length === 1 ? '' : 's'} created for the Launch Day Review bundle.`);
    } catch (reason: any) {
      setError(reason?.message ?? String(reason));
    } finally {
      setBusy(false);
    }
  };

  const openAudit = () => {
    startDemo('auditor');
    const first = result?.packets[0]?.packetId;
    window.location.hash = formatAppRoute(first ? { page: 'audit-detail', packetId: String(first) } : { page: 'audit-packets' });
  };

  return (
    <>
      <div className="dash-head" data-tour="disclosure-builder">
        <div>
          <p className="workspace-kicker">Selective disclosure</p>
          <h1 className="dash-title">Launch Day Review</h1>
          <p className="dash-sub">Create the smallest real on-chain disclosure scope that covers this run, then hand it to the fixed Demo Auditor.</p>
        </div>
        <span className="pill tee">V1 FIXED SCHEMA</span>
      </div>

      <ol className="builder-steps" aria-label="Disclosure builder progress">
        <li className={step === 'select' ? 'active' : 'complete'}><span>1</span><div><b>Select</b><small>Run-bound requests</small></div></li>
        <li className={step === 'review' ? 'active' : step === 'create' ? 'complete' : ''}><span>2</span><div><b>Review</b><small>Irreversible scope</small></div></li>
        <li className={step === 'create' ? 'active' : ''}><span>3</span><div><b>Create</b><small>On-chain packets</small></div></li>
      </ol>

      {step === 'select' && (
        <section className="card disclosure-builder" aria-labelledby="select-scope-title">
          <div className="section-heading">
            <div><h3 id="select-scope-title">Select terminal requests</h3><p>Requests are bound to run <span className="mono">{session?.runId ?? 'not started'}</span> and automatically grouped by mandate server-side.</p></div>
            <span className={`pill ${allTerminal ? 'ok' : 'warn'}`}>{scope.filter(({ request }) => request && [2, 4, 5, 6].includes(request.state)).length}/3 TERMINAL</span>
          </div>
          <div className="disclosure-request-list">
            {scope.map(({ id, scenario, request }) => (
              <label key={id} className={`disclosure-request ${selected.has(id) ? 'selected' : ''}`}>
                <input type="checkbox" checked={selected.has(id)} onChange={() => toggle(id)} />
                <span><b>{scenario?.vendor ?? 'Launch Day request'}</b><small>{scenario?.amount} cUSDC · Request #{id}</small></span>
                <span className={`pill ${request?.state === 2 ? 'ok' : request?.state === 4 || request?.state === 5 ? 'bad' : 'warn'}`}>{request ? ['NONE', 'TEE', 'EXECUTED', 'AWAITING SAFE', 'BLOCKED', 'REFUNDED', 'EXPIRED'][request.state] : 'LOADING'}</span>
              </label>
            ))}
            {!scope.length && <div className="empty-state"><h3>Complete the three payment missions first</h3><p className="muted">The builder never substitutes sample IDs for missing on-chain requests.</p></div>}
          </div>
          <div className="sticky-actions">
            <span className="muted">All three Launch Day requests are required for the review story.</span>
            <button type="button" className="btn primary" disabled={!allTerminal || !allSelected} onClick={() => setStep('review')}>Review disclosure scope</button>
          </div>
        </section>
      )}

      {step === 'review' && (
        <section className="card disclosure-review" aria-labelledby="review-scope-title">
          <div className="section-heading">
            <div><h3 id="review-scope-title">Review the irreversible snapshot scope</h3><p>Creating a packet writes immutable handles and grants the fixed Demo Auditor access to those snapshots.</p></div>
            <span className="pill warn">ON-CHAIN ACTION</span>
          </div>
          <div className="fixed-scope">
            <div><span className="pill tee">FIXED</span><b>Policy snapshot fields</b><p>Auto-limit · Budget left · Reserve floor</p></div>
            <div><span className="pill tee">PER REQUEST</span><b>Request snapshot fields</b><p>Amount · Blocked reason</p></div>
          </div>
          <div className="inline-alert warning"><b>VeilGuardModule v1 limitation.</b> The three policy values are always included by the contract ABI. They are not optional controls and the UI cannot mask them without redeploying the contract.</div>
          <dl className="review-scope-facts">
            <div><dt>Selected requests</dt><dd>{scope.map(({ id }) => `#${id}`).join(', ')}</dd></div>
            <div><dt>Mandate groups</dt><dd>{new Set(scope.map(({ request }) => String(request?.mandateId))).size}</dd></div>
            <div><dt>Auditor</dt><dd>Fixed Demo Auditor</dd></div>
            <div><dt>Bundle type</dt><dd>UI aggregate over real packet IDs</dd></div>
          </dl>
          {error && <div className="inline-alert error" role="alert">{error}</div>}
          <div className="sticky-actions">
            <button type="button" className="btn ghost" disabled={busy} onClick={() => setStep('select')}>Back to selection</button>
            <button type="button" className="btn primary" disabled={busy} onClick={create}>{busy ? <><span className="spin" /> Creating or resuming packets…</> : 'Create disclosure packets'}</button>
          </div>
        </section>
      )}

      {step === 'create' && result && (
        <section className="card disclosure-created" aria-labelledby="created-title">
          <div className="section-heading">
            <div><p className="workspace-kicker">Created successfully</p><h3 id="created-title">Review Bundle ready</h3><p>Bundle <span className="mono">{result.bundleId.slice(0, 12)}…</span> is a UI grouping, not a new on-chain object.</p></div>
            <span className="pill ok">{result.packets.length} PACKET{result.packets.length === 1 ? '' : 'S'}</span>
          </div>
          <div className="packet-result-list">
            {result.packets.map((packet) => (
              <div key={packet.packetId}>
                <span><b>Packet #{packet.packetId}</b><small>Mandate #{packet.mandateId} · Requests {packet.requestIds.map((id) => `#${id}`).join(', ')}</small></span>
                <span className={`pill ${packet.reused ? 'dim' : 'ok'}`}>{packet.reused ? 'REUSED' : 'CREATED'}</span>
              </div>
            ))}
          </div>
          <div className="inline-alert neutral">The Auditor must still unlock every snapshot, review or flag every request, and pass the manifest and terminal-state checks.</div>
          <div className="sticky-actions"><button type="button" className="btn primary" onClick={openAudit}>Continue as Auditor</button></div>
        </section>
      )}
    </>
  );
}
