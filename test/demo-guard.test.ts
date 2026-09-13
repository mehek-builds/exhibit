import { describe, expect, it } from 'vitest';
import { assertSyntheticProfile } from '../src/demo.js';
import { DARA } from '../harness/corpus.js';

// D6 (PRD decision 16): no real person's scorecard may ever appear in the demo. assertSyntheticProfile
// is the guard runDemo runs against the harness's actual profile before doing anything else.

describe('demo guard (D6: no real person in the demo)', () => {
  it('accepts the synthetic fixture founder (DARA)', () => {
    expect(() => assertSyntheticProfile(DARA)).not.toThrow();
  });

  it('refuses a profile with a real-looking email domain', () => {
    expect(() => assertSyntheticProfile({ name: DARA.name, emails: ['dara@realcompany.com'] })).toThrow(/refused/i);
  });

  it('refuses a profile whose name does not match the corpus founder, even with a .example email', () => {
    expect(() => assertSyntheticProfile({ name: 'Someone Else', emails: ['someone@realcompany.example'] })).toThrow(/refused/i);
  });

  it('refuses a profile with no emails', () => {
    expect(() => assertSyntheticProfile({ name: DARA.name, emails: [] })).toThrow(/refused/i);
  });

  it('refuses when only some emails are .example', () => {
    expect(() => assertSyntheticProfile({ name: DARA.name, emails: ['dara@loomwork.example', 'dara@gmail.com'] })).toThrow(/refused/i);
  });
});
