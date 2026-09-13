import type { DiscoveredItem, DiscoveryAdapter, DiscoveryQuery, DiscoveryResult, HttpTransport, IntegrationInfo } from './types.js';

// OpenReview discovery adapter (PRD 6.14: "Her own account data, read with her credentials").
// Authenticates as the founder herself via POST /login, then reads her reviewer / area-chair
// assignments per venue as OpenReview Edges, and derives accepted/declined/pending status from
// her group memberships. Venue submission/decision data for the #6 acceptance-rate figures is
// out of scope here — that belongs to the Corroborator's verifier path, not this discovery
// adapter (6.14: "venue submissions and decisions for acceptance rates" is a separate job).
// Declined assignments are normalized to status 'declined' (E62): not judging, `building` at
// most per discovery.json's C4-review-assignment-declined.
//
// There is no `GET /profile/assignments` endpoint in API v2 — that was an earlier, unconfirmed
// guess this file made and it was wrong (docs review, 2026-09-13). Assignments live as Edges:
// `GET /edges?invitation=<venue>/Reviewers/-/Assignment&tail=<profile id>` (and
// `.../Area_Chairs/-/Assignment` for area chairs). Accept/decline status is not on the edge; it
// comes from group membership (`<venue>/Reviewers` vs `<venue>/Reviewers/Declined`), read via
// `GET /groups?member=<profile id>`.
//
// UNCONFIRMED against https://docs.openreview.net/reference/api-v2 — verify before relying on
// these in production:
//   - The exact assignment-edge invitation id shape (`<venue>/Reviewers/-/Assignment`) and
//     whether `head`/`tail` orientation is paper-then-reviewer for every venue's edge builder.
//   - The declined-group naming convention (`<venue>/Reviewers/Declined`); some venues may use a
//     `Recruitment` invitation with `Decline`/`Accept` responses instead of a Declined group.
//   - Whether venues must be supplied explicitly (as here) or can be discovered from
//     `GET /groups?member=<profile id>` by pattern-matching group ids that end in
//     `/Reviewers` or `/Area_Chairs`.

const DEFAULT_BASE_URL = 'https://api2.openreview.net';
const RESULT_CAP = 100;

type OrRole = 'reviewer' | 'area_chair';

interface OrEdge {
  id: string;
  head?: string;
  tail?: string;
  invitation?: string;
  /** Edge creation time, ms since epoch. UNCONFIRMED field name — assumed `cdate` per API v2 convention. */
  cdate?: number;
}

interface OrEdgesResponse {
  edges?: OrEdge[];
}

interface OrGroup {
  id: string;
}

interface OrGroupsResponse {
  groups?: OrGroup[];
}

export interface OpenReviewAdapterOptions {
  transport: HttpTransport;
  /** Founder's own OpenReview credentials (6.14: "Her OpenReview login"). Never logged. */
  username: string;
  password: string;
  /**
   * Founder's OpenReview profile id, e.g. `~Dara_Voss1`. Required at runtime: assignment edges
   * are queried by tail=profileId. Optional in the type only so config wiring that has not yet
   * collected it does not fail to build; `discover()` reports it as an error instead of guessing.
   */
  profileId?: string;
  /**
   * Venue ids to check, e.g. `NeurIPS.cc/2025/Workshop/Reliable_ML`. There is no single endpoint
   * that lists "all venues this profile is involved with" that this adapter could confirm, so the
   * caller supplies them explicitly. Defaults to `[]` (no venues checked, no items) when omitted.
   * UNCONFIRMED: whether `GET /groups?member=<profileId>` could instead be mined for venue ids by
   * pattern-matching `.../Reviewers` and `.../Area_Chairs` suffixes — see the header note above.
   */
  venues?: string[];
  baseUrl?: string;
}

function roleGroupSuffix(role: OrRole): string {
  return role === 'area_chair' ? 'Area_Chairs' : 'Reviewers';
}

function roleLabel(role: OrRole): string {
  return role === 'area_chair' ? 'Area Chair' : 'Reviewer';
}

