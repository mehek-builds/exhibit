import type { CalendarEvent, GithubRepo, GithubReview } from '../apps/types.js';
import type { Classification, FounderProfile, Mapping, SourceItem } from '../types.js';
import { mapping } from './explicit.js';

// Items whose evidence is in source metadata (Calendar, GitHub) are decided without a model call.
// Thresholds are working rules (fragments/criterion-4 and criterion-5), not model judgment.

export const ADOPTION_MIN_THIRD_PARTY_STARS = 100;
export const ADOPTION_MIN_DEPENDENTS = 10;
export const REVIEW_MIN_REPO_STARS = 1000;

const JUDGE = /\b(judge|judging|jury)\b/i;
const MENTOR = /\b(mentor|office hours|coach)\b/i;
const TALK = /\b(speaker|speaking|keynote|talk|presenting|presentation)\b/i;
const MAJOR = /\b(conference|summit|symposium|con \d{4}|\w+con\b|\w+conf\b)/i;

export interface StructuredResult {
  cls: Classification;
  mapping: Mapping | null;
}

function notCandidate(reason: string): StructuredResult {
  return { cls: { is_candidate: false, kind: 'other', quote: '', decided_by: 'structured', reason }, mapping: null };
}

function line(text: string, re: RegExp): string {
  return text.split('\n').find((l) => re.test(l))?.trim() ?? text.split('\n')[0]!.trim();
}

export function selfResponse(ev: CalendarEvent, profile: FounderProfile): CalendarEvent['attendees'][number]['responseStatus'] | null {
  const emails = profile.emails.map((e) => e.toLowerCase());
  const me = ev.attendees.find((a) => a.self || emails.includes(a.email.toLowerCase()));
  return me?.responseStatus ?? null;
}

export function classifyCalendar(item: SourceItem, profile: FounderProfile, now: Date): StructuredResult {
  const ev = item.meta.event as CalendarEvent;
  const text = `${item.title}\n${item.text}`;
  const response = selfResponse(ev, profile);
  const occurred = ev.status !== 'cancelled' && Date.parse(ev.end) <= now.getTime();
  const summaryLine = line(text, /./);

  if (JUDGE.test(ev.summary)) {
    const cls: Classification = { is_candidate: true, kind: 'service_proof', quote: summaryLine, decided_by: 'structured' };
    if (ev.status === 'cancelled') {
      return { cls, mapping: mapping([4], 'building', 'C4-event-cancelled', 'The judging event was cancelled, so there is no proof of service yet.', summaryLine) };
    }
    if (response === 'declined') {
      return { cls, mapping: mapping([4], 'rejected', 'T-invite-declined', 'A declined judging invitation is not judging (#4).', summaryLine) };
    }
    if (!occurred) return notCandidate('event has not happened yet');
    if (response !== 'accepted') {
      return { cls, mapping: mapping([4], 'building', 'C4-invite-unanswered', 'The founder never accepted this judging event.', summaryLine) };
    }
    return { cls, mapping: mapping([4], 'qualifying', 'C4-service-proof', 'An accepted judging event that occurred is proof of service (#4).', summaryLine) };
  }
  if (MENTOR.test(ev.summary)) {
    return {
      cls: { is_candidate: true, kind: 'service_proof', quote: summaryLine, decided_by: 'structured' },
      mapping: mapping([4], 'rejected', 'T-mentor-not-judge', 'Mentoring without evaluating anyone is not judging (#4).', summaryLine),
    };
  }
  if (TALK.test(ev.summary)) {
    if (!occurred || response === 'declined') return notCandidate('talk did not happen');
    const cls: Classification = { is_candidate: true, kind: 'talk', quote: summaryLine, decided_by: 'structured' };
    if (MAJOR.test(`${ev.summary} ${ev.location ?? ''} ${ev.description}`)) {
      const q = line(text, MAJOR);
      return {
        cls,
        mapping: mapping([6], 'qualifying', 'D-talk-comparable', 'A talk at a major conference counts toward #6 as comparable evidence (5.5).', q, { comparable_for: [6] }),
      };
    }
    return { cls, mapping: mapping([6], 'needs_attorney', 'C6-talk-not-major', 'A talk that is not at a major conference; whether it is comparable evidence is for the attorney.', summaryLine) };
  }
  return notCandidate('routine calendar event');
}

