import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { validateProfile, GOOGLE_SCOPES } from '../src/setup/profile.js';

// web/setup.html (PRD 4.1 / 6.13). No jsdom/build step is available for a static page with no
// bundler, so we extract the <script> body with a regex and run it against a minimal fake DOM in
// node:vm -- enough to exercise buildProfile()/validateForm() exactly as the browser would.

const here = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(here, '..', 'web', 'setup.html');
const html = readFileSync(htmlPath, 'utf8');

function extractScript(source: string): string {
  const match = source.match(/<script>([\s\S]*?)<\/script>/);
  if (!match?.[1]) throw new Error('no <script> block found in web/setup.html');
  return match[1];
}

interface FakeElement {
  value?: string;
  checked?: boolean;
  textContent?: string;
  hidden?: boolean;
  className?: string;
  appendChild?: (child: unknown) => void;
}

function makeFakeDocument(fieldValues: Record<string, Partial<FakeElement>>) {
  const elements: Record<string, FakeElement> = {};
  for (const [id, value] of Object.entries(fieldValues)) {
    elements[id] = { value: '', checked: false, textContent: '', hidden: false, appendChild() {}, ...value };
  }
  // Elements the page also touches that aren't form inputs.
  for (const id of ['scopes', 'formErrors', 'output', 'json']) {
    if (!elements[id]) elements[id] = { textContent: '', hidden: false, className: '', appendChild() {} };
  }
  const document = {
    getElementById(id: string) {
      if (!elements[id]) elements[id] = { value: '', checked: false, textContent: '', hidden: false, appendChild() {} };
      return elements[id];
    },
    createElement() {
      return { className: '', textContent: '', appendChild() {}, style: {} } as FakeElement;
    },
  };
  return { document, elements };
}

function runScript(fieldValues: Record<string, Partial<FakeElement>>) {
  const script = extractScript(html);
  const { document } = makeFakeDocument(fieldValues);
  const formListeners: Array<(e: { preventDefault: () => void }) => void> = [];
  const form = {
    addEventListener(_type: string, handler: (e: { preventDefault: () => void }) => void) {
      formListeners.push(handler);
    },
  };
  const sandbox: Record<string, unknown> = {
    document: {
      ...document,
      getElementById(id: string) {
        if (id === 'form') return form;
        return document.getElementById(id);
      },
    },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  return sandbox;
}

const validFields = {
  name: { value: 'Test Founder' },
  aliases: { value: '' },
  emails: { value: 'founder@example.com' },
  domain: { value: 'example.com' },
  company: { value: 'Example Inc' },
  field: { value: 'software engineering' },
  github: { value: 'octocat' },
  linkedin: { value: '' },
  target: { value: '2027-01-01' },
  scanSince: { value: '2023-01-01' },
  routeO1: { checked: true },
  routeEb1: { checked: true },
  phone: { value: '+15551234567' },
  timeZone: { value: 'America/Los_Angeles' },
  quietStart: { value: '22:00' },
  quietEnd: { value: '08:00' },
  jobTitle: { value: '' },
};

describe('web/setup.html', () => {
  it('has the required "not legal advice / nothing without you" notice', () => {
    expect(html).toContain('Not legal advice.');
    expect(html).toContain('Nothing is sent, and nothing is added to your binder, without you.');
  });

  it('lists every Google scope from src/setup/profile.ts GOOGLE_SCOPES, in plain words, verbatim', () => {
    for (const s of GOOGLE_SCOPES) {
      expect(html).toContain(s.label);
      expect(html).toContain(s.plain);
    }
    // and lists no more, no fewer: extract the in-page array literal count via the script.
    const script = extractScript(html);
    const scopesLiteralMatch = script.match(/var scopes = (\[[\s\S]*?\]);/);
    expect(scopesLiteralMatch).not.toBeNull();
    // eslint-disable-next-line no-eval
    const pageScopes = eval(scopesLiteralMatch![1]!) as { label: string; plain: string }[];
    expect(pageScopes).toEqual(GOOGLE_SCOPES.map((s) => ({ label: s.label, plain: s.plain })));
  });

  it('builds profile JSON that validateProfile accepts', () => {
    const sandbox = runScript(validFields);
    const buildProfile = sandbox.buildProfile as () => unknown;
    const profile = buildProfile();
    const result = validateProfile(profile);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.profile.name).toBe('Test Founder');
      expect(result.profile.emails).toEqual(['founder@example.com']);
      expect(result.profile.routes).toEqual(['O-1A', 'EB-1A']);
    }
  });

  it('rejects submission with no route selected', () => {
    const sandbox = runScript({ ...validFields, routeO1: { checked: false }, routeEb1: { checked: false } });
    const buildProfile = sandbox.buildProfile as () => { routes: string[] };
    const validateForm = sandbox.validateForm as (p: unknown) => string[];
    const profile = buildProfile();
    const errors = validateForm(profile);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects an email with no "@"', () => {
    const sandbox = runScript({ ...validFields, emails: { value: 'not-an-email' } });
    const buildProfile = sandbox.buildProfile as () => unknown;
    const validateForm = sandbox.validateForm as (p: unknown) => string[];
    const errors = validateForm(buildProfile());
    expect(errors.length).toBeGreaterThan(0);
  });

  it('has an aria-live region for form errors', () => {
    expect(html).toMatch(/id="formErrors"[^>]*aria-live="assertive"/);
  });

  it('binds every visible label to an input via for/id, and groups checkboxes in a fieldset/legend', () => {
    const labelFors = [...html.matchAll(/<label for="([^"]+)"/g)].map((m) => m[1]);
    for (const id of labelFors) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toMatch(/<fieldset>\s*<legend>Routes<\/legend>/);
  });

  it('loads no external scripts, stylesheets, fonts, or network resources', () => {
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=/i);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('contains no obviously real personal data (only placeholder/example values)', () => {
    expect(html).not.toMatch(/@gmail\.com|@yahoo\.com|@outlook\.com/i);
  });

  it('is responsive: collapses the two/three-column rows on narrow screens', () => {
    expect(html).toMatch(/@media \(max-width:\s*520px\)/);
  });
});
