import type { Classification, EvidenceKind, RedactedItem } from '../types.js';
import { fullText, quoteFor } from '../rules/explicit.js';
import type { EvidenceModel, ModelCall, ModelClassification, ModelMapping } from './types.js';
import { itemEnvelope } from './types.js';

// A deterministic keyword stand-in for the Claude classifier and mapper, used when no
// ANTHROPIC_API_KEY is set (offline harness, CI). It is deliberately naive: it has no knowledge of
// the traps or the 5.5 decisions, so the explicit rules are what keep it honest, and the mutation
// check proves that by switching those rules off.

const KINDS: [EvidenceKind, RegExp][] = [
  ['invitation', /\b(invite you to (?:serve as |be )?(?:a |one of our )?judges?|join (?:our|the) judging panel|would you (?:like to )?judge|invitation to judge)\b/i],
  ['service_proof', /\b(thank you for judging|thanks for judging|certificate of judging|you judged|for serving as a judge)\b/i],
  ['authored', /\b(your (?:story|article|post|essay) (?:was|has been|is) (?:published|live|now live)|you published)\b/i],
  ['press_about', /\b(press release|for immediate release)\b/i],
  ['press_about', /\b(episode \d+ is live|profile is live|story is live|featured you|feature on you|article (?:about|featuring)|interview with|wrote about|google alert|entrevista|mentioned in|featuring)\b/i],
  ['acceptance', /\b(accepted|admitted|welcome to the [\w\s&]+(?:fellowship|society|association|accelerator)|selected as a fellow)\b/i],
  ['award', /\b(congratulations|winner|named (?:a|an|to)|award|prize)\b/i],
  ['role', /\b(certificate of incorporation|incorporated|board consent|bylaws)\b/i],
  ['remuneration', /\b(stock|equity|salary|offer letter|compensation|revenue)\b/i],
  ['talk', /\b(speaker|keynote|talk at|present at)\b/i],
  ['exhibition', /\b(exhibited at|on display at|gallery show|art (?:exhibition|showcase))\b/i],
];

function classify(item: RedactedItem): ModelClassification {
  const text = fullText(item);
  for (const [kind, re] of KINDS) {
    const quote = quoteFor(text, re);
    if (quote) return { is_candidate: true, kind, quote, reason: `matched ${kind} keywords` };
  }
  return { is_candidate: false, kind: 'other', quote: '', reason: 'no evidence keywords' };
}

function map(item: RedactedItem, cls: Classification): ModelMapping {
  const text = fullText(item);
  const q = (re: RegExp) => quoteFor(text, re) ?? cls.quote;
  switch (cls.kind) {
    case 'award': {
      const sel = /\b(selected from|judged by|entrants|applicants|applications|panel of|criteria|out of \d)/i;
      if (sel.test(text)) return { criteria: [1], status: 'qualifying', rule_id: 'C1-award-competitive', reason: 'A competitive award with a named issuer and stated selection criteria.', quote: q(sel) };
      return { criteria: [1], status: 'needs_attorney', rule_id: 'C1-no-selection-criteria', reason: 'The issuer states no selection criteria.', quote: cls.quote };
    }
    case 'acceptance': {
      const sel = /\b(committee|selected|acceptance rate|admitted|reviewed|applicants|applications)\b/i;
      if (/\b(fellow|fellowship|association|society|member|accelerator|batch)\b/i.test(text) && sel.test(text)) {
        return { criteria: [2], status: 'qualifying', rule_id: 'C2-selective-membership', reason: 'Membership with selective criteria judged by recognized experts.', quote: q(sel) };
      }
      return { criteria: [2], status: 'needs_attorney', rule_id: 'N-unmapped', reason: 'An acceptance with no stated selectivity.', quote: cls.quote };
    }
    case 'press_about': {
      if (/\b(episode|podcast)\b/i.test(text)) return { criteria: [3], status: 'qualifying', rule_id: 'C3-podcast', reason: 'A third-party podcast episode about the founder.', quote: q(/\b(episode|podcast)\b/i) };
      return { criteria: [3], status: 'qualifying', rule_id: 'C3-press-about', reason: 'Third-party published material about the founder.', quote: cls.quote };
    }
    case 'role':
      if (/\b(certificate of incorporation|incorporated)\b/i.test(text)) {
        return { criteria: [7], status: 'qualifying', rule_id: 'C7-critical-role', reason: 'Founder of an incorporated company with governance documents.', quote: q(/\b(certificate of incorporation|incorporated)\b/i) };
      }
      return { criteria: [7], status: 'rejected', rule_id: 'T-title-only', reason: 'A title without evidence about the organization.', quote: cls.quote };
    case 'invitation':
      return { criteria: [4], status: 'building', rule_id: 'C4-invite-unanswered', reason: 'An invitation to judge without proof of service.', quote: cls.quote };
    case 'service_proof':
      return { criteria: [4], status: 'qualifying', rule_id: 'C4-service-proof', reason: 'Proof that the founder served as a judge.', quote: cls.quote };
    case 'talk':
      if (/\b(conference|summit|symposium)\b/i.test(text)) {
        return { criteria: [6], status: 'qualifying', rule_id: 'D-talk-comparable', reason: 'A talk at a major conference.', quote: q(/\b(conference|summit|symposium)\b/i), comparable_for: [6] };
      }
      return { criteria: [6], status: 'needs_attorney', rule_id: 'C6-talk-not-major', reason: 'A talk not shown to be at a major conference.', quote: cls.quote };
    case 'remuneration':
      return { criteria: [8], status: 'needs_attorney', rule_id: 'N-unmapped', reason: 'Remuneration evidence without a benchmark.', quote: cls.quote };
    default:
      return { criteria: [], status: 'rejected', rule_id: 'R-not-evidence', reason: 'Not evidence under any criterion.', quote: cls.quote };
  }
}

export class HeuristicModel implements EvidenceModel {
  readonly name = 'heuristic-stand-in';
  readonly modelId = 'none (offline keyword stand-in)';

  async classify(item: RedactedItem, systemPrompt: string): Promise<ModelCall<ModelClassification>> {
    return { output: classify(item), prompt: `${systemPrompt}\n\n${itemEnvelope(item)}` };
  }

  async map(item: RedactedItem, cls: Classification, systemPrompt: string): Promise<ModelCall<ModelMapping>> {
    return { output: map(item, cls), prompt: `${systemPrompt}\n\n${itemEnvelope(item)}` };
  }
}
