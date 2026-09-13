import type { CalendarEvent, GmailMessage } from '../apps/types.js';
import type { Ledger } from '../ledger.js';
import { mapping as mkMapping, O1_TO_EB1 } from '../rules/explicit.js';
import type { Check, Classification, FounderProfile, Mapping, Person, SourceItem, SourceRef, VerifiedItem } from '../types.js';
import { domainOf, hostMatches, isoDay, normalizeTitle, normalizeUrl, uniq } from '../util.js';
import { parseAddress } from './intake.js';
import { parseInviteActionDate, type ActionDate } from './inviteDate.js';

// Verifier (PRD 6.5): original date, issuer from the domain, proof of service for criterion 4,
// cross-source merge. Any failed check downgrades to needs_attorney with the check named.

export interface Candidate {
  item: SourceItem;
  cls: Classification;
  mapping: Mapping;
}

export interface VerifyDeps {
  profile: FounderProfile;
  ledger: Ledger;
  founderMessages: GmailMessage[];
  now: Date;
}

const STOPWORDS = {
  en: ['the', 'and', 'you', 'your', 'for', 'with', 'this', 'that', 'is', 'are', 'we', 'of', 'to'],
  es: ['el', 'la', 'los', 'las', 'de', 'que', 'y', 'en', 'para', 'con', 'una', 'por', 'su', 'sobre'],
  fr: ['le', 'la', 'les', 'des', 'et', 'est', 'pour', 'avec', 'une', 'dans', 'sur', 'vous'],
  de: ['der', 'die', 'das', 'und', 'ist', 'mit', 'für', 'eine', 'nicht', 'sie', 'auf', 'wir'],
} as const;

export function looksNonEnglish(text: string): boolean {
  const words = text.toLowerCase().match(/[a-záéíóúñüàèçöäß]+/g) ?? [];
  if (words.length < 12) return false;
  const score = (list: readonly string[]) => words.filter((w) => list.includes(w)).length;
  const en = score(STOPWORDS.en);
  const other = Math.max(score(STOPWORDS.es), score(STOPWORDS.fr), score(STOPWORDS.de));
  return other > en * 1.5 && other >= 4;
}

function issuerOf(item: SourceItem): string | null {
  if (item.app === 'gmail') return item.author?.domain ?? null;
  if (item.app === 'calendar') return item.author?.domain ?? domainOf(item.url);
  if (item.app === 'linkedin') return item.author?.domain ?? domainOf(item.url);
  if (item.app === 'github') return 'github.com';
  if (item.app === 'discovery') return item.author?.domain ?? domainOf(item.url);
  return null;
}

function refOf(item: SourceItem): SourceRef {
  return { app: item.app, id: item.id, url: item.url ?? null };
}

function personOf(item: SourceItem): Person[] {
  if (!item.author?.email && !item.author?.name) return [];
  return [{ name: item.author.name, email: item.author.email, domain: item.author.domain }];
}

// ---------- criterion 4: judging cases, persisted across runs ----------

interface JudgingCase {
  domain: string;
  title: string;
  invite: { ref: SourceRef; date: string | null; subject: string; threadId?: string } | null;
  accepted: boolean;
  declined: boolean;
  served: { ref: SourceRef; kind: 'calendar' | 'thank_you' | 'certificate'; date: string | null } | null;
  cancelled: boolean;
  eventDate: string | null;
  /** For an unanswered invite only: the reply deadline or event date parsed from the invite's own
   * text (PRD 4.1/6.13 time-sensitive nudge). Never used for `event_date` / date-accuracy scoring. */
  actionDate: ActionDate | null;
  student: boolean;
  submissions: number | null;
  quote: string;
  sources: SourceRef[];
  people: Person[];
  primaryItemId: { app: SourceItem['app']; id: string } | null;
}

