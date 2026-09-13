import { GROUND_TRUTH } from './corpus.js';
import type { HarnessEnv } from './env.js';

// Known-answer scoring for S1 (reliability brief §5 "Known answers", PRD 12.6): compares the
// ledger's end-of-run candidates against harness/corpus.ts GROUND_TRUTH directly, rather than
// parsing grader check names, so the brief's numbers survive a rename of a grade.ts check.

export interface KnownAnswers {
  trapsFiledQualifying: number;
  trapsTotal: number;
  mustCountFiledQualifying: number;
  mustCountTotal: number;
  qualifyingHit: number;
  qualifyingTotal: number;
  qualifyingRecall: number;
  dateHit: number;
  dateTotal: number;
  dateAccuracy: number;
  dualHit: number;
  dualTotal: number;
  dualAccuracy: number;
}

function findCandidate(env: HarnessEnv, source: string) {
  const [app, id] = source.includes(':') ? [source.slice(0, source.indexOf(':')), source.slice(source.indexOf(':') + 1)] : [source, ''];
  return env.ledger.candidates().find((c) => c.sources.some((s) => s.app === app && s.id === id));
}

export function knownAnswers(env: HarnessEnv): KnownAnswers {
  let trapsFiledQualifying = 0;
  let trapsTotal = 0;
  let mustCountFiledQualifying = 0;
  let mustCountTotal = 0;
  let qualifyingHit = 0;
  let qualifyingTotal = 0;
  let dateHit = 0;
  let dateTotal = 0;
  let dualHit = 0;
  let dualTotal = 0;

  for (const row of GROUND_TRUTH) {
    const c = findCandidate(env, row.source);

    if (row.kind === 'trap') {
      trapsTotal += 1;
      if (c?.status === 'qualifying') trapsFiledQualifying += 1;
    }
    if (row.kind === 'must_count') {
      mustCountTotal += 1;
      if (c?.status === 'qualifying') mustCountFiledQualifying += 1;
    }
    if (row.kind === 'qualifying') {
      qualifyingTotal += 1;
      if (c?.status === 'qualifying') qualifyingHit += 1;
    }
    if (row.event_date !== undefined) {
      dateTotal += 1;
      if (c?.event_date === row.event_date) dateHit += 1;
    }
    if (row.kind !== 'trap') {
      dualTotal += 1;
      if (c && c.status === row.status && c.eb1a_status === row.eb1a_status) dualHit += 1;
    }
  }

  return {
    trapsFiledQualifying,
    trapsTotal,
    mustCountFiledQualifying,
    mustCountTotal,
    qualifyingHit,
    qualifyingTotal,
    qualifyingRecall: qualifyingTotal ? qualifyingHit / qualifyingTotal : 1,
    dateHit,
    dateTotal,
    dateAccuracy: dateTotal ? dateHit / dateTotal : 1,
    dualHit,
    dualTotal,
    dualAccuracy: dualTotal ? dualHit / dualTotal : 1,
  };
}
