import { Fragment, useEffect, useState } from 'react';
import { ADDR, moduleAbi, short } from '../config';
import { publicClient } from '../nox';
import { useApp } from '../App';
import { Decrypt, NoRole } from '../ui';

type Packet = {
  id: bigint; auditor: `0x${string}`; mandateId: bigint; policyVersion: number;
  manifestHash: `0x${string}`; createdAt: bigint; requestIds: bigint[]; snapshotHandles: `0x${string}`[];
};

export function AuditorView() {
  const { account } = useApp();
  const [packets, setPackets] = useState<Packet[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const next = (await publicClient.readContract({
          address: ADDR.VeilGuardModule, abi: moduleAbi, functionName: 'nextPacketId',
        })) as bigint;
        const out: Packet[] = [];
        for (let i = 1n; i < next; i++) {
          const p = (await publicClient.readContract({
            address: ADDR.VeilGuardModule, abi: moduleAbi, functionName: 'getAuditPacket', args: [i],
          })) as any[];
          out.push({ id: i, auditor: p[0], mandateId: p[1], policyVersion: Number(p[2]), manifestHash: p[3], createdAt: p[4], requestIds: p[5] as bigint[], snapshotHandles: p[6] as `0x${string}`[] });
        }
        setPackets(out);
      } catch (e) { console.error(e); }
    })();
  }, [account]);

  if (!account)
    return <NoRole demo="auditor" title="Act as an Auditor"
      body="An auditor decrypts the scoped, immutable disclosure snapshots the finance admin granted — and nothing else. Try the demo auditor account to decrypt a real packet's policy values, request amounts and coarse reasons." />;
  const mine = packets.filter((p) => p.auditor.toLowerCase() === account.toLowerCase());

  return (
    <>
      <div className="notice">
        A packet is a <b>selective-disclosure snapshot</b>: fresh ciphertext handles covering one policy version
        and a chosen set of terminal requests (each disclosing its amount and coarse reason). You can decrypt
        them forever — but never gain access to live state, future versions, or the ability to compute on the
        handles. This is scoped disclosure, <b>not</b> a standalone proof that every historical request complied.
      </div>

      {mine.map((p) => (
        <div className="card" key={String(p.id)}>
          <h3>
            Packet #{String(p.id)} — mandate #{String(p.mandateId)} (policy v{p.policyVersion})
            <small>manifest {p.manifestHash.slice(0, 18)}…</small>
          </h3>
          <div className="tbl"><table>
            <thead><tr><th>Disclosure item</th><th>Value</th></tr></thead>
            <tbody>
              <tr><td>Auto-limit (policy)</td><td><Decrypt handle={p.snapshotHandles[0]} /></td></tr>
              <tr><td>Budget left (at packet time)</td><td><Decrypt handle={p.snapshotHandles[1]} /></td></tr>
              <tr><td>Reserve floor (policy)</td><td><Decrypt handle={p.snapshotHandles[2]} /></td></tr>
              {p.requestIds.map((rid, k) => (
                <Fragment key={String(rid)}>
                  <tr><td>Request #{String(rid)} — amount</td><td><Decrypt handle={p.snapshotHandles[3 + k * 2]} /></td></tr>
                  <tr><td>Request #{String(rid)} — blocked reason</td><td><Decrypt handle={p.snapshotHandles[4 + k * 2]} unit="" label="Reason (0=ok,1=budget,2=balance,3=reserve)" /></td></tr>
                </Fragment>
              ))}
            </tbody>
          </table></div>
        </div>
      ))}
      {!mine.length && (
        <div className="card"><p className="muted">
          No packets disclosed to {short(account)} yet. Ask the finance admin to create one.
        </p></div>
      )}
    </>
  );
}
