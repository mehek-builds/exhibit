import type { DiscoveredItem, DiscoveryQuery } from '../integrations/types.js';

// Constraint 16 / E57 / E61: a discovered item becomes a candidate only if the source names the
// founder AND a second identifier (company, company domain, a handle, or a known co-author).
// A namesake with no second identifier (E57, E61) is never a candidate.

function wordBoundaryIncludes(haystack: string, needle: string): boolean {
  const n = needle.trim();
  if (!n) return false;
  const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(haystack);
}

export function secondIdentifier(item: DiscoveredItem, q: DiscoveryQuery): { names: boolean; second: string | null } {
  // Items listed under one of the founder's own accounts (queried by her handle) are identified by that
  // account; everything else must name her in the source's own text.
  const ownerHandle = item.meta.ownerHandle as string | undefined;
  if (ownerHandle && q.handles.some((h) => h.toLowerCase() === ownerHandle.toLowerCase())) {
    return { names: true, second: `own-account:${ownerHandle}` };
  }
  const text = `${item.title}\n${item.text}`;

  const names = [q.founderName, ...q.aliases].filter(Boolean).some((n) => wordBoundaryIncludes(text, n));

  if (q.company && wordBoundaryIncludes(text, q.company)) return { names, second: `company:${q.company}` };

  if (q.companyDomain) {
    const domainHit =
      (item.author?.domain && item.author.domain.toLowerCase() === q.companyDomain.toLowerCase()) ||
      item.url.toLowerCase().includes(q.companyDomain.toLowerCase()) ||
      text.toLowerCase().includes(q.companyDomain.toLowerCase());
    if (domainHit) return { names, second: `domain:${q.companyDomain}` };
  }

  for (const handle of q.handles) {
    if (!handle) continue;
    if (item.author?.handle && item.author.handle.toLowerCase() === handle.toLowerCase()) return { names, second: `handle:${handle}` };
    if (wordBoundaryIncludes(text, handle)) return { names, second: `handle:${handle}` };
  }

  for (const coauthor of q.coauthors) {
    if (coauthor && wordBoundaryIncludes(text, coauthor)) return { names, second: `coauthor:${coauthor}` };
  }

  return { names, second: null };
}
