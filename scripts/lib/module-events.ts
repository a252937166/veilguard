import { parseEventLogs, type TransactionReceipt } from 'viem';

export function requireSingleModuleEvent(
  {
    abi,
    module,
    receipt,
    eventName,
    label,
  }: {
    abi: readonly unknown[];
    module: `0x${string}`;
    receipt: TransactionReceipt;
    eventName: string;
    label: string;
  },
): any {
  const events = parseEventLogs({
    abi: abi as any,
    logs: receipt.logs,
    eventName,
    strict: true,
  });
  if (events.length !== 1) {
    throw new Error(`${label} expected exactly one ${eventName} event, got ${events.length}`);
  }
  const event = events[0] as any;
  if (String(event.address).toLowerCase() !== module.toLowerCase()) {
    throw new Error(`${label} ${eventName} event came from an unexpected contract`);
  }
  return event;
}
