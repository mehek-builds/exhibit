// Quiet hours for proactive texts (PRD 4.1, 6.13). Computed in the founder's own time zone via
// Intl, so a window that crosses midnight and daylight-saving transitions still resolves correctly:
// we read the local wall-clock hour/minute directly rather than doing UTC offset arithmetic.

export interface QuietHours {
  start: string; // 'HH:MM' local
  end: string; // 'HH:MM' local
  timeZone: string;
}

export const DEFAULT_QUIET_HOURS: QuietHours = { start: '22:00', end: '08:00', timeZone: 'America/Los_Angeles' };

function localMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return h * 60 + m;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** True when `now`, read in `q.timeZone`, falls inside the quiet window (start inclusive, end exclusive). */
export function inQuietHours(now: Date, q: QuietHours = DEFAULT_QUIET_HOURS): boolean {
  const start = toMinutes(q.start);
  const end = toMinutes(q.end);
  if (start === end) return false; // a zero-width window means "never quiet"
  const cur = localMinutes(now, q.timeZone);
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

/** The next instant at or after `now` that is outside quiet hours (minute-resolution scan; this path runs at most once per notification, never in a hot loop). */
export function nextAllowed(now: Date, q: QuietHours = DEFAULT_QUIET_HOURS): Date {
  let d = new Date(now.getTime());
  for (let i = 0; i <= 24 * 60; i++) {
    if (!inQuietHours(d, q)) return d;
    d = new Date(d.getTime() + 60_000);
  }
  return d;
}
