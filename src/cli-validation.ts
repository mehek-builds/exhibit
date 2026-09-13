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

/** Like portNumber, but also accepts 0 (let the OS assign an ephemeral port) -- used by `serve --mock` for tests. */
export function portNumberOrEphemeral(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`--port must be an integer from 0 to 65535; received '${value}'.`);
  }
  return parsed;
}

const DURATION_UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Parses a simple duration like `1h`, `7d`, `30m`, `45s` (mock mode `--advance`/`--advance-per-tick`). */
export function durationMilliseconds(value: string, flag: string): number {
  const m = /^(\d+)(s|m|h|d)$/.exec(value.trim());
  if (!m) throw new Error(`${flag} must look like '30m', '1h' or '7d'; received '${value}'.`);
  const amount = Number(m[1]);
  const ms = amount * DURATION_UNIT_MS[m[2]!]!;
  if (!Number.isSafeInteger(ms) || ms < 0) throw new Error(`${flag} is out of range: '${value}'.`);
  return ms;
}

/** `--mock` and `--live` are mutually exclusive across run/watch/serve/verify/text. */
export function assertNotBothModes(values: { mock?: boolean; live?: boolean }): void {
  if (values.mock && values.live) {
    throw new Error('--mock and --live cannot be combined; choose one.');
  }
}
