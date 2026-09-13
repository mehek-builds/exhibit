# Lifted scenarios (PRD 12.6)

When Lemma raises an issue against a live or harness trace, the failing input is lifted into a new
Arga scenario here, so it never regresses silently. This is the Lemma-to-Arga loop: `Lemma issue ->
lifted scenario -> 3 of 3 green -> issue resolved`.

## Format

One JSON file per lifted scenario, named after its scenario id (e.g. `S19.json`):

```json
{
  "id": "S19",
  "title": "Short description of what broke",
  "sourceIssue": "Lemma issue id or URL",
  "createdAt": "2026-09-13T00:00:00Z",
  "gmail": [
    { "id": "m-example", "from": "Someone <someone@example.com>", "date": "2026-01-01T00:00:00Z", "subject": "...", "body": "..." }
  ],
  "expect": {
    "source": "gmail:m-example",
    "status": "qualifying",
    "criteria": [3],
    "never": [1]
  }
}
```

- `gmail` items are seeded verbatim (via `mail()`) alongside the usual noise mail; `to` is optional
  and defaults to the founder's address.
- `expect.source` is `app:id` of the item the grader looks up (see `scenarios.ts`'s `hasSource`).
- `expect.status` must match the candidate's O-1A status exactly.
- `expect.criteria`, if given, must set-equal the candidate's criteria.
- `expect.never`, if given, lists criteria the candidate must never be `qualifying` under.

`harness/scenarios.ts` loads every `*.json` file in this directory as an additional **core**
scenario, run with the rest of the matrix.

## The rule

An issue is resolved only when its lifted scenario passes 3 of 3 attempts and does not recur. A
lifted scenario is never deleted once an issue is closed -- it stays in the matrix as a permanent
regression check.
