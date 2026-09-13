import { z } from 'zod';
import type { FounderProfile } from '../types.js';

// First-run profile setup (PRD 4.1). `GOOGLE_SCOPES` backs the plain-words consent list on
// web/setup.html; `validateProfile` is the same check the CLI/live config uses (src/config.ts),
// with the notifier's defaults (quiet hours, scan-since, routes) filled in here so a profile pasted
// from the setup page always satisfies FounderProfile without the founder having to know the defaults.

export interface ScopeInfo {
  scope: string;
  label: string;
  plain: string;
}

// PRD 4.1 step 1: "Connect Google with minimal scopes: Gmail and Calendar read-only; Drive
// limited to files Exhibit creates." Gmail send is not one of the scopes requested at setup. It is
// a separate grant (SEND_SCOPE below); there is no in-app prompt for it yet. Until it is granted,
// every send fails safely: the run marks Gmail degraded and nothing leaves (src/letters/letters.ts).
export const GOOGLE_SCOPES: ScopeInfo[] = [
  { scope: 'https://www.googleapis.com/auth/gmail.readonly', label: 'Gmail (read)', plain: 'Read your inbox and sent mail to find evidence. Never reads spam or trash.' },
  { scope: 'https://www.googleapis.com/auth/calendar.readonly', label: 'Calendar (read)', plain: 'Read past events to find judging and speaking engagements. Never creates or changes events.' },
  { scope: 'https://www.googleapis.com/auth/drive.file', label: 'Drive (files it creates)', plain: 'Create and update the private Exhibit binder folder. Never touches files it did not create.' },
];

/** A separate grant, not requested at setup. Without it no email can be sent at all. */
export const SEND_SCOPE: ScopeInfo = {
  scope: 'https://www.googleapis.com/auth/gmail.send',
  label: 'Gmail (send, approved only)',
  plain: 'Send an email, but only one you approved first: a letter request you replied APPROVE to, or a digest and approval request to yourself. Never to an attorney or a government address.',
};

const RecommenderSchema = z.object({
  name: z.string(),
  email: z.email(),
  relationship: z.enum(['dependent', 'independent']),
  role: z.string(),
});

function isClockTime(value: string): boolean {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  return !!match && Number(match[1]) < 24 && Number(match[2]) < 60;
}

function isIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const QuietHoursSchema = z.object({
  start: z.string().refine(isClockTime, 'must be a valid HH:MM time'),
  end: z.string().refine(isClockTime, 'must be a valid HH:MM time'),
  timeZone: z.string().refine(isIanaTimeZone, 'must be a valid IANA time zone'),
});

export const ProfileInputSchema = z.object({
  name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  emails: z.array(z.email()).min(1),
  domain: z.string().min(1),
  company: z.string().min(1),
  githubLogins: z.array(z.string()).default([]),
  ownAccounts: z.array(z.string()).default([]),
  linkedinId: z.string().default(''),
  field: z.string().min(1),
  targetFilingDate: z.string().refine(isIsoDate, 'must be a valid YYYY-MM-DD date'),
  recommenderCandidates: z.array(RecommenderSchema).default([]),
  phone: z.string().regex(/^\+[1-9]\d{6,14}$/, 'must be in E.164 format').optional(),
  quietHours: QuietHoursSchema.optional(),
  routes: z.array(z.enum(['O-1A', 'EB-1A'])).min(1).optional(),
  scanSince: z.string().refine(isIsoDate, 'must be a valid YYYY-MM-DD date').optional(),
  coauthors: z.array(z.string()).optional(),
  translationOptIn: z.array(z.string()).optional(),
  jobTitle: z.string().optional(),
  socCode: z.string().optional(),
  controlledEmails: z.array(z.email()).optional(),
});

export type ProfileValidationResult = { ok: true; profile: FounderProfile } | { ok: false; error: string };

/** Parses and applies the 4.1 defaults: quiet hours 22:00-08:00 (founder's own time zone if given, else Pacific), scan-since 2023-01-01, both routes. */
export function validateProfile(json: unknown): ProfileValidationResult {
  const result = ProfileInputSchema.safeParse(json);
  if (!result.success) return { ok: false, error: result.error.message };
  const p = result.data;
  const profile: FounderProfile = {
    name: p.name,
    aliases: p.aliases,
    emails: p.emails,
    domain: p.domain,
    company: p.company,
    githubLogins: p.githubLogins,
    ownAccounts: p.ownAccounts,
    linkedinId: p.linkedinId,
    field: p.field,
    targetFilingDate: p.targetFilingDate,
    recommenderCandidates: p.recommenderCandidates,
    phone: p.phone,
    quietHours: p.quietHours ?? { start: '22:00', end: '08:00', timeZone: 'America/Los_Angeles' },
    routes: p.routes ?? ['O-1A', 'EB-1A'],
    scanSince: p.scanSince ?? '2023-01-01',
    coauthors: p.coauthors,
    translationOptIn: p.translationOptIn,
    jobTitle: p.jobTitle,
    socCode: p.socCode,
    controlledEmails: p.controlledEmails,
  };
  return { ok: true, profile };
}