export function thirdPartyStars(repo: GithubRepo, profile: FounderProfile): number {
  const own = new Set([...profile.ownAccounts, ...profile.githubLogins].map((a) => a.toLowerCase()));
  const listedOwn = repo.stargazers.filter((s) => own.has(s.toLowerCase())).length;
  return Math.max(0, repo.stars - listedOwn);
}

export function classifyRepo(item: SourceItem, profile: FounderProfile): StructuredResult {
  const repo = item.meta.repo as GithubRepo;
  const text = `${item.title}\n${item.text}`;
  if (repo.stars === 0 && repo.dependents === 0) return notCandidate('unshipped repo with no adoption');
  const third = thirdPartyStars(repo, profile);
  const cls: Classification = { is_candidate: true, kind: 'adoption', quote: line(text, /^Stars:/), decided_by: 'structured' };
  const q = line(text, /^Stars:/);
  if (third >= ADOPTION_MIN_THIRD_PARTY_STARS || repo.dependents >= ADOPTION_MIN_DEPENDENTS) {
    return {
      cls,
      mapping: mapping([5, 3], 'qualifying', 'C5-adoption', 'Shipped work adopted by others counts under #5; stars and forks from others also count toward #3 as comparable evidence (5.5).', q, {
        comparable_for: [3],
      }),
    };
  }
  const ownShare = repo.stars === 0 ? 0 : (repo.stars - third) / repo.stars;
  if (ownShare > 0.5) {
    return { cls, mapping: mapping([5, 3], 'building', 'T-own-stars', "Most stars come from the founder's own accounts; they are excluded and the rest is below the threshold.", q) };
  }
  return { cls, mapping: mapping([5], 'building', 'C5-below-threshold', 'Third-party adoption is below the working threshold.', q) };
}

export function classifyReview(item: SourceItem, profile: FounderProfile): StructuredResult {
  const review = item.meta.review as GithubReview;
  const text = `${item.title}\n${item.text}`;
  const own = [...profile.githubLogins, ...profile.ownAccounts].map((a) => a.toLowerCase());
  if (own.includes(review.repoOwner.toLowerCase())) return notCandidate("review on the founder's own repo");
  const q = line(text, /^Repository:/);
  const cls: Classification = { is_candidate: true, kind: 'review', quote: q, decided_by: 'structured' };
  if (review.repoStars >= REVIEW_MIN_REPO_STARS) {
    return {
      cls,
      mapping: mapping([4], 'qualifying', 'D-code-review-comparable', "A code review on a popular open-source repo counts toward #4 as comparable evidence (5.5).", q, { comparable_for: [4] }),
    };
  }
  return { cls, mapping: mapping([4], 'building', 'C4-review-below-threshold', 'The reviewed repo is below the popularity threshold.', q) };
}

export type DiscoveryClassifier = (item: SourceItem, profile: FounderProfile, now: Date) => StructuredResult | null;

let discoveryClassifier: DiscoveryClassifier | null = null;

/** Discovered items with structured kinds (6.14) are classified by the discovery module, registered at startup. */
export function registerDiscoveryClassifier(fn: DiscoveryClassifier | null): void {
  discoveryClassifier = fn;
}

export function classifyStructured(item: SourceItem, profile: FounderProfile, now: Date): StructuredResult | null {
  // A null from the discovery classifier means an article or episode: it goes through the model like an email.
  if (item.app === 'discovery') return discoveryClassifier?.(item, profile, now) ?? null;
  if (item.app === 'calendar') return classifyCalendar(item, profile, now);
  if (item.app === 'github' && item.meta.repo) return classifyRepo(item, profile);
  if (item.app === 'github' && item.meta.review) return classifyReview(item, profile);
  return null;
}
