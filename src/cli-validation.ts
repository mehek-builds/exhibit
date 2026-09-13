const MAX_TIMER_MILLISECONDS = 2_147_483_647;

export function positiveSafeInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer within JavaScript's safe range; received '${value}'.`);
  }
  return parsed;
}

export function intervalMilliseconds(value: string, flag: string): number {
  const seconds = Number(value);
  const milliseconds = seconds * 1000;
  if (
    !Number.isFinite(seconds)
    || seconds <= 0
    || !Number.isSafeInteger(milliseconds)
    || milliseconds < 1
    || milliseconds > MAX_TIMER_MILLISECONDS
  ) {
    throw new Error(`${flag} must resolve to an integer from 1 to ${MAX_TIMER_MILLISECONDS} milliseconds; received '${value}'.`);
  }
  return milliseconds;
}

export function portNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`--port must be an integer from 1 to 65535; received '${value}'.`);
  }
  return parsed;
}
