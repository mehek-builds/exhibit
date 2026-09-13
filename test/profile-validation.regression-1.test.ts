import { describe, expect, it } from 'vitest';
import { buildLiveDeps } from '../src/config.js';
import { validateProfile } from '../src/setup/profile.js';

// Regression: ISSUE-001 - live startup stripped setup-generated profile preferences and accepted invalid time zones
// Found by /qa on 2026-09-14
// Report: .gstack/qa-reports/qa-report-localhost-2026-09-14.md

const profile = {
  name: 'Dara Voss',
  aliases: ['D. Voss'],
  emails: ['dara@example.com'],
  domain: 'example.com',
  company: 'Example',
  githubLogins: ['daravoss'],
  ownAccounts: ['dara-alt'],
  linkedinId: 'dara-voss',
  field: 'software engineering',
  targetFilingDate: '2027-01-01',
  recommenderCandidates: [],
  phone: '+15551234567',
  quietHours: { start: '21:00', end: '07:00', timeZone: 'Asia/Dubai' },
  routes: ['O-1A'] as const,
  scanSince: '2025-01-01',
  translationOptIn: ['gmail:m-fr'],
  jobTitle: 'Founder and CEO',
  socCode: '15-1252',
  controlledEmails: ['dara@example.com'],
};

describe('setup profile contract', () => {
  it('preserves every optional setup field when live dependencies are built', async () => {
    const result = await buildLiveDeps({
      EXHIBIT_PROFILE: JSON.stringify(profile),
      GOOGLE_CLIENT_ID: 'test-client',
      GOOGLE_CLIENT_SECRET: 'test-secret',
      GOOGLE_REFRESH_TOKEN: 'test-refresh',
      GITHUB_TOKEN: 'test-token',
      EXHIBIT_OWNER_EMAIL: 'dara@example.com',
      EXHIBIT_LEDGER: ':memory:',
    });
    try {
      expect(result.deps.profile).toMatchObject({
        phone: profile.phone,
        quietHours: profile.quietHours,
        routes: ['O-1A'],
        scanSince: profile.scanSince,
        translationOptIn: profile.translationOptIn,
        jobTitle: profile.jobTitle,
        socCode: profile.socCode,
        controlledEmails: profile.controlledEmails,
      });
    } finally {
      await result.close();
    }
  });

  it('rejects a profile with an invalid IANA time zone before quiet-hours code runs', () => {
    const result = validateProfile({
      ...profile,
      quietHours: { ...profile.quietHours, timeZone: 'Mars/Olympus' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/valid IANA time zone/);
  });
});
