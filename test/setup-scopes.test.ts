import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { GOOGLE_SCOPES, SEND_SCOPE } from '../src/setup/profile.js';

// PRD 4.1 step 1: "Connect Google with minimal scopes: Gmail and Calendar read-only; Drive
// limited to files Exhibit creates." Gmail send is not among the scopes requested at setup --
// it is a separate, later consent (7.5's "read-only everywhere except Gmail send" describes the
// steady-state token, not what's asked for up front). PRD 4.1 item 4 also has the founder join
// the Twilio WhatsApp Sandbox with a join code that confirms her number.

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'web', 'setup.html'), 'utf8');

describe('setup scopes (PRD 4.1)', () => {
  it('requests only read-only Gmail/Calendar and drive.file at setup -- never gmail.send', () => {
    expect(GOOGLE_SCOPES.map((s) => s.scope)).toEqual([
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/drive.file',
    ]);
    expect(GOOGLE_SCOPES.some((s) => s.scope.includes('gmail.send'))).toBe(false);
  });

  it('defines gmail.send as a separate scope, not part of the initial connect list', () => {
    expect(SEND_SCOPE.scope).toBe('https://www.googleapis.com/auth/gmail.send');
    expect(GOOGLE_SCOPES).not.toContainEqual(SEND_SCOPE);
  });

  it('the setup page never lists gmail.send among the scopes it requests up front', () => {
    const scriptMatch = html.match(/var scopes = (\[[\s\S]*?\]);/);
    expect(scriptMatch).not.toBeNull();
    // eslint-disable-next-line no-eval
    const pageScopes = eval(scriptMatch![1]!) as { label: string }[];
    expect(pageScopes.some((s) => /send/i.test(s.label))).toBe(false);
    expect(pageScopes.map((s) => s.label)).toEqual(GOOGLE_SCOPES.map((s) => s.label));
  });

  it('explains that send is requested separately, later', () => {
    expect(html).toMatch(/Gmail send is not requested here/i);
  });

  it('has the WhatsApp Sandbox join-code step confirming the founder\'s number', () => {
    expect(html).toMatch(/WhatsApp Sandbox/i);
    expect(html).toMatch(/join code/i);
    expect(html).toMatch(/confirms this is your number/i);
  });
});
