import { parseEventLogs } from 'viem';

/**
 * IDs returned by state-changing transactions must be attributed to the exact
 * successful receipt, never inferred from a pre-read next-id counter.
 */
export function requireSingleReceiptEvent({
  abi,
  contract,
  receipt,
  eventName,
  label,
}) {
  const events = parseEventLogs({
    abi,
    logs: receipt?.logs ?? [],
    eventName,
    strict: true,
  }).filter((event) => String(event.address).toLowerCase() === contract.toLowerCase());
  if (events.length !== 1) {
    throw new Error(`${label} expected exactly one ${eventName} event from the configured module`);
  }
  return events[0];
}
