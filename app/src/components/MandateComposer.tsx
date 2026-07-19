import { useMemo, useState } from 'react';
import { ADDR, ROLES, fmt, isAddress, moduleAbi, parseUsdc, short } from '../config';
import { handleClientFor, publicClient } from '../nox';
import { walletWrite } from '../walletTx';
import { useApp } from '../App';

type MandateSeed = {
  id: bigint;
  delegate: `0x${string}`;
  recipients: `0x${string}`[];
};

type Props = {
  source?: MandateSeed;
  onCancel: () => void;
  onComplete: () => void;
};

const STEPS = ['Confidential values', 'Recipients', 'Review'] as const;

export function MandateComposer({ source, onCancel, onComplete }: Props) {
  const { account, run, busy, toast } = useApp();
  const [step, setStep] = useState(0);
  const [delegate, setDelegate] = useState<string>(source?.delegate ?? ROLES.delegate);
  const [recipients, setRecipients] = useState<string[]>(source?.recipients ?? []);
  const [recipientInput, setRecipientInput] = useState('');
  const [autoLimit, setAutoLimit] = useState(source ? '' : '40');
  const [budget, setBudget] = useState(source ? '' : '100');
  const [reserveFloor, setReserveFloor] = useState(source ? '' : '500');
  const [days, setDays] = useState('30');
  const [phase, setPhase] = useState<string | null>(null);

  const valuesValid = useMemo(() => {
    try {
      [autoLimit, budget, reserveFloor].forEach(parseUsdc);
      return isAddress(delegate) && Number.isInteger(Number(days)) && Number(days) > 0 && Number(days) <= 3650;
    } catch {
      return false;
    }
  }, [autoLimit, budget, reserveFloor, days, delegate]);
  const recipientsValid = recipients.length > 0
    && recipients.length <= 16
    && recipients.every(isAddress)
    && new Set(recipients.map((recipient) => recipient.toLowerCase())).size === recipients.length;

  const addRecipient = () => {
    const value = recipientInput.trim();
    if (!isAddress(value)) { toast('Enter a valid recipient address.', true); return; }
    if (recipients.some((recipient) => recipient.toLowerCase() === value.toLowerCase())) {
      toast('That recipient is already included.', true);
      return;
    }
    if (recipients.length >= 16) { toast('A mandate supports at most 16 recipients.', true); return; }
    setRecipients((current) => [...current, value]);
    setRecipientInput('');
  };

  const submit = async () => {
    if (!account || !valuesValid || !recipientsValid) return;
    await run(source ? `Propose replacement for mandate #${source.id}` : 'Propose confidential mandate', async () => {
      try {
        setPhase('Encrypting three policy values in this browser…');
        const client = await handleClientFor(account);
        const [limit, total, floor] = await Promise.all([
          client.encryptInput(parseUsdc(autoLimit), 'uint256', ADDR.VeilGuardModule),
          client.encryptInput(parseUsdc(budget), 'uint256', ADDR.VeilGuardModule),
          client.encryptInput(parseUsdc(reserveFloor), 'uint256', ADDR.VeilGuardModule),
        ]);
        const now = BigInt(Math.floor(Date.now() / 1000));
        setPhase('Review and sign the Finance Admin proposal…');
        const hash = await walletWrite({
          account,
          address: ADDR.VeilGuardModule,
          abi: moduleAbi,
          functionName: 'proposeMandate',
          args: [
            delegate as `0x${string}`,
            0n,
            now + BigInt(Number(days)) * 86_400n,
            recipients as `0x${string}`[],
            limit.handle,
            limit.handleProof,
            total.handle,
            total.handleProof,
            floor.handle,
            floor.handleProof,
          ],
          onHint: setPhase,
        });
        setPhase('Proposal broadcast · waiting for confirmation…');
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== 'success') throw new Error('mandate proposal reverted');
        toast(`Encrypted mandate proposed · ${short(hash)}. Safe activation is still required.`);
        onComplete();
      } finally {
        setPhase(null);
      }
    });
  };

  return (
    <section className="mandate-composer" aria-labelledby="mandate-composer-title" aria-busy={!!phase}>
      <header className="mandate-composer-head">
        <div>
          <p className="workbench-kicker">Finance Admin action</p>
          <h3 id="mandate-composer-title">{source ? `Propose a replacement for mandate #${source.id}` : 'New confidential mandate'}</h3>
          <p>{source ? 'This creates a new Draft. The active policy is never edited in place.' : 'Encrypted parameters leave the browser only as Nox ciphertext handles.'}</p>
        </div>
        <button type="button" className="btn ghost" onClick={onCancel} disabled={!!phase}>Close</button>
      </header>

      <ol className="builder-steps" aria-label="Mandate proposal steps">
        {STEPS.map((label, index) => <li key={label} aria-current={index === step ? 'step' : undefined} className={index < step ? 'complete' : index === step ? 'active' : ''}><span>{index + 1}</span><b>{label}</b></li>)}
      </ol>

      {phase && <div className="operation-note mandate-phase" role="status" aria-live="polite"><span className="spin" aria-hidden="true" />{phase}</div>}

      {step === 0 && <div className="mandate-composer-body">
        {source && <div className="inline-alert neutral">Existing ciphertext is not copied into the form. Enter every replacement value explicitly before signing.</div>}
        <div className="form-grid policy-compose-grid">
          <label>Delegate address<input className="mono" value={delegate} onChange={(event) => setDelegate(event.target.value)} /></label>
          <label>Valid for (days)<input inputMode="numeric" value={days} onChange={(event) => setDays(event.target.value)} /></label>
          <label>Auto-limit (cUSDC)<input inputMode="decimal" value={autoLimit} onChange={(event) => setAutoLimit(event.target.value)} placeholder="Required" /></label>
          <label>Total budget (cUSDC)<input inputMode="decimal" value={budget} onChange={(event) => setBudget(event.target.value)} placeholder="Required" /></label>
          <label>Reserve floor (cUSDC)<input inputMode="decimal" value={reserveFloor} onChange={(event) => setReserveFloor(event.target.value)} placeholder="Required" /></label>
        </div>
        <div className="detail-actions"><button type="button" className="btn primary" disabled={!valuesValid} onClick={() => setStep(1)}>Continue to recipients</button></div>
      </div>}

      {step === 1 && <div className="mandate-composer-body">
        <p className="muted">Only these addresses can receive payments under the proposed mandate.</p>
        <div className="recipient-list policy-recipient-editor">
          {recipients.map((recipient) => <span key={recipient} className="recipient-edit-row"><span className="mono">{recipient}</span><button type="button" className="btn ghost small" onClick={() => setRecipients((current) => current.filter((item) => item !== recipient))}>Remove</button></span>)}
        </div>
        <div className="recipient-input-row">
          <label htmlFor="policy-recipient-input">Recipient address</label>
          <input id="policy-recipient-input" className="mono" value={recipientInput} onChange={(event) => setRecipientInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addRecipient(); } }} />
          <button type="button" className="btn" onClick={addRecipient}>Add recipient</button>
        </div>
        <div className="detail-actions"><button type="button" className="btn ghost" onClick={() => setStep(0)}>Back</button><button type="button" className="btn primary" disabled={!recipientsValid} onClick={() => setStep(2)}>Review proposal</button></div>
      </div>}

      {step === 2 && <div className="mandate-composer-body">
        <dl className="review-scope-facts">
          <div><dt>Delegate</dt><dd className="mono">{short(delegate)}</dd></div>
          <div><dt>Auto-limit</dt><dd>{fmt(parseUsdc(autoLimit))} cUSDC · encrypted</dd></div>
          <div><dt>Total budget</dt><dd>{fmt(parseUsdc(budget))} cUSDC · encrypted</dd></div>
          <div><dt>Reserve floor</dt><dd>{fmt(parseUsdc(reserveFloor))} cUSDC · encrypted</dd></div>
          <div><dt>Recipients</dt><dd>{recipients.length}</dd></div>
          <div><dt>Governance state</dt><dd>Draft until Safe 2-of-2 activation</dd></div>
        </dl>
        <div className="sticky-actions"><button type="button" className="btn ghost" onClick={() => setStep(1)} disabled={!!phase}>Back</button><button type="button" className="btn primary" onClick={submit} disabled={!!busy || !!phase}>Encrypt and propose</button></div>
      </div>}
    </section>
  );
}
