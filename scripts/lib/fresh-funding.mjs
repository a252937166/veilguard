import { parseEther } from 'viem';

export const ROLE_TARGET_CONFIG = Object.freeze({
  admin: Object.freeze({
    env: 'FRESH_ADMIN_TARGET_ETH',
    defaultEth: '0.012',
  }),
  signerB: Object.freeze({
    env: 'FRESH_SIGNER_B_TARGET_ETH',
    defaultEth: '0.010',
  }),
  delegate: Object.freeze({
    env: 'FRESH_DELEGATE_TARGET_ETH',
    defaultEth: '0.012',
  }),
  auditor: Object.freeze({
    env: 'FRESH_AUDITOR_TARGET_ETH',
    defaultEth: '0.001',
  }),
});

export function parseFundingTarget(value, envName) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(value)) {
    throw new Error(`${envName} must be a non-negative decimal ETH amount`);
  }
  return parseEther(value);
}

export function resolveRoleTargets(readEnv) {
  return Object.fromEntries(
    Object.entries(ROLE_TARGET_CONFIG).map(([role, config]) => {
      const configured = readEnv(config.env);
      const empiricalFloor = parseFundingTarget(config.defaultEth, config.env);
      const target = parseFundingTarget(
        configured === undefined ? config.defaultEth : configured,
        config.env,
      );
      if (target < empiricalFloor) {
        throw new Error(
          `${config.env} cannot undercut the empirical ${config.defaultEth} ETH floor`,
        );
      }
      return [
        role,
        target,
      ];
    }),
  );
}

export function requiredTopUp(currentBalance, targetBalance) {
  if (currentBalance < 0n || targetBalance < 0n) {
    throw new Error('role balances and targets must be non-negative');
  }
  return currentBalance >= targetBalance ? 0n : targetBalance - currentBalance;
}

export async function createFundingPlan(targets, getBalance) {
  const roles = await Promise.all(targets.map(async (target) => {
    const currentBalance = await getBalance(target.address);
    return {
      ...target,
      currentBalance,
      plannedTopUp: requiredTopUp(currentBalance, target.targetBalance),
    };
  }));

  return {
    roles,
    totalTopUp: roles.reduce((total, role) => total + role.plannedTopUp, 0n),
  };
}

export async function fundRoleToTarget(plan, { getBalance, sendTopUp }) {
  const balanceBeforeFunding = await getBalance(plan.address);
  const liveTopUp = requiredTopUp(balanceBeforeFunding, plan.targetBalance);

  if (liveTopUp > plan.plannedTopUp) {
    throw new Error(
      `${plan.role} balance dropped after preflight; `
      + `required top-up now exceeds the reserved funding plan`,
    );
  }

  if (liveTopUp > 0n) {
    await sendTopUp(plan.address, liveTopUp);
  }

  const finalBalance = await getBalance(plan.address);
  if (finalBalance < plan.targetBalance) {
    throw new Error(`${plan.role} funding did not reach its configured target balance`);
  }

  return {
    balanceBeforeFunding,
    transferred: liveTopUp,
    finalBalance,
  };
}
