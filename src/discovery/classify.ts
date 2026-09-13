import { mapping, PATTERNS, quoteFor } from '../rules/explicit.js';
import type { StructuredResult } from '../rules/structured.js';
import type { Classification, FounderProfile, SourceItem } from '../types.js';

// Structured classifier for discovered items with structured kinds (PRD 6.14, prompts/fragments/discovery.json).
// `article` and `podcast_episode` return null so they fall through to the model like an email (the
// heuristic model's press_about keywords carry C3-press-about, per models/heuristic.ts).

const HF_MODEL_ADOPTION_THRESHOLD = 10_000;

function quote(text: string): string {
  return text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? text.trim();
}

function candidate(kind: Classification['kind'], q: string): Classification {
  return { is_candidate: true, kind, quote: q, decided_by: 'structured' };
}

export function classifyDiscovered(item: SourceItem, _profile: FounderProfile, _now: Date): StructuredResult | null {
  const kind = item.meta.kind as string | undefined;
  const text = `${item.title}\n${item.text}`;
  const q = quote(text);

  switch (kind) {
    case 'launch': {
      const submittedByFounder = Boolean(item.meta.submittedByFounder);
      if (!submittedByFounder) return null; // a launch she did not submit goes through the model like press
      return {
        cls: candidate('adoption', q),
        mapping: mapping([5], 'building', 'X-self-submitted-launch', 'A launch the founder submitted herself is #5 context (adoption), never #3 press (E59).', q),
      };
    }
    case 'badge':
      return {
        cls: candidate('award', q),
        mapping: mapping([1], 'needs_attorney', 'N-badge-no-rule', 'A Product of the Day badge is a #1 candidate; no rule decision covers it yet (E60).', q),
      };
    case 'review_assignment': {
      const meta = item.meta as { role?: string; venue?: string; status?: 'accepted' | 'declined' | 'pending' };
      if (meta.status === 'accepted') {
        return {
          cls: candidate('review', q),
          mapping: mapping([4], 'qualifying', 'D-reviewer-judging', 'An accepted reviewer or area-chair assignment is judging the work of others (#4).', q),
        };
      }
      if (meta.status === 'declined') {
        return {
          cls: candidate('review', q),
          mapping: mapping([4], 'building', 'C4-review-assignment-declined', 'An assignment for a venue she declined is not judging (E62); building at most.', q),
        };
      }
      return null; // pending: no decision yet, fall through
    }
    case 'filing': {
      const meta = item.meta as { issuerName?: string };
      return {
        cls: candidate('remuneration', q),
        mapping: mapping([8], 'qualifying', 'D-form-d-funding', `An SEC EDGAR Form D for ${meta.issuerName ?? 'her company'} is #8 remuneration (venture funding counts, 5.5); it is also #7 context.`, q),
      };
    }
    case 'patent':
      return {
        cls: candidate('adoption', q),
        mapping: mapping([5], 'qualifying', 'C5-patent', 'A granted patent or application naming her as inventor is #5.', q),
      };
    case 'model': {
      const meta = item.meta as { downloads?: number };
      const downloads = meta.downloads ?? 0;
      const status = downloads >= HF_MODEL_ADOPTION_THRESHOLD ? 'qualifying' : 'building';
      return {
        cls: candidate('adoption', q),
        mapping: mapping(
          [5],
          status,
          'C5-model-adoption',
          `Hugging Face downloads on her model are #5 adoption evidence; ${downloads.toLocaleString()} downloads is ${status === 'qualifying' ? 'at or above' : 'below'} the working threshold of ${HF_MODEL_ADOPTION_THRESHOLD.toLocaleString()}.`,
          q,
        ),
      };
    }
    case 'article':
    case 'podcast_episode': {
      // Discovery sources return metadata (title, outlet), not a mailbox body, so these are decided from
      // that metadata. The trap rules still apply: a press release, a paid placement or the founder's own
      // site is never press about her.
      const outlet = item.author?.domain ?? null;
      const self = !!outlet && (outlet === _profile.domain || outlet.endsWith(`.${_profile.domain}`));
      const trap = self ? null : quoteFor(text, PATTERNS.pressRelease) ?? quoteFor(text, PATTERNS.paidPlacement);
      if (self || trap) {
        return {
          cls: candidate('press_about', trap ?? q),
          mapping: mapping([3], 'rejected', self ? 'T-self-authored-not-press' : PATTERNS.pressRelease.test(text) ? 'T-press-release' : 'T-paid-placement', self ? "Published on the founder's own domain; not press about her (#3)." : 'A press release or paid placement is not press about the founder (#3).', trap ?? q),
        };
      }
      return {
        cls: candidate('press_about', q),
        mapping: mapping([3], 'qualifying', 'C3-discovered-press', `A third-party ${kind === 'podcast_episode' ? 'podcast episode' : 'article'} that names the founder and a second identifier (#3); the outlet's readership is researched separately.`, q),
      };
    }
    default:
      return null;
  }
}
