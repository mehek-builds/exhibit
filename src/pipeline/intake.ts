import type { Apps, CalendarEvent, GithubRepo, GithubReview, GmailMessage, LinkedinPost } from '../apps/types.js';
import { TwinStubError } from '../apps/types.js';
import type { Ledger } from '../ledger.js';
import type { TraceContext } from '../observability/tracer.js';
import type { FounderProfile, SourceItem } from '../types.js';
import { domainOf, isoDay } from '../util.js';
import { DegradedRunError, withTwinRetry } from './resilience.js';

/** True for a real outage; a twin-stub hit or a twice-expired twin must still propagate. */
function isTwinSignal(err: unknown): boolean {
  return err instanceof TwinStubError || err instanceof DegradedRunError;
}

// Intake (PRD 6.1): read every source, unwrap forwards, dedupe by source id, and keep the
// founder's own sent mail and the calendar as context for the verifier rather than as candidates.

export interface IntakeContext {
  /** Messages the founder sent: replies to invites, approval replies. Never classified. */
  founderMessages: GmailMessage[];
  allMessages: GmailMessage[];
  calendar: CalendarEvent[];
  followers: number | null;
  degraded: string[];
}

export interface IntakeResult {
  items: SourceItem[];
  context: IntakeContext;
}

const FORWARD_MARKER = /-{5,}\s*Forwarded message\s*-{5,}/i;

export function parseLooseDate(value: string | undefined | null): string | null {
  if (!value) return null;
  const cleaned = value.replace(/\s+at\s+/i, ' ').replace(/\s+\(.*\)$/, '').trim();
  const d = new Date(cleaned);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function parseAddress(value: string): { name?: string; email?: string } {
  const m = value.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1]!.trim() || undefined, email: m[2]!.trim().toLowerCase() };
  const e = value.match(/[\w.+-]+@[\w.-]+/);
  return { email: e?.[0]?.toLowerCase() };
}

/** Pull the original sender, date and body out of a forwarded message (6.1, E2). */
export function unwrapForward(msg: GmailMessage): { from: string; date: string | null; subject: string; body: string; forwarded: boolean } {
  const idx = msg.body.search(FORWARD_MARKER);
  if (idx < 0) return { from: msg.from, date: parseLooseDate(msg.date), subject: msg.subject, body: msg.body, forwarded: false };
  const block = msg.body.slice(idx).replace(FORWARD_MARKER, '').replace(/^\s*\n/, '');
  const headerEnd = block.search(/\n\s*\n/);
  const headerText = headerEnd < 0 ? block : block.slice(0, headerEnd);
  const body = headerEnd < 0 ? '' : block.slice(headerEnd).trim();
  const header = (name: string) => headerText.match(new RegExp(`^${name}:\\s*(.+)$`, 'mi'))?.[1]?.trim();
  return {
    from: header('From') ?? msg.from,
    date: parseLooseDate(header('Date')),
    subject: header('Subject') ?? msg.subject.replace(/^fwd?:\s*/i, ''),
    body,
    forwarded: true,
  };
}

const URL_RE = /https?:\/\/[^\s)>"']+/g;

function linksIn(text: string): string[] {
  return [...text.matchAll(URL_RE)].map((m) => m[0].replace(/[.,;]+$/, '')).filter((u) => !/unsubscribe|preferences|mailto:/i.test(u));
}

export function gmailItem(msg: GmailMessage): SourceItem {
  const un = unwrapForward(msg);
  const author = parseAddress(un.from);
  const links = linksIn(un.body);
  return {
    app: 'gmail',
    id: msg.id,
    threadId: msg.threadId,
    date: un.date,
    receivedAt: parseLooseDate(msg.date),
    title: un.subject,
    text: un.body,
    author: { ...author, domain: domainOf(author.email) ?? undefined },
    recipients: msg.to,
    url: links[0] ?? null,
    links,
    meta: { headers: msg.headers, forwarded: un.forwarded, forwardedBy: un.forwarded ? msg.from : null },
    raw: msg.raw,
    rawType: 'eml',
  };
}