const ACCEPT = /\b(happy to|glad to|would love to|count me in|i accept|i'?m in\b|yes,? i can|i'?d be (?:glad|happy|honou?red))/i;
const DECLINE = /\b(unfortunately|can'?t make it|cannot make it|have to decline|i'?ll pass|not able to|won'?t be able)/i;
const STUDENT = /\b(student|university|college|high school|MLH|undergrad)/i;

function submissionsIn(text: string): number | null {
  const m = text.match(/(?:judg\w*|review\w*|scor\w*|evaluat\w*)\s+(\d{1,4})\s+(?:submissions|projects|teams|entries)|(\d{1,4})\s+(?:submissions|projects|teams|entries)/i);
  const n = m ? Number(m[1] ?? m[2]) : NaN;
  return Number.isFinite(n) ? n : null;
}

function loadCase(ledger: Ledger, domain: string): JudgingCase {
  const raw = ledger.get(`judging:${domain}`);
  if (raw) return JSON.parse(raw) as JudgingCase;
  return { domain, title: '', invite: null, accepted: false, declined: false, served: null, cancelled: false, eventDate: null, actionDate: null, student: false, submissions: null, quote: '', sources: [], people: [], primaryItemId: null };
}

function founderReply(msgs: GmailMessage[], invite: { threadId?: string; subject: string }): 'accepted' | 'declined' | null {
  const subject = normalizeTitle(invite.subject);
  const replies = msgs.filter((m) => (invite.threadId && m.threadId === invite.threadId) || normalizeTitle(m.subject) === subject);
  for (const r of replies.sort((a, b) => Date.parse(b.date) - Date.parse(a.date))) {
    const own = r.body.split(/\n>|\nOn .+wrote:/)[0] ?? r.body;
    if (DECLINE.test(own)) return 'declined';
    if (ACCEPT.test(own)) return 'accepted';
  }
  return null;
}

function resolveJudging(c: JudgingCase): { mapping: Mapping; checks: Check[] } {
  const checks: Check[] = [
    { name: 'invitation', pass: !!c.invite, detail: c.invite ? `invited ${isoDay(c.invite.date) ?? 'undated'}` : 'no invitation on record' },
    { name: 'accepted', pass: c.accepted, detail: c.accepted ? 'founder accepted' : c.declined ? 'founder declined' : 'no acceptance found' },
    { name: 'proof_of_service', pass: !!c.served, detail: c.served ? `${c.served.kind} ${isoDay(c.served.date) ?? ''}`.trim() : 'no event, listing, thank-you or certificate' },
  ];
  const quote = c.quote || c.title;
  if (c.declined && !c.served) return { mapping: mkMapping([4], 'rejected', 'T-invite-declined', 'A declined judging invitation is not judging (#4).', quote), checks };
  const proofIsThanks = c.served && c.served.kind !== 'calendar';
  if (c.served && (c.accepted || proofIsThanks)) {
    if (c.student) {
      return { mapping: mkMapping([4], 'qualifying', 'D-student-hackathon-judging', 'Invitation accepted and service proven; judging a student hackathon counts (5.5).', quote), checks };
    }
    return { mapping: mkMapping([4], 'qualifying', 'C4-service-proof', 'Invitation accepted and service proven (event occurred, thank-you or certificate).', quote), checks };
  }
  if (c.cancelled) return { mapping: mkMapping([4], 'building', 'C4-event-cancelled', 'The judging event was cancelled; no proof of service.', quote), checks };
  if (c.accepted) return { mapping: mkMapping([4], 'building', 'C4-awaiting-service', 'Invitation accepted; waiting for proof that the judging happened.', quote), checks };
  return { mapping: mkMapping([4], 'building', 'C4-invite-unanswered', 'An invitation to judge with no reply and no proof of service.', quote), checks };
}

function isJudging(c: Candidate): boolean {
  if (c.mapping.rule_id === 'D-code-review-comparable' || c.mapping.rule_id === 'C4-review-below-threshold') return false;
  return c.mapping.criteria.includes(4) && (c.cls.kind === 'invitation' || c.cls.kind === 'service_proof') && c.mapping.rule_id !== 'T-mentor-not-judge';
}

function judgingDomain(item: SourceItem): string | null {
  if (item.app === 'calendar') {
    const ev = item.meta.event as CalendarEvent;
    return domainOf(ev.organizer?.email) ?? domainOf(item.url);
  }
  return item.author?.domain ?? null;
}

// ---------- main ----------

export function verify(candidates: Candidate[], itemsById: Map<string, SourceItem>, deps: VerifyDeps): VerifiedItem[] {
  const { profile, ledger, founderMessages, now } = deps;
  const out: VerifiedItem[] = [];

  // 1. Judging cases.
  const touched = new Set<string>();
  for (const c of candidates.filter(isJudging)) {
    const domain = judgingDomain(c.item);
    if (!domain) continue;
    const jc = loadCase(ledger, domain);
    const text = `${c.item.title}\n${c.item.text}`;
    jc.sources = uniqRefs([...jc.sources, refOf(c.item)]);
    jc.people = uniqPeople([...jc.people, ...personOf(c.item)]);
    jc.student ||= STUDENT.test(text);
    jc.submissions ??= submissionsIn(text);
    if (c.item.app === 'calendar') {
      const ev = c.item.meta.event as CalendarEvent;
      jc.title ||= ev.summary;
      jc.eventDate = ev.start;
      if (c.mapping.rule_id === 'C4-service-proof') {
        jc.served ??= { ref: refOf(c.item), kind: 'calendar', date: ev.start };
        jc.accepted = true;
      }
      if (c.mapping.rule_id === 'T-invite-declined') jc.declined = true;
      if (c.mapping.rule_id === 'C4-event-cancelled') jc.cancelled = true;
    } else if (c.cls.kind === 'invitation') {
      jc.invite ??= { ref: refOf(c.item), date: c.item.date, subject: c.item.title, threadId: c.item.threadId };
      jc.title ||= c.item.title;
      jc.quote ||= c.cls.quote;
      jc.primaryItemId ??= { app: c.item.app, id: c.item.id };
      jc.actionDate ??= parseInviteActionDate(text, c.item.date);
    } else {
      const kind = /certificate/i.test(text) ? 'certificate' : 'thank_you';
      jc.served ??= { ref: refOf(c.item), kind, date: c.item.date };
      jc.title ||= c.item.title;
      jc.quote ||= c.cls.quote;
      jc.primaryItemId ??= { app: c.item.app, id: c.item.id };
    }
    touched.add(domain);
    ledger.set(`judging:${domain}`, JSON.stringify(jc));
  }
  // Re-read the founder's replies for every open case, including ones touched in earlier runs.
  for (const key of ledger.candidates().filter((k) => k.key.startsWith('judging:')).map((k) => k.key.slice('judging:'.length))) touched.add(key);
  for (const domain of touched) {
    const jc = loadCase(ledger, domain);
    if (jc.invite) {
      const reply = founderReply(founderMessages, jc.invite);
      if (reply === 'accepted') jc.accepted = true;
      if (reply === 'declined') jc.declined = true;
    }
    ledger.set(`judging:${domain}`, JSON.stringify(jc));
    const { mapping, checks } = resolveJudging(jc);
    const prior = ledger.candidate(`judging:${domain}`);
    const primary =
      (jc.primaryItemId && itemsById.get(`${jc.primaryItemId.app}:${jc.primaryItemId.id}`)) ||
      jc.sources.map((s) => itemsById.get(`${s.app}:${s.id}`)).find(Boolean);
    if (!primary) {
      // Nothing new this run for this case; only re-emit when its resolution changed.
      if (!prior || prior.status === mapping.status) continue;
    }
    const members = jc.sources.map((s) => itemsById.get(`${s.app}:${s.id}`)).filter((x): x is SourceItem => !!x);
    const primaryItem = primary ?? members[0];
    if (!primaryItem) continue;
    out.push({
      key: `judging:${domain}`,
      mapping,
      title: jc.title || primaryItem.title,
      issuer: domain,
      event_date: jc.eventDate ?? jc.served?.date ?? jc.invite?.date ?? null,
      url: primaryItem.url ?? null,
      sources: jc.sources,
      primary: primaryItem,
      members,
      checks,
      metrics: jc.submissions ? { submissions_judged: jc.submissions, observed_at: isoDay(now.toISOString())! } : {},
      highlights: uniq([profile.name, domain, jc.title, mapping.quote].filter(Boolean) as string[]),
      people: jc.people,
    });
  }

  // 2. Everything else: per-item checks, then cross-source merge.
  const groups = new Map<string, Candidate[]>();
  for (const c of candidates.filter((x) => !isJudging(x))) {
    const key = mergeKey(c);
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  for (const [key, group] of groups) {
    out.push(mergeGroup(key, group, deps));
  }
  return out;
}

function chooseLink(item: SourceItem): string | null {
  const links = item.links ?? [];
  const own = links.find((l) => item.author?.domain && hostMatches(domainOf(l) ?? '', item.author.domain));
  return own ?? item.url ?? links[0] ?? null;
}

export function mergeKey(c: Candidate): string {
  if (c.item.app === 'github') {
    const repo = c.item.meta.repo as { fullName: string } | undefined;
    const review = c.item.meta.review as { id: string } | undefined;
    return repo ? `github:repo:${repo.fullName}` : `github:review:${review?.id}`;
  }
  const url = normalizeUrl(chooseLink(c.item));
  if (url && !/^(calendar\.google\.com|mail\.google\.com|google\.com\/alerts)/.test(url)) return `url:${url}`;
  return `item:${issuerOf(c.item) ?? 'unknown'}|${normalizeTitle(c.item.title)}|${isoDay(c.item.date) ?? 'undated'}`;
}

const STATUS_RANK: Record<Mapping['status'], number> = { rejected: 0, needs_attorney: 1, building: 2, qualifying: 3 };

function mergeGroup(key: string, group: Candidate[], deps: VerifyDeps): VerifiedItem {
  const { profile, now } = deps;
  // A trap in any member wins: the safest reading of a merged item.
  const trap = group.find((c) => c.mapping.decided_by === 'rule' && c.mapping.status === 'rejected' && c.mapping.rule_id.startsWith('T-'));
  const ranked = [...group].sort((a, b) => STATUS_RANK[b.mapping.status] - STATUS_RANK[a.mapping.status] || authority(b.item) - authority(a.item));
  const lead = trap ?? ranked[0]!;
  const checks: Check[] = [];

  let m: Mapping = { ...lead.mapping };
  if (!trap) {
    const qualifying = group.filter((c) => c.mapping.status === lead.mapping.status);
    // Keep rule order: the first criterion is the exhibit's filing folder (#5 before its comparable #3).
    const criteria = uniq(qualifying.flatMap((c) => c.mapping.criteria));
    m = {
      ...m,
      criteria,
      eb1a_criteria: uniq([...qualifying.flatMap((c) => c.mapping.eb1a_criteria), ...criteria.map((c) => O1_TO_EB1[c])]),
      comparable_for: uniq(qualifying.flatMap((c) => c.mapping.comparable_for)),
    };
  }

  const primary = [...group].sort((a, b) => authority(b.item) - authority(a.item))[0]!.item;
  const dated = group.map((c) => c.item.date).filter((d): d is string => !!d).sort();
  const eventDate = dated[0] ?? null;
  const issuer = issuerOf(primary);
  const allText = group.map((c) => `${c.item.title}\n${c.item.text}`).join('\n');

  const downgrade = (rule: string, why: string) => {
    if (m.status === 'rejected' && m.eb1a_status === 'rejected') return;
    m = { ...m, status: m.status === 'rejected' ? 'rejected' : 'needs_attorney', eb1a_status: m.eb1a_status === 'rejected' ? 'rejected' : 'needs_attorney', rule_id: rule, reason: `${why} Originally: ${m.reason}` };
  };

  checks.push({ name: 'original_date', pass: !!eventDate, detail: eventDate ? `from ${primary.app} source metadata${primary.meta.forwarded ? ' (forward unwrapped)' : ''}` : 'no source date' });
  if (!eventDate) downgrade('V-no-source-date', 'No date anywhere in the source.');

  checks.push({ name: 'issuer', pass: !!issuer, detail: issuer ?? 'unknown issuer' });
  if (!issuer && m.status === 'qualifying') downgrade('V-issuer-unknown', 'The issuer could not be read from the domain.');

  const nonEnglish = looksNonEnglish(allText);
  checks.push({ name: 'language', pass: !nonEnglish, detail: nonEnglish ? 'not English; kept for the attorney' : 'English' });
  if (nonEnglish) downgrade('V-non-english', 'The item is not in English.');

  checks.push({ name: 'quote', pass: group.every((c) => `${c.item.title}\n${c.item.text}`.length > 0), detail: 'exact-substring quote verified before mapping' });

  if (group.length > 1) checks.push({ name: 'cross_source_merge', pass: true, detail: `${group.length} sources merged by ${key.startsWith('url:') ? 'URL' : 'title and date'}` });

  const metrics: VerifiedItem['metrics'] = {};
  const repo = primary.meta.repo as { stars: number; forks: number; dependents: number } | undefined;
  if (repo) Object.assign(metrics, { stars: repo.stars, forks: repo.forks, dependents: repo.dependents, observed_at: isoDay(now.toISOString())! });
  const review = primary.meta.review as { repoStars: number } | undefined;
  if (review) Object.assign(metrics, { repo_stars: review.repoStars, observed_at: isoDay(now.toISOString())! });

  const people = uniqPeople(group.flatMap((c) => personOf(c.item)).filter((p) => !(p.email && profile.emails.includes(p.email))));
  const forwardedBy = primary.meta.forwardedBy as string | null | undefined;
  if (forwardedBy) {
    const fwd = parseAddress(forwardedBy);
    people.push({ name: fwd.name, email: fwd.email, domain: domainOf(fwd.email) ?? undefined });
  }

  return {
    key,
    mapping: m,
    title: primary.title,
    issuer,
    event_date: eventDate,
    url: chooseLink(primary),
    sources: uniqRefs(group.map((c) => refOf(c.item))),
    primary,
    members: group.map((c) => c.item),
    checks,
    metrics,
    highlights: uniq([profile.name, profile.company, issuer ?? '', isoDay(eventDate) ?? '', m.quote].filter((s) => s && s.length >= 3)),
    people,
  };
}

/** Prefer the issuer's own message over alerts, reposts and forwards. */
function authority(item: SourceItem): number {
  let score = 0;
  if (!item.meta.forwarded) score += 2;
  if (item.app === 'gmail') score += 1;
  if (item.url && item.author?.domain && hostMatches(domainOf(item.url) ?? '', item.author.domain)) score += 3;
  if (item.author?.domain === 'google.com') score -= 2;
  return score;
}

function uniqRefs(refs: SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    const k = `${r.app}:${r.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function uniqPeople(people: Person[]): Person[] {
  const seen = new Set<string>();
  return people.filter((p) => {
    const k = (p.email ?? p.name ?? '').toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
