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

export const GOOGLE_SCOPES: ScopeInfo[] = [
  { scope: 'https://www.googleapis.com/auth/gmail.readonly', label: 'Gmail (read)', plain: 'Read your inbox and sent mail to find evidence. Never reads spam or trash.' },
  { scope: 'https://www.googleapis.com/auth/gmail.send', label: 'Gmail (send, approved only)', plain: 'Send an email, but only one you approved first: a letter request, a digest to yourself, or an export to an attorney you named.' },
  { scope: 'https://www.googleapis.com/auth/calendar.readonly', label: 'Calendar (read)', plain: 'Read past events to find judging and speaking engagements. Never creates or changes events.' },
  { scope: 'https://www.googleapis.com/auth/drive.file', label: 'Drive (files it creates)', plain: 'Create and update the private Exhibit binder folder. Never touches files it did not create.' },
];

const RecommenderSchema = z.object({
  name: z.string(),
  email: z.string(),
  relationship: z.enum(['dependent', 'independent']),
  role: z.string(),
});

const QuietHoursSchema = z.object({
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
  timeZone: z.string(),
});

export const ProfileInputSchema = z.object({
  name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  emails: z.array(z.string()).min(1),
  domain: z.string().min(1),
  company: z.string().min(1),
  githubLogins: z.array(z.string()).default([]),
  ownAccounts: z.array(z.string()).default([]),
  linkedinId: z.string().default(''),
  field: z.string().min(1),
  targetFilingDate: z.string().min(1),
  recommenderCandidates: z.array(RecommenderSchema).default([]),
  phone: z.string().optional(),
  quietHours: QuietHoursSchema.optional(),
  routes: z.array(z.enum(['O-1A', 'EB-1A'])).optional(),
  scanSince: z.string().optional(),
  coauthors: z.array(z.string()).optional(),
  translationOptIn: z.array(z.string()).optional(),
  jobTitle: z.string().optional(),
  socCode: z.string().optional(),
  controlledEmails: z.array(z.string()).optional(),
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
