import { useEffect, useState } from 'react';
import { ADDR, moduleAbi, short } from '../config';
import { publicClient } from '../nox';
import { useApp } from '../App';
import { Decrypt } from '../ui';

type Packet = {
  id: bigint; auditor: `0x${string}`; mandateId: bigint; policyVersion: number;
  manifestHash: `0x${string}`; createdAt: bigint; snapshotHandles: `0x${string}`[];
};

const SNAP_LABELS = ['Auto-limit', 'Budget left (at packet time)', 'Reserve floor'];

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
          out.push({ id: i, auditor: p[0], mandateId: p[1], policyVersion: Number(p[2]), manifestHash: p[3], createdAt: p[4], snapshotHandles: p[5] });
        }
        setPackets(out);
      } catch (e) { console.error(e); }
    })();
  }, [account]);

  if (!account) return <div className="notice">Connect the auditor wallet to read disclosure packets.</div>;
  const mine = packets.filter((p) => p.auditor.toLowerCase() === account.toLowerCase());

  return (
    <>
      <div className="notice">
        Audit packets are <b>scoped, immutable disclosure snapshots</b>: fresh ciphertext handles covering
        exactly one policy version and a chosen set of requests. You can decrypt them forever — but you
        never gain access to live state or future versions, and you cannot compute on the handles.
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
              {p.snapshotHandles.map((h, i) => (
                <tr key={h}>
                  <td>{SNAP_LABELS[i] ?? `Request amount #${i - 2}`}</td>
                  <td><Decrypt handle={h} /></td>
                </tr>
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
