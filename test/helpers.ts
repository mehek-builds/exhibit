import type { Classification, EvidenceKind, FounderProfile, RedactedItem, SourceApp, SourceItem } from '../src/types.js';

// Shared builders for the unit-test suite. Kept deliberately small: most fixtures live in
// harness/corpus.ts (Dara Voss, the synthetic founder) and are reused directly by tests that need
// a realistic corpus; this file only adds the bare-metal constructors unit tests need.

export const PROFILE: FounderProfile = {
  name: 'Dara Voss',
  aliases: ['Dara', 'D. Voss'],
  emails: ['dara@loomwork.example'],
  domain: 'loomwork.example',
  company: 'Loomwork',
  githubLogins: ['dvoss', 'loomwork'],
  ownAccounts: ['dvoss', 'dvoss-alt', 'dvoss-bot'],
  linkedinId: 'dara-voss',
  field: 'software engineering (developer tooling and AI infrastructure)',
  targetFilingDate: '2027-03-31',
  recommenderCandidates: [
    { name: 'Priya Raman', email: 'priya@buildnight.example', relationship: 'independent', role: 'Program Director, Build Night' },
    { name: 'Sam Ortiz', email: 'sam@forgeaccel.example', relationship: 'dependent', role: 'Partner, Forge Accelerator' },
  ],
};

export function item(p: Partial<SourceItem> & { app: SourceApp; id: string }): SourceItem {
  return {
    threadId: p.id,
    date: '2026-03-18T14:00:00.000Z',
    receivedAt: null,
    title: 'A test item',
    text: 'Body text of the test item.',
    author: { name: 'Some Sender', email: 'sender@example.test', domain: 'example.test' },
    recipients: [PROFILE.emails[0]!],
    url: null,
    links: [],
    meta: {},
    raw: 'raw content',
    rawType: 'eml',
    ...p,
  };
}

export function redacted(p: Partial<RedactedItem> & { app: SourceApp; id: string }): RedactedItem {
  const full = item(p as Partial<SourceItem> & { app: SourceApp; id: string });
  const { raw: _raw, ...rest } = full;
  return { ...rest, redactions: [], ...p };
}

export function cls(p: Partial<Classification> & { kind: EvidenceKind }): Classification {
  return { is_candidate: true, quote: '', decided_by: 'model', ...p };
}
