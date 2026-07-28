export type FreshRole = 'admin' | 'signerB' | 'delegate' | 'auditor';
export type Address = `0x${string}`;

export type RoleTargetConfig = Readonly<{
  env: string;
  defaultEth: string;
}>;

export const ROLE_TARGET_CONFIG: Readonly<Record<FreshRole, RoleTargetConfig>>;

export type RoleTargets = Record<FreshRole, bigint>;

export function parseFundingTarget(value: string, envName: string): bigint;

export function resolveRoleTargets(
  readEnv: (name: string) => string | undefined,
): RoleTargets;

export function requiredTopUp(currentBalance: bigint, targetBalance: bigint): bigint;

export type RoleFundingTarget = {
  role: FreshRole;
  address: Address;
  targetBalance: bigint;
};

export type RoleFundingPlan = RoleFundingTarget & {
  currentBalance: bigint;
  plannedTopUp: bigint;
};

export type FundingPlan = {
  roles: RoleFundingPlan[];
  totalTopUp: bigint;
};

export function createFundingPlan(
  targets: RoleFundingTarget[],
  getBalance: (address: Address) => Promise<bigint>,
): Promise<FundingPlan>;

export type FundRoleResult = {
  balanceBeforeFunding: bigint;
  transferred: bigint;
  finalBalance: bigint;
};

export function fundRoleToTarget(
  plan: RoleFundingPlan,
  operations: {
    getBalance: (address: Address) => Promise<bigint>;
    sendTopUp: (address: Address, value: bigint) => Promise<void>;
  },
): Promise<FundRoleResult>;