export function calendarItem(ev: CalendarEvent): SourceItem {
  const lines = [
    `Event: ${ev.summary}`,
    `When: ${ev.start} to ${ev.end}`,
    ev.location ? `Where: ${ev.location}` : null,
    `Status: ${ev.status}`,
    ev.organizer ? `Organizer: ${ev.organizer.displayName ?? ''} <${ev.organizer.email}>` : null,
    `Attendees: ${ev.attendees.map((a) => `${a.email} (${a.responseStatus})`).join(', ')}`,
    ev.description,
  ].filter(Boolean);
  return {
    app: 'calendar',
    id: ev.id,
    date: parseLooseDate(ev.start),
    title: ev.summary,
    text: lines.join('\n'),
    author: ev.organizer ? { name: ev.organizer.displayName, email: ev.organizer.email, domain: domainOf(ev.organizer.email) ?? undefined } : undefined,
    url: ev.htmlLink ?? linksIn(ev.description)[0] ?? null,
    links: linksIn(ev.description),
    meta: { event: ev },
    raw: JSON.stringify(ev, null, 2),
    rawType: 'json',
  };
}

export function repoItem(repo: GithubRepo, observedDay: string, thirdParty: number): SourceItem {
  return {
    app: 'github',
    id: `${repo.fullName}@${observedDay}`,
    date: repo.createdAt,
    title: `${repo.fullName}: ${repo.description}`,
    text: [
      `Repository: ${repo.htmlUrl}`,
      `Stars: ${repo.stars} (${thirdParty} from accounts other than the founder's)`,
      `Forks: ${repo.forks}`,
      `Dependents: ${repo.dependents}`,
      `Releases: ${repo.releases}`,
      `Created: ${repo.createdAt}; last push: ${repo.pushedAt}`,
    ].join('\n'),
    author: { handle: repo.owner, domain: 'github.com' },
    url: repo.htmlUrl,
    links: [repo.htmlUrl],
    meta: { repo, observedDay },
    raw: JSON.stringify({ ...repo, observed_on: observedDay }, null, 2),
    rawType: 'json',
  };
}

export function reviewItem(review: GithubReview): SourceItem {
  return {
    app: 'github',
    id: `review:${review.id}`,
    date: review.submittedAt,
    title: `Review on ${review.repoFullName}#${review.prNumber}: ${review.prTitle}`,
    text: [`Repository: https://github.com/${review.repoFullName} (${review.repoStars} stars)`, `Pull request: ${review.htmlUrl}`, `Review state: ${review.state}`, review.body].join('\n'),
    author: { handle: review.repoOwner, domain: 'github.com' },
    url: review.htmlUrl,
    links: [review.htmlUrl],
    meta: { review },
    raw: JSON.stringify(review, null, 2),
    rawType: 'json',
  };
}

export function linkedinItem(post: LinkedinPost): SourceItem {
  const links = linksIn(post.text);
  return {
    app: 'linkedin',
    id: post.id,
    date: parseLooseDate(post.createdAt),
    title: `${post.authorName} on LinkedIn`,
    text: post.text,
    author: { name: post.authorName, domain: post.authorDomain },
    url: post.url ?? links[0] ?? null,
    links,
    meta: { authorType: post.authorType },
    raw: JSON.stringify(post, null, 2),
    rawType: 'json',
  };
}

export interface IntakeDeps {
  apps: Apps;
  profile: FounderProfile;
  ledger: Ledger;
  trace: TraceContext;
  now: Date;
  extend: () => Promise<void>;
}

