import { describe, expect, it } from 'vitest';
import { prefilter } from '../src/pipeline/prefilter.js';
import { classifyCalendar, classifyRepo, classifyReview, classifyStructured, thirdPartyStars } from '../src/rules/structured.js';
import type { CalendarEvent, GithubRepo, GithubReview } from '../src/apps/types.js';
import type { SourceItem } from '../src/types.js';
import { item, PROFILE } from './helpers.js';

const NOW = new Date('2026-09-13T12:00:00Z');

function calendarItem(ev: CalendarEvent): SourceItem {
  return item({
    app: 'calendar',
    id: ev.id,
    date: ev.start,
    title: ev.summary,
    text: `Event: ${ev.summary}\nStatus: ${ev.status}`,
    meta: { event: ev },
  });
}

function ev(p: Partial<CalendarEvent> & { id: string; summary: string; attendees: CalendarEvent['attendees'] }): CalendarEvent {
  return {
    description: '',
    start: '2026-01-01T10:00:00Z',
    end: '2026-01-01T12:00:00Z',
    status: 'confirmed',
    updated: '2026-01-01T10:00:00Z',
    organizer: { email: 'organizer@judgeorg.example' },
    ...p,
  };
}

const OWNER = PROFILE.emails[0]!;

describe('calendar-event judge classifier', () => {
  it('accepted + event occurred maps to C4-service-proof (qualifying)', () => {
    const e = ev({ id: 'ev1', summary: 'Judge: Spring Build Night', end: '2026-01-01T12:00:00Z', attendees: [{ email: OWNER, responseStatus: 'accepted', self: true }] });
    const { cls, mapping } = classifyCalendar(calendarItem(e), PROFILE, NOW);
    expect(cls.is_candidate).toBe(true);
    expect(mapping!.rule_id).toBe('C4-service-proof');
    expect(mapping!.status).toBe('qualifying');
    expect(mapping!.criteria).toEqual([4]);
  });

  it('declined maps to T-invite-declined (rejected)', () => {
    const e = ev({ id: 'ev2', summary: 'Judge: DevJam', end: '2026-01-01T12:00:00Z', attendees: [{ email: OWNER, responseStatus: 'declined', self: true }] });
    const { mapping } = classifyCalendar(calendarItem(e), PROFILE, NOW);
    expect(mapping!.rule_id).toBe('T-invite-declined');
    expect(mapping!.status).toBe('rejected');
  });

  it('cancelled maps to C4-event-cancelled (E6): stays building', () => {
    const e = ev({ id: 'ev3', summary: 'Judge: Spring Build Night', status: 'cancelled', end: '2026-01-01T12:00:00Z', attendees: [{ email: OWNER, responseStatus: 'accepted', self: true }] });
    const { mapping } = classifyCalendar(calendarItem(e), PROFILE, NOW);
    expect(mapping!.rule_id).toBe('C4-event-cancelled');
    expect(mapping!.status).toBe('building');
  });

  it('"mentor" role maps to T-mentor-not-judge (not judging)', () => {
    const e = ev({ id: 'ev4', summary: 'Mentor office hours', end: '2026-01-01T12:00:00Z', attendees: [{ email: OWNER, responseStatus: 'accepted', self: true }] });
    const { mapping } = classifyCalendar(calendarItem(e), PROFILE, NOW);
    expect(mapping!.rule_id).toBe('T-mentor-not-judge');
    expect(mapping!.status).toBe('rejected');
  });

  it('a major-conference talk maps to D-talk-comparable (E33)', () => {
    const e = ev({
      id: 'ev5',
      summary: 'Speaker: DevConf 2026 keynote',
      end: '2026-01-01T12:00:00Z',
      attendees: [{ email: OWNER, responseStatus: 'accepted', self: true }],
      description: 'Keynote at the DevConf 2026 conference.',
    });
    const { mapping } = classifyCalendar(calendarItem(e), PROFILE, NOW);
    expect(mapping!.rule_id).toBe('D-talk-comparable');
    expect(mapping!.status).toBe('qualifying');
    expect(mapping!.comparable_for).toEqual([6]);
  });

  it('a minor/local talk needs_attorney', () => {
    const e = ev({ id: 'ev6', summary: 'Talk at the local meetup', end: '2026-01-01T12:00:00Z', attendees: [{ email: OWNER, responseStatus: 'accepted', self: true }] });
    const { mapping } = classifyCalendar(calendarItem(e), PROFILE, NOW);
    expect(mapping!.rule_id).toBe('C6-talk-not-major');
    expect(mapping!.status).toBe('needs_attorney');
  });
});

