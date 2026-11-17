const MINUTE_MS = 60_000;

export const TEARDOWN_RETRY_DELAYS_MS: readonly number[] = [
  MINUTE_MS,
  2 * MINUTE_MS,
  4 * MINUTE_MS,
  8 * MINUTE_MS,
];

export const SWEEP_ITEM_RETRY_DELAYS_MS: readonly number[] = [
  MINUTE_MS,
  2 * MINUTE_MS,
  4 * MINUTE_MS,
  8 * MINUTE_MS,
  16 * MINUTE_MS,
  32 * MINUTE_MS,
  60 * MINUTE_MS,
];

export const QUEUED_MESSAGE_RETRY_DELAYS_MS: readonly number[] = [
  15_000,
  MINUTE_MS,
  5 * MINUTE_MS,
];

const NEEDS_RECOVERY_PREFIX = "Needs recovery:";

export function needsRecoveryMessage(
  failure: string,
  recovery: string,
): string {
  return `${NEEDS_RECOVERY_PREFIX} ${failure} ${recovery}`;
}

export function isNeedsRecoveryMessage(message: string | null): boolean {
  return message?.startsWith(NEEDS_RECOVERY_PREFIX) ?? false;
}
