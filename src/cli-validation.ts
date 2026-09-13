const MIN_LIVE_INTERVAL_SECONDS = 60;
const MAX_TIMER_SECONDS = 2_147_483;
const MAX_EVAL_ATTEMPTS = 100;

export function positiveSafeInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_EVAL_ATTEMPTS) {
    throw new Error(`${flag} must be a positive integer from 1 to ${MAX_EVAL_ATTEMPTS}; received '${value}'.`);
  }
  return parsed;
}

export function intervalMilliseconds(value: string, flag: string): number {
  return boundedIntervalMilliseconds(value, flag, MIN_LIVE_INTERVAL_SECONDS);
}

export function boundedIntervalMilliseconds(value: string, flag: string, minimumSeconds: number): number {
  const seconds = Number(value);
  const milliseconds = seconds * 1000;
  if (
    !Number.isFinite(seconds)
    || seconds < minimumSeconds
    || seconds > MAX_TIMER_SECONDS
    || !Number.isSafeInteger(milliseconds)
  ) {
    throw new Error(`${flag} must be from ${minimumSeconds} to ${MAX_TIMER_SECONDS} seconds, with millisecond precision; received '${value}'.`);
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
