import { execFileSync } from 'node:child_process';

// Release identifier tagged onto every run and trace (PRD 6.10, 12.6): `EXHIBIT_RELEASE` when
// set, else the repo's short git SHA, else 'dev'. Errors from a missing git binary or a non-repo
// checkout are swallowed; a release id is never load-bearing enough to fail a command over.

export function currentRelease(): string {
  if (process.env.EXHIBIT_RELEASE) return process.env.EXHIBIT_RELEASE;
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: import.meta.dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (sha) return sha;
  } catch {
    // no git, not a repo, or git not installed — fall through
  }
  return 'dev';
}