export function createOpenReviewAdapter(opts: OpenReviewAdapterOptions): DiscoveryAdapter {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const { transport } = opts;

  const info: IntegrationInfo = {
    id: 'openreview',
    name: 'OpenReview',
    job: ['discover'],
    tier: 2,
    criteria: '#4 (acceptance-rate figures for #6 are out of scope here)',
    freeTier: 'Free',
    credentials: ['Her OpenReview login', 'Her OpenReview profile id', 'Venue ids to check'],
    receives: "Her own account data, read with her credentials",
  };

  async function login(): Promise<string> {
    const res = await transport.request({
      method: 'POST',
      url: `${baseUrl}/login`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: opts.username, password: opts.password }),
    });
    if (res.status >= 400) {
      // Never echo credentials into the error message.
      throw new Error(`OpenReview login failed (status ${res.status})`);
    }
    let parsed: { token?: string };
    try {
      parsed = JSON.parse(res.body) as { token?: string };
    } catch {
      throw new Error('OpenReview login response was not valid JSON');
    }
    if (!parsed.token) throw new Error('OpenReview login response missing token');
    return parsed.token;
  }

  return {
    info,
    async discover(_q: DiscoveryQuery): Promise<DiscoveryResult> {
      const items: DiscoveredItem[] = [];
      const errors: string[] = [];

      if (!opts.profileId) {
        errors.push('OpenReview adapter is missing profileId (config incomplete)');
        return { items, errors };
      }
      const profileId = opts.profileId;
      const venues = opts.venues ?? [];

      let token: string;
      try {
        token = await login();
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
        return { items, errors };
      }

      const authHeaders = { authorization: `Bearer ${token}` };

      // Group membership is what tells accepted from declined; fetch it once.
      const groupsRes = await transport.request({
        method: 'GET',
        url: `${baseUrl}/groups?member=${encodeURIComponent(profileId)}`,
        headers: authHeaders,
      });
      if (groupsRes.status === 429) return { items, errors, limited: true };
      if (groupsRes.status >= 400) {
        errors.push(`OpenReview groups fetch failed (status ${groupsRes.status})`);
        return { items, errors };
      }
      let groupIds: Set<string>;
      try {
        const parsed = JSON.parse(groupsRes.body) as OrGroupsResponse;
        groupIds = new Set((parsed.groups ?? []).map((g) => g.id));
      } catch {
        errors.push('OpenReview groups response was not valid JSON');
        return { items, errors };
      }

      function status(venue: string, role: OrRole): 'accepted' | 'declined' | 'pending' {
        const suffix = roleGroupSuffix(role);
        if (groupIds.has(`${venue}/${suffix}/Declined`)) return 'declined';
        if (groupIds.has(`${venue}/${suffix}`)) return 'accepted';
        return 'pending';
      }

      venueLoop: for (const venue of venues) {
        for (const role of ['reviewer', 'area_chair'] as OrRole[]) {
          if (items.length >= RESULT_CAP) break venueLoop;

          const suffix = roleGroupSuffix(role);
          const invitation = `${venue}/${suffix}/-/Assignment`;
          const url = `${baseUrl}/edges?invitation=${encodeURIComponent(invitation)}&tail=${encodeURIComponent(profileId)}`;
          const res = await transport.request({ method: 'GET', url, headers: authHeaders });

          if (res.status === 429) {
            return { items, errors, limited: true };
          }
          if (res.status >= 400) {
            errors.push(`OpenReview edges fetch failed for ${invitation} (status ${res.status})`);
            continue;
          }

          let parsed: OrEdgesResponse;
          try {
            parsed = JSON.parse(res.body) as OrEdgesResponse;
          } catch {
            errors.push(`OpenReview edges response for ${invitation} was not valid JSON`);
            continue;
          }

          const edges = parsed.edges ?? [];
          if (edges.length === 0) continue; // no assignment at all in this venue/role

          const edge = edges[0]!;
          const st = status(venue, role);
          const label = roleLabel(role);
          const invitedAt = edge.cdate ? new Date(edge.cdate).toISOString() : null;

          items.push({
            source: 'openreview',
            externalId: edge.id,
            kind: 'review_assignment',
            url: `https://openreview.net/group?id=${encodeURIComponent(venue)}`,
            title: `${label} — ${venue}`,
            text: `${label} assignment for ${venue}, status: ${st}`,
            publishedAt: invitedAt,
            meta: { role, venue, status: st },
            raw: JSON.stringify({ edge, groups: [...groupIds] }),
          });
        }
      }

      return { items, errors };
    },
  };
}