export async function intake(deps: IntakeDeps): Promise<IntakeResult> {
  const { apps, profile, ledger, trace, now } = deps;
  const own = new Set(profile.emails.map((e) => e.toLowerCase()));
  const degraded: string[] = [];
  const items: SourceItem[] = [];
  const unseen = (item: SourceItem) => ledger.itemSeen(item.app, item.id)?.stage !== 'done';
  const call = <T>(app: string, name: string, fn: () => Promise<T>) => withTwinRetry(app, name, fn, deps.extend, trace);

  let messages: GmailMessage[] = [];
  const founderMessages: GmailMessage[] = [];
  try {
    messages = await call('gmail', 'gmail.messages.list', () => apps.gmail.listMessages());
  } catch (err) {
    if (isTwinSignal(err)) throw err;
    degraded.push('gmail');
    trace.tool('gmail.messages.list', { account: 'founder' }, undefined, String(err));
  }
  for (const msg of messages) {
    const sender = parseAddress(msg.from).email ?? '';
    if (msg.labels.includes('SENT') || own.has(sender)) {
      founderMessages.push(msg);
      continue;
    }
    // PRD 6.1: spam is never read; skip anything labeled SPAM or TRASH even if a
    // source didn't already exclude it (the live Gmail list query does, but this is
    // the backstop so intake itself never admits it).
    if (msg.labels.includes('SPAM') || msg.labels.includes('TRASH')) continue;
    const item = gmailItem(msg);
    if (unseen(item)) items.push(item);
  }
  if (!degraded.includes('gmail')) trace.tool('gmail.messages.list', { account: 'founder' }, { total: messages.length, candidates: items.length, founderMessages: founderMessages.length });

  let calendar: CalendarEvent[] = [];
  try {
    calendar = await call('calendar', 'calendar.events.list', () => apps.calendar.listEvents());
  } catch (err) {
    if (isTwinSignal(err)) throw err;
    degraded.push('calendar');
    trace.tool('calendar.events.list', { calendar: 'primary' }, undefined, String(err));
  }
  let calCount = 0;
  for (const ev of calendar) {
    const ended = Date.parse(ev.end) <= now.getTime();
    // PRD 6.1: only events that ended are admitted (not future events). A cancelled
    // event that has already ended is still admitted so its cancellation can be noted
    // (PRD 9 E6); a cancelled event still in the future is not (nothing occurred yet).
    if (!ended) continue;
    const item = calendarItem(ev);
    if (unseen(item)) {
      items.push(item);
      calCount += 1;
    }
  }
  if (!degraded.includes('calendar')) trace.tool('calendar.events.list', { calendar: 'primary' }, { total: calendar.length, ended_or_cancelled_new: calCount });

  const day = isoDay(now.toISOString())!;
  const ownAccounts = new Set([...profile.ownAccounts, ...profile.githubLogins].map((a) => a.toLowerCase()));
  for (const login of profile.githubLogins) {
    try {
      const repos = await call('github', 'github.repos.list', () => apps.github.listReposFor(login));
      for (const repo of repos) {
        const third = Math.max(0, repo.stars - repo.stargazers.filter((s) => ownAccounts.has(s.toLowerCase())).length);
        const item = repoItem(repo, day, third);
        if (unseen(item)) items.push(item);
      }
      const reviews = await call('github', 'github.reviews.list', () => apps.github.listReviewsBy(login));
      for (const r of reviews) {
        const item = reviewItem(r);
        if (unseen(item)) items.push(item);
      }
      trace.tool('github.read', { login }, { repos: repos.length, reviews: reviews.length });
    } catch (err) {
      if (isTwinSignal(err)) throw err;
      degraded.push('github');
      trace.tool('github.read', { login }, undefined, String(err));
    }
  }

  let followers: number | null = null;
  if (apps.linkedin) {
    try {
      const posts = await call('linkedin', 'linkedin.mentions', () => apps.linkedin!.listMentions(profile.linkedinId));
      for (const post of posts) {
        const item = linkedinItem(post);
        if (unseen(item)) items.push(item);
      }
      followers = (await call('linkedin', 'linkedin.profile', () => apps.linkedin!.getProfile(profile.linkedinId))).followers;
      trace.tool('linkedin.read', { profile: profile.linkedinId }, { posts: posts.length });
    } catch (err) {
      if (isTwinSignal(err)) throw err;
      degraded.push('linkedin');
      trace.tool('linkedin.read', { profile: profile.linkedinId }, undefined, String(err));
    }
  } else {
    degraded.push('linkedin');
  }

  return { items, context: { founderMessages, allMessages: messages, calendar, followers, degraded } };
}
