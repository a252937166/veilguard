const normalize = (address) => typeof address === 'string' ? address.toLowerCase() : '';

/**
 * Fail closed unless the connected Safe and configured signers are the exact
 * two-owner, threshold-two committee claimed by the project.
 */
export function assertExact2of2({ threshold, owners, ownerA, ownerB }) {
  if (threshold !== 2) throw new Error(`expected Safe threshold 2, got ${threshold}`);
  if (!Array.isArray(owners) || owners.length !== 2) {
    throw new Error(`expected exactly two Safe owners, got ${Array.isArray(owners) ? owners.length : 0}`);
  }
  const normalizedOwners = owners.map(normalize);
  if (normalizedOwners.some((owner) => !owner) || new Set(normalizedOwners).size !== 2) {
    throw new Error('Safe owners must be two distinct addresses');
  }
  const normalizedA = normalize(ownerA);
  const normalizedB = normalize(ownerB);
  if (!normalizedA || !normalizedB || normalizedA === normalizedB) {
    throw new Error('two distinct Safe owner signers are required');
  }
  const ownerSet = new Set(normalizedOwners);
  if (!ownerSet.has(normalizedA) || !ownerSet.has(normalizedB)) {
    throw new Error('both configured signers must be current Safe owners');
  }
  return Object.freeze({
    threshold: 2,
    owners: Object.freeze([...normalizedOwners]),
  });
}

export function assertTwoSignatures(confirmations) {
  if (confirmations !== 2) {
    throw new Error(`expected two distinct Safe signatures, got ${confirmations}`);
  }
  return 2;
}
