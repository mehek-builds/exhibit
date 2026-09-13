import { describe, expect, it } from 'vitest';
import { buildLiveDeps } from '../src/config.js';

// buildLiveDeps feature wiring (PRD 6.13, 6.14): no network calls here -- adapters are only
// constructed, never invoked. Every feature must be reported {id, enabled, reason}, and never
// enabled without its own credentials (constraint: no feature enabled silently).

const BASE_PROFILE = {
  name: 'Dara Voss',
  aliases: [],
  emails: ['dara@loomwork.example'],
  domain: 'loomwork.example',
  company: 'Loomwork',
  githubLogins: ['dvoss'],
  ownAccounts: ['dvoss'],
  linkedinId: 'dara-voss',
  field: 'software engineering',
  targetFilingDate: '2027-03-31',
  recommenderCandidates: [],
};

const CORE_ENV = {
  EXHIBIT_PROFILE: JSON.stringify(BASE_PROFILE),
  GOOGLE_CLIENT_ID: 'g-client',
  GOOGLE_CLIENT_SECRET: 'g-secret',
  GOOGLE_REFRESH_TOKEN: 'g-refresh',
  GITHUB_TOKEN: 'gh-token',
  EXHIBIT_OWNER_EMAIL: 'dara@loomwork.example',
  EXHIBIT_LEDGER: ':memory:',
};

describe('buildLiveDeps: empty environment', () => {
  it('throws a helpful error naming EXHIBIT_PROFILE', async () => {
    await expect(buildLiveDeps({})).rejects.toThrow(/EXHIBIT_PROFILE/);
  });

  it('throws listing missing google/github env vars once a profile is present', async () => {
    await expect(buildLiveDeps({ EXHIBIT_PROFILE: JSON.stringify(BASE_PROFILE) })).rejects.toThrow(/GOOGLE_CLIENT_ID/);
  });
});

describe('buildLiveDeps: core only (google/github/profile, no 6.13/6.14 credentials)', () => {
  it('runs with every 6.14/6.13 feature disabled and reasons listed', async () => {
    const { deps, features, close } = await buildLiveDeps({ ...CORE_ENV });
    try {
      expect(deps.extensions).toBeDefined();
      const byId = new Map(features.map((f) => [f.id, f]));

      for (const id of ['twilio', 'text-channel', 'signing', 'translation', 'openalex', 'crossref', 'bls', 'onet', 'producthunt', 'podcastindex', 'uspto', 'openreview', 'orcid', 'edgar']) {
        const f = byId.get(id);
        expect(f, `feature ${id} missing from report`).toBeDefined();
        expect(f!.enabled).toBe(false);
        expect(f!.reason).toMatch(/^disabled:/);
      }

      // Dropbox Sign always stays in test mode by default, even if it were enabled.
      const signing = byId.get('signing')!;
      expect(signing.reason).not.toMatch(/live signatures/);

      // The USCIS client is never wired into the run.
      expect(byId.has('uscis')).toBe(false);
    } finally {
      await close();
    }
  });
});

describe('buildLiveDeps: fake credentials', () => {
  it('reports the corresponding features enabled, constructing adapters without calling them', async () => {
    const env = {
      ...CORE_ENV,
      TWILIO_ACCOUNT_SID: 'ACfake',
      TWILIO_AUTH_TOKEN: 'fake-token',
      TWILIO_SENDER: '+15005550006',
      OPENALEX_KEY: 'fake-openalex',
      CROSSREF_MAILTO: 'dara@loomwork.example',
      BLS_KEY: 'fake-bls',
      ONET_USERNAME: 'fake-user',
      ONET_PASSWORD: 'fake-pass',
      PRODUCTHUNT_TOKEN: 'fake-ph',
      PODCASTINDEX_KEY: 'fake-pikey',
      PODCASTINDEX_SECRET: 'fake-pisecret',
      USPTO_KEY: 'fake-uspto',
      OPENREVIEW_USERNAME: 'fake-or-user',
      OPENREVIEW_PASSWORD: 'fake-or-pass',
      ORCID_CLIENT_ID: 'fake-orcid-id',
      ORCID_CLIENT_SECRET: 'fake-orcid-secret',
      ORCID_ID: '0000-0002-1825-0097',
      SEC_EDGAR_USER_AGENT: 'Exhibit test contact@example.com',
      DEEPL_KEY: 'fake-deepl',
      DROPBOX_SIGN_API_KEY: 'fake-dropboxsign',
    };
    const { deps, features, close } = await buildLiveDeps(env);
    try {
      const byId = new Map(features.map((f) => [f.id, f]));

      for (const id of ['twilio', 'openalex', 'crossref', 'bls', 'onet', 'producthunt', 'podcastindex', 'uspto', 'openreview', 'orcid', 'edgar']) {
        const f = byId.get(id);
        expect(f, `feature ${id} missing`).toBeDefined();
        expect(f!.enabled, `feature ${id} should be enabled`).toBe(true);
      }

      // Dropbox Sign stays in test mode by default even with an API key set, since neither
      // DROPBOX_SIGN_TEST_MODE=0 nor EXHIBIT_ALLOW_LIVE_SIGNATURES=1 was set.
      const signing = byId.get('signing');
      if (signing?.enabled) expect(signing.reason).toMatch(/test mode/);

      expect(deps.structured).toBeDefined();
      expect(deps.apps.twilio).toBeTruthy();
    } finally {
      await close();
    }
  });

  it('never enables live Dropbox Sign signatures without both explicit flags', async () => {
    const partial = { ...CORE_ENV, DROPBOX_SIGN_API_KEY: 'fake-key', DROPBOX_SIGN_TEST_MODE: '0' };
    const { features, close } = await buildLiveDeps(partial);
    try {
      const signing = features.find((f) => f.id === 'signing');
      if (signing?.enabled) expect(signing.reason).toMatch(/test mode/);
    } finally {
      await close();
    }
  });
});
