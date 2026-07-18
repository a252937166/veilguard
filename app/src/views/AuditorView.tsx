import { Fragment, useEffect, useMemo, useState } from 'react';
import { ADDR, moduleAbi, scan, scanTx, short } from '../config';
import { handleClientFor, publicClient, waitResolved } from '../nox';
import { fetchRequestTxs, type RequestTxs } from '../txlog';
import { useApp } from '../App';
import { completeMission } from '../missions';
import { Decrypt, NoRole, RequestPill } from '../ui';

type Packet = {
  id: bigint; auditor: `0x${string}`; mandateId: bigint; policyVersion: number;
  manifestHash: `0x${string}`; createdAt: bigint; requestIds: bigint[]; snapshotHandles: `0x${string}`[];
};

export function AuditorView() {
  const { account, toast, requests } = useApp();
  const [txs, setTxs] = useState<Map<string, RequestTxs>>(new Map());
  useEffect(() => { fetchRequestTxs().then(setTxs).catch(() => { /* links stay hidden */ }); }, []);
  const TxLink = ({ h }: { h?: `0x${string}` }) =>
    h ? <a className="mono alink" href={scanTx(h)} target="_blank" rel="noopener">{h.slice(0, 8)}… ↗</a> : <span className="muted">—</span>;
  const [packets, setPackets] = useState<Packet[]>([]);
  const [selected, setSelected] = useState<bigint | null>(null);
  const [tab, setTab] = useState<'Overview' | 'Requests' | 'Proofs'>('Overview');
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const next = (await publicClient.readContract({ address: ADDR.VeilGuardModule, abi: moduleAbi, functionName: 'nextPacketId' })) as bigint;
        const out: Packet[] = [];
        for (let i = 1n; i < next; i++) {
          const p = (await publicClient.readContract({ address: ADDR.VeilGuardModule, abi: moduleAbi, functionName: 'getAuditPacket', args: [i] })) as any[];
          out.push({ id: i, auditor: p[0], mandateId: p[1], policyVersion: Number(p[2]), manifestHash: p[3], createdAt: p[4], requestIds: p[5] as bigint[], snapshotHandles: p[6] as `0x${string}`[] });
        }
        setPackets(out);
      } catch (e) { console.error(e); }
    })();
  }, [account]);

  const mine = useMemo(() => packets.filter((p) => account && p.auditor.toLowerCase() === account.toLowerCase()), [packets, account]);
  const pkt = useMemo(() => mine.find((p) => p.id === selected) ?? mine[mine.length - 1], [mine, selected]);

  if (!account)
    return <NoRole demo="auditor" title="Act as an Auditor"
      body="An auditor decrypts the scoped, immutable disclosure snapshots the finance admin granted — and nothing else. Try the demo auditor account to decrypt a real packet's policy values, request amounts and coarse reasons." />;

  const download = async () => {
    if (!pkt) return;
    setDownloading(true);
    try {
      const client = await handleClientFor(account);
      await waitResolved(pkt.snapshotHandles);
      const dec = async (h: string) => Number((await client.decrypt(h as any)).value);
      const [autoLimit, budgetLeft, reserveFloor] = [await dec(pkt.snapshotHandles[0]), await dec(pkt.snapshotHandles[1]), await dec(pkt.snapshotHandles[2])];
      const reqs = [];
      for (let k = 0; k < pkt.requestIds.length; k++) {
        reqs.push({ requestId: Number(pkt.requestIds[k]), amount: (await dec(pkt.snapshotHandles[3 + k * 2])) / 1e6, blockedReason: await dec(pkt.snapshotHandles[4 + k * 2]) });
      }
      const doc = {
        packetId: Number(pkt.id), mandateId: Number(pkt.mandateId), policyVersion: pkt.policyVersion,
        auditor: pkt.auditor, manifestHash: pkt.manifestHash, createdAt: new Date(Number(pkt.createdAt) * 1000).toISOString(),
        policy: { autoLimit: autoLimit / 1e6, budgetLeftAtPacketTime: budgetLeft / 1e6, reserveFloor: reserveFloor / 1e6 },
        requests: reqs,
        note: 'Selective disclosure snapshot decrypted by the authorised auditor. Not a standalone compliance proof — cross-check the public request state and tx hashes.',
      };
      const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = `veilguard-audit-packet-${pkt.id}.json`; a.click();
      URL.revokeObjectURL(url);
      toast(`✓ Decrypted packet #${pkt.id} exported as JSON.`);
    } catch (e: any) {
      toast(`Export failed: ${e?.message ?? e}`, true);
    } finally { setDownloading(false); }
  };

  const [vals, setVals] = useState<Record<string, string>>({});
  const [bulk, setBulk] = useState(false);
  const decryptAll = async () => {
    if (!pkt) return;
    setBulk(true);
    try {
      const client = await handleClientFor(account);
      await waitResolved(pkt.snapshotHandles);
      const out: Record<string, string> = {};
      const dec = async (h: string) => Number((await client.decrypt(h as any)).value);
      out[pkt.snapshotHandles[0]] = `${(await dec(pkt.snapshotHandles[0])) / 1e6} cUSDC`;
      out[pkt.snapshotHandles[1]] = `${(await dec(pkt.snapshotHandles[1])) / 1e6} cUSDC`;
      out[pkt.snapshotHandles[2]] = `${(await dec(pkt.snapshotHandles[2])) / 1e6} cUSDC`;
      for (let k = 0; k < pkt.requestIds.length; k++) {
        out[pkt.snapshotHandles[3 + k * 2]] = `${(await dec(pkt.snapshotHandles[3 + k * 2])) / 1e6} cUSDC`;
        const r = await dec(pkt.snapshotHandles[4 + k * 2]);
        out[pkt.snapshotHandles[4 + k * 2]] = r === 0 ? '0 (ok)' : `${r} (${['', 'budget', 'balance', 'reserve'][r] ?? 'reason'})`;
      }
      setVals(out);
      completeMission('audit');
      toast(`✓ Packet #${pkt.id} fully decrypted — one grant, every value. Mission complete!`);
    } catch (e: any) {
      toast(`Decrypt failed: ${e?.message ?? e}`, true);
    } finally { setBulk(false); }
  };
  const V = ({ h, unit, label }: { h: `0x${string}`; unit?: string; label?: string }) =>
    vals[h] ? <span className="value">{vals[h]}</span> : <Decrypt handle={h} unit={unit} label={label} />;

  return (
    <>
      <div className="notice">
        A packet is a <b>selective-disclosure snapshot</b>: fresh ciphertext handles covering one policy version
        and chosen terminal requests. You decrypt exactly those — forever — but never gain live state, future
        versions, or the ability to compute on the handles. Scoped disclosure, <b>not</b> a standalone compliance proof.
      </div>

      {!mine.length && <div className="card"><p className="muted">No packets disclosed to {short(account)} yet — the finance admin creates one in the Admin tab.</p></div>}

      {mine.length > 0 && pkt && (
        <div className="grid2" style={{ gridTemplateColumns: '260px 1fr' }}>
          <div className="card">
            <h3>Your packets <small>{mine.length}</small></h3>
            <div className="pkt-list">
              {mine.map((p) => (
                <button key={String(p.id)} className={`pkt-item ${p.id === pkt.id ? 'active' : ''}`} onClick={() => { setSelected(p.id); setTab('Overview'); }}>
                  <b>Packet #{String(p.id)}</b>
                  <span className="muted">mandate #{String(p.mandateId)} · {p.requestIds.length} req · v{p.policyVersion}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="card" data-tour="packets">
            <div className="pkt-head">
              <h3 style={{ margin: 0 }}>Audit packet #{String(pkt.id)}</h3>
              <div className="row">
                <button className="btn small primary" disabled={bulk} onClick={decryptAll}>{bulk ? <><span className="spin" /> Decrypting…</> : '🔓 Decrypt this packet'}</button>
                <button className="btn small" disabled={downloading} onClick={download}>{downloading ? <><span className="spin" /> Exporting…</> : '⬇ JSON'}</button>
              </div>
            </div>
            <div className="subtabs">
              {(['Overview', 'Requests', 'Proofs'] as const).map((t) => (
                <button key={t} className={`subtab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>{t}{t === 'Requests' && ` (${pkt.requestIds.length})`}</button>
              ))}
            </div>

            {tab === 'Overview' && (
              <div className="kv">
                <div className="kv-row"><span>Packet ID</span><span className="mono">#{String(pkt.id)}</span></div>
                <div className="kv-row"><span>Mandate ID</span><span className="mono">#{String(pkt.mandateId)} (policy v{pkt.policyVersion})</span></div>
                <div className="kv-row"><span>Auditor</span><span className="mono">{short(pkt.auditor)}</span></div>
                <div className="kv-row"><span>Created</span><span>{new Date(Number(pkt.createdAt) * 1000).toLocaleString()}</span></div>
                <div className="kv-row"><span>Policy auto-limit</span><V h={pkt.snapshotHandles[0]} /></div>
                <div className="kv-row"><span>Budget left (at packet time)</span><V h={pkt.snapshotHandles[1]} /></div>
                <div className="kv-row"><span>Reserve floor</span><V h={pkt.snapshotHandles[2]} /></div>
              </div>
            )}

            {tab === 'Requests' && (
              <div className="tbl"><table>
                <thead><tr><th>Request</th><th>Recipient</th><th>Outcome</th><th>Amount</th><th>Blocked reason</th><th>Request tx</th><th>Finalize tx</th></tr></thead>
                <tbody>
                  {pkt.requestIds.map((rid, k) => {
                    const pub = requests.find((r) => r.id === rid);
                    const t = txs.get(String(rid));
                    return (
                      <Fragment key={String(rid)}>
                        <tr>
                          <td className="mono">#{String(rid)}</td>
                          <td className="mono">{pub ? short(pub.recipient) : '—'}</td>
                          <td>{pub ? <RequestPill state={pub.state} /> : <span className="muted">—</span>}</td>
                          <td><V h={pkt.snapshotHandles[3 + k * 2]} /></td>
                          <td><V h={pkt.snapshotHandles[4 + k * 2]} unit="" label="Reason (0=ok,1=budget,2=balance,3=reserve)" /></td>
                          <td><TxLink h={t?.request} /></td>
                          <td><TxLink h={t?.approval ?? t?.finalize} /></td>
                        </tr>
                      </Fragment>
                    );
                  })}
                  {!pkt.requestIds.length && <tr><td colSpan={7} className="muted">Policy-only packet (no request snapshots).</td></tr>}
                </tbody>
              </table></div>
            )}

            {tab === 'Proofs' && (
              <div className="kv">
                <div className="kv-row"><span>Manifest hash</span><span className="mono" style={{ wordBreak: 'break-all' }}>{pkt.manifestHash}</span></div>
                <div className="kv-row"><span>Module</span><a className="mono alink" href={scan(ADDR.VeilGuardModule)} target="_blank" rel="noopener">{short(ADDR.VeilGuardModule)} ↗</a></div>
                <p className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
                  Each snapshot is a fresh isolated ciphertext handle (identity computation over the source value),
                  granted to you as a viewer via the on-chain ACL. The manifest hash binds the exact handle set;
                  decryptions are served by the Nox gateway after verifying your grant.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
