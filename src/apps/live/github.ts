import { Octokit } from '@octokit/rest';
import type { GithubApi, GithubRepo, GithubReview } from '../types.js';

// Live GitHub adapter (PRD 6.1, 6.11, 7.5): third-party stars and forks for #5, comparable
// reviews for #4. `dependents` is always 0 here: the REST API has no dependents count. The
// Corroborator's registry mirror (ecosyste.ms / libraries.io, PRD 6.11) is the source for that
// figure, researched separately and never guessed here.

export interface GithubApiOptions {
  token?: string;
  /** Arga twin base URL override. */
  baseUrl?: string;
}

const STARGAZER_CAP = 2000;
const REVIEW_SEARCH_CAP = 100;

async function paginate<T>(fn: (page: number) => Promise<{ data: T[] }>, cap: number): Promise<T[]> {
  const out: T[] = [];
  let page = 1;
  for (;;) {
    const res = await fn(page);
    out.push(...res.data);
    if (res.data.length === 0 || out.length >= cap) break;
    page += 1;
  }
  return out.slice(0, cap);
}

export function createGithubApi(opts: GithubApiOptions): GithubApi {
  const octokit = new Octokit({ auth: opts.token, baseUrl: opts.baseUrl });

  async function reposFor(login: string) {
    try {
      return await paginate((page) => octokit.repos.listForOrg({ org: login, type: 'public', per_page: 100, page }), 1000);
    } catch {
      return await paginate((page) => octokit.repos.listForUser({ username: login, type: 'owner', per_page: 100, page }), 1000);
    }
  }

  async function releaseCount(owner: string, repo: string): Promise<number> {
    const releases = await paginate((page) => octokit.repos.listReleases({ owner, repo, per_page: 100, page }), 500);
    return releases.length;
  }

  interface StarUser {
    login?: string;
  }
  interface StarWrapper {
    user?: StarUser | null;
  }

  async function stargazerLogins(owner: string, repo: string): Promise<string[]> {
    // With no `Accept: application/vnd.github.star+json` header, the API returns plain user objects;
    // typed defensively for the starred_at-wrapped shape too, since Octokit's type covers both.
    const stargazers = await paginate<StarUser | StarWrapper>(
      (page) => octokit.activity.listStargazersForRepo({ owner, repo, per_page: 100, page }) as unknown as Promise<{ data: (StarUser | StarWrapper)[] }>,
      STARGAZER_CAP,
    );
    return stargazers.map((s) => ('login' in s ? (s as StarUser).login : (s as StarWrapper).user?.login)).filter((l): l is string => !!l);
  }

  return {
    async listReposFor(login) {
      const repos = await reposFor(login);
      const out: GithubRepo[] = [];
      for (const r of repos) {
        const owner = r.owner?.login ?? login;
        const [releases, stargazers] = await Promise.all([releaseCount(owner, r.name), stargazerLogins(owner, r.name)]);
        out.push({
          fullName: r.full_name,
          owner,
          name: r.name,
          description: r.description ?? '',
          stars: r.stargazers_count ?? 0,
          forks: r.forks_count ?? 0,
          // No REST endpoint for dependents; the Corroborator fills this from ecosyste.ms / libraries.io (PRD 6.11).
          dependents: 0,
          stargazers,
          createdAt: r.created_at ?? '',
          pushedAt: r.pushed_at ?? '',
          archived: r.archived ?? false,
          releases,
          htmlUrl: r.html_url,
        });
      }
      return out;
    },

    async listReviewsBy(login) {
      const search = await octokit.search.issuesAndPullRequests({
        q: `type:pr reviewed-by:${login} -author:${login}`,
        per_page: REVIEW_SEARCH_CAP,
      });
      const repoStarsCache = new Map<string, number>();
      const out: GithubReview[] = [];
      for (const item of search.data.items.slice(0, REVIEW_SEARCH_CAP)) {
        const m = item.repository_url.match(/repos\/([^/]+)\/([^/]+)$/);
        if (!m) continue;
        const [, owner, repo] = m as unknown as [string, string, string];
        const key = `${owner}/${repo}`;
        let stars = repoStarsCache.get(key);
        if (stars === undefined) {
          const repoInfo = await octokit.repos.get({ owner, repo });
          stars = repoInfo.data.stargazers_count ?? 0;
          repoStarsCache.set(key, stars);
        }
        const reviews = await paginate((page) => octokit.pulls.listReviews({ owner, repo, pull_number: item.number, per_page: 100, page }), 100);
        for (const rev of reviews) {
          if (rev.user?.login !== login) continue;
          out.push({
            id: String(rev.id),
            repoFullName: key,
            repoOwner: owner,
            repoStars: stars,
            prNumber: item.number,
            prTitle: item.title,
            state: (rev.state as GithubReview['state']) ?? 'COMMENTED',
            submittedAt: rev.submitted_at ?? '',
            htmlUrl: rev.html_url,
            body: rev.body ?? '',
          });
        }
      }
      return out;
    },
  };
}
