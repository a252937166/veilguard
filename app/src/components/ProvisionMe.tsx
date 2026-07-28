import { useEffect, useState } from 'react';
import { short } from '../config';
import {
  fetchProvisionAvailability,
  provisionConnectedWallet,
  type ProvisionAvailability,
  type ProvisionPhase,
} from '../provisioning';
import { useApp } from '../App';

const PHASE_LABEL: Record<ProvisionPhase, string> = {
  network: 'Checking Sepolia network…',
  challenge: 'Requesting one-time ownership challenge…',
  signing: 'Check your wallet — sign the ownership challenge…',
  provisioning: 'Provisioning (treasury funding + 2-of-2 activation)…',
};

/**
 * Sponsored onboarding is shown as actionable only when the live backend says
 * its challenge and treasury gates are operational. Missing/legacy health is
 * treated as disabled, leaving the pre-funded shared demo as the safe path.
 */
export function ProvisionMe({ account }: { account: `0x${string}` }) {
  const { refresh, toast, startDemo } = useApp();
  const [availability, setAvailability] = useState<ProvisionAvailability | null>(null);
  const [phase, setPhase] = useState<ProvisionPhase | null>(null);

  useEffect(() => {
    let current = true;
    setAvailability(null);
    setPhase(null);
    void fetchProvisionAvailability().then((result) => {
      if (current) setAvailability(result);
    });
    return () => { current = false; };
  }, [account]);

  const provision = async () => {
    if (!availability?.operational || phase) return;
    try {
      const result = await provisionConnectedWallet({
        account,
        onPhase: setPhase,
      });
      toast(
        `✓ Your wallet is now a delegate on mandate #${result.mandateId}. `
        + 'Submit an encrypted request below — you will need a little Sepolia ETH for gas.',
      );
      window.setTimeout(() => { void refresh(); }, 2_500);
    } catch (error: any) {
      toast(`Provisioning failed: ${error?.message ?? error}`, true);
      void fetchProvisionAvailability().then(setAvailability);
    } finally {
      setPhase(null);
    }
  };

  const operational = availability?.operational === true;

  return (
    <div className="norole">
      <h3>Use your own wallet as a delegate</h3>
      <p className="muted" style={{ fontSize: 13.5, maxWidth: 660 }}>
        The module only accepts the delegate address fixed in a mandate. Sponsored onboarding for{' '}
        <b>your own wallet</b> (<span className="mono">{short(account)}</span>) is exposed only when
        wallet ownership, Safe treasury backing and the real 2-of-2 activation service are all live.
      </p>
      <div className="row" style={{ marginTop: 14 }}>
        {operational && (
          <button
            type="button"
            className="btn primary"
            disabled={phase !== null}
            onClick={() => void provision()}
          >
            {phase
              ? <><span className="spin" /> {PHASE_LABEL[phase]}</>
              : '🔑 Verify and provision my wallet'}
          </button>
        )}
        <button
          type="button"
          className={operational ? 'btn' : 'btn primary'}
          onClick={() => startDemo('delegate')}
        >
          Use the shared demo delegate
        </button>
      </div>
      <p className="muted" role="status" aria-live="polite" style={{ fontSize: 12, marginTop: 10 }}>
        {availability?.detail ?? 'Checking the provisioner challenge and treasury readiness gates…'}
        {operational
          ? ' You will sign a one-time EIP-712 ownership challenge; the treasury then funds and activates the capped encrypted policy.'
          : ' The shared delegate is already funded and requires no wallet onboarding.'}
      </p>
    </div>
  );
}