describe('calendar hold with no attendees (E1) is handled upstream by prefilter, not structured rules', () => {
  it('prefilter drops a calendar hold with zero attendees', () => {
    const e = ev({ id: 'ev-hold', summary: 'Focus time', attendees: [] });
    const reason = prefilter(calendarItem(e), PROFILE);
    expect(reason).toBe('calendar hold with no attendees');
  });

  it('structured classifier is never reached for a dropped hold (verified via the mapper entry point ordering: prefilter runs first)', () => {
    // classifyStructured itself does not know about "no attendees" -- that is deliberately the
    // prefilter's job. Confirm classifyStructured would otherwise treat it as a routine event.
    const e = ev({ id: 'ev-hold2', summary: 'Focus time', attendees: [] });
    const { cls } = classifyCalendar(calendarItem(e), PROFILE, NOW);
    expect(cls.is_candidate).toBe(false);
    expect(cls.reason).toBe('routine calendar event');
  });
});

describe('GitHub repo classifier', () => {
  const baseRepo: GithubRepo = {
    fullName: 'dvoss/thing',
    owner: 'dvoss',
    name: 'thing',
    description: 'A thing',
    stars: 0,
    forks: 0,
    dependents: 0,
    stargazers: [],
    createdAt: '2026-01-01T00:00:00Z',
    pushedAt: '2026-02-01T00:00:00Z',
    archived: false,
    releases: 0,
    htmlUrl: 'https://github.com/dvoss/thing',
  };

  function repoItemFor(repo: GithubRepo): SourceItem {
    return item({ app: 'github', id: `${repo.fullName}@2026-09-13`, title: repo.fullName, text: `Repository: ${repo.htmlUrl}\nStars: ${repo.stars}`, meta: { repo } });
  }

  it('a repo starred mostly by the founder\'s own accounts is excluded and stays building (E13)', () => {
    const repo: GithubRepo = { ...baseRepo, stars: 10, stargazers: ['dvoss', 'dvoss-alt', 'dvoss-bot', 'someone-else'] };
    const third = thirdPartyStars(repo, PROFILE);
    expect(third).toBe(7); // 10 - 3 own accounts listed
    const { mapping } = classifyRepo(repoItemFor(repo), PROFILE);
    expect(mapping!.status).toBe('building');
  });

  it('own-star-dominant repo (over half stars are the founder\'s own, still below threshold) uses T-own-stars', () => {
    const repo: GithubRepo = { ...baseRepo, stars: 4, stargazers: ['dvoss', 'dvoss-alt', 'dvoss-bot'] };
    const { mapping } = classifyRepo(repoItemFor(repo), PROFILE);
    expect(mapping!.rule_id).toBe('T-own-stars');
    expect(mapping!.status).toBe('building');
  });

  it('adoption over the threshold qualifies under #5 and comparable #3', () => {
    const repo: GithubRepo = { ...baseRepo, stars: 200, dependents: 20, stargazers: [] };
    const { mapping } = classifyRepo(repoItemFor(repo), PROFILE);
    expect(mapping!.status).toBe('qualifying');
    expect(mapping!.criteria.sort()).toEqual([3, 5]);
    expect(mapping!.comparable_for).toEqual([3]);
  });
});

describe('GitHub code review classifier', () => {
  const baseReview: GithubReview = {
    id: 'r1',
    repoFullName: 'orbit-ci/orbit',
    repoOwner: 'orbit-ci',
    repoStars: 4800,
    prNumber: 1,
    prTitle: 'Fix',
    state: 'CHANGES_REQUESTED',
    submittedAt: '2026-05-02T16:00:00Z',
    htmlUrl: 'https://github.com/orbit-ci/orbit/pull/1',
    body: 'Reviewed.',
  };

  function reviewItemFor(review: GithubReview): SourceItem {
    return item({ app: 'github', id: `review:${review.id}`, title: `Review on ${review.repoFullName}`, text: `Repository: https://github.com/${review.repoFullName} (${review.repoStars} stars)`, meta: { review } });
  }

  it('a code review comment on a popular/external repo counts (E34)', () => {
    const { mapping } = classifyReview(reviewItemFor(baseReview), PROFILE);
    expect(mapping!.status).toBe('qualifying');
    expect(mapping!.rule_id).toBe('D-code-review-comparable');
    expect(mapping!.comparable_for).toEqual([4]);
  });

  it('a review comment on the founder\'s own repo does not count', () => {
    const review: GithubReview = { ...baseReview, repoFullName: 'loomwork/flakehound', repoOwner: 'loomwork' };
    const { cls, mapping } = classifyStructured(reviewItemFor(review), PROFILE, NOW)!;
    expect(cls.is_candidate).toBe(false);
    expect(mapping).toBeNull();
  });

  it('a review on a small/unpopular repo stays building, below threshold', () => {
    const review: GithubReview = { ...baseReview, repoStars: 10 };
    const { mapping } = classifyReview(reviewItemFor(review), PROFILE);
    expect(mapping!.status).toBe('building');
    expect(mapping!.rule_id).toBe('C4-review-below-threshold');
  });
});
