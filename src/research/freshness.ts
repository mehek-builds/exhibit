import type { Ledger } from '../ledger.js';

// PRD 6.11: figures older than 12 months at export are re-researched and re-queued, not silently
// carried forward. The Corroborator (src/research/corroborator.ts) already skips stale *candidates*
// before queueing a new figure; this module is the other half — it walks already-approved figures
// and, once their as_of/snapshot date has aged past the freshness window, puts them back in front of
// the founder instead of letting a year-old number ride quietly into the binder.

export const FRESHNESS_MONTHS = 12;

export interface FreshnessResult {
  /** fig_ids that were approved but are now stale and have been reset to `pending`. */
  staleFigIds: string[];
}

function monthsBetween(asOf: string, now: Date): number {
  const d = new Date(asOf);
  if (Number.isNaN(d.getTime())) return 0;
  return (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
}

/**
 * Finds approved figures whose as_of date is >= FRESHNESS_MONTHS old, resets them to `pending`
 * (clearing the prior decision so nothing already-approved can be written into context notes again
 * without a fresh founder approval — see decideFigure's `fig.status !== 'pending'` guard in
 * src/review/queue.ts), clears the Corroborator's `corroborated:<exhibit>` cache key so the next
 * Corroborator pass re-researches the exhibit instead of skipping it as already-handled, and logs a
 * `figure_stale` ledger event for traceability.
 */
export function requeueStaleFigures(ledger: Ledger, now: Date, ctx: { runId: string; traceId: string | null }): FreshnessResult {
  const staleFigIds: string[] = [];
  for (const fig of ledger.figures({ status: 'approved' })) {
    if (monthsBetween(fig.as_of, now) < FRESHNESS_MONTHS) continue;
    // Re-queue once: an approval given after the figure was already stale is the founder's decision
    // on the stale number, so it is kept. Without this an old figure would re-queue every run.
    if (fig.decided_at && monthsBetween(fig.as_of, new Date(fig.decided_at)) >= FRESHNESS_MONTHS) continue;
    ledger.updateFigure(fig.fig_id, { status: 'pending', decided_at: null, decision_reason: null });
    ledger.set(`corroborated:${fig.exhibit_id.split('.v')[0]}`, '');
    // Bump the figure's row-identity version (constraint 13). The old Sheet row's ID cell still
    // encodes the PREVIOUS version, so applyDecisions -- which only reads a decision from a row
    // whose version equals the figure's current version -- can never read that row as a decision
    // on the new version again, regardless of row order, a failed append, or a crash before the
    // fresh row lands (see figVersion/parseIdCell in src/review/queue.ts).
    const currentVersion = ledger.get(`fig_version:${fig.fig_id}`);
    const nextVersion = (currentVersion ? Number(currentVersion) : 1) + 1;
    ledger.set(`fig_version:${fig.fig_id}`, String(nextVersion));
    // Clear the on-Sheet flag so queueFigures appends a brand-new (v${nextVersion}) row for this
    // figure once research completes.
    ledger.set(`on_sheet:${fig.fig_id}`, '');
    ledger.event({
      run_id: ctx.runId,
      trace_id: ctx.traceId,
      kind: 'figure_stale',
      detail: { fig_id: fig.fig_id, exhibit_id: fig.exhibit_id, as_of: fig.as_of, months_old: monthsBetween(fig.as_of, now) },
      at: now.toISOString(),
    });
    staleFigIds.push(fig.fig_id);
  }
  return { staleFigIds };
}
