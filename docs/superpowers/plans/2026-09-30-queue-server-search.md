# Queue + Results server-side search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The "Patient / test search" box on the lab queue (`/staff/queue?q=`) and the results archive (`/staff/results?q=`) searches the WHOLE list in the database instead of filtering only the page already fetched.

**Architecture:** Migration 0194 adds a `security_invoker` view `lab_search_rows (test_request_id, search_text)` and a PostgREST *computed relationship* `lab_search(test_requests) returns setof lab_search_rows rows 1`. While `q` has words, each page selects an extra empty embed `lab_search!inner ( )` and adds one `.ilike("lab_search.search_text", "%word%")` per word, onto the query it already runs. Every existing filter, the `count: "exact"` total and `.range()` paging stay exactly where they are.

**Tech Stack:** Next.js 16 server components, supabase-js / PostgREST 12, Postgres 17, vitest.

---

## Design (approved 2026-09-30)

### Why this shape (measured on prod, read-only, 2026-09-30)

Live lab rows on prod: 15 bench, 1 pending, 18,176 released (25.6k live `test_requests` incl. doctor lines). The results archive defaults to "All" with no dates, so every archive search scans ~18k rows.

| Approach | 2-word search over all released rows |
|---|---|
| Inline SQL expression (hand-written) | 316 ms |
| Scalar computed field `f(test_requests) returns text` (with or without `set search_path`) | **1,229–1,280 ms** — a SQL function with FROM/sub-selects is never inlined as a scalar; the per-row executor start dominates |
| **Computed relationship over a view** (`returns setof view rows 1`, LEFT JOIN LATERAL + not-null, the shape PostgREST emits) | **204 ms** — Postgres inlines a set-returning SQL function, so the planner hash-joins the view once |

Rejected: an RPC returning the whole page (re-states the section / money / deleted / doctor-kind gates in SQL beside the TS copies the tests pin → drift), and the Visit Records aliased-embed trick (`src/lib/visits/archive-search.ts`), which cannot reach `patients` two levels down nor the other members of a chemistry panel.

### What a row can be found by (unchanged from today's queue box)

Every whitespace/comma-separated word must appear (case-insensitive substring, any order — `patientSearchTokens`) in:

- patient `last_name`, `first_name`, `drm_id`
- `visits.visit_number` (substring: `37` finds `0037`, as today)
- the test's `services.code`, `services.name`
- its report group `code`, `name` (chemistry only)
- **the other live members of the same chemistry panel** (same visit + same `report_group_id`, `deleted_at is null`) **in the same tab bucket** — bench (`requested`/`in_progress`) or the same status otherwise. This keeps today's behaviour that typing one member's code (e.g. `GLU`) brings back the whole panel card, not a one-test card.

The results archive gains visit # and group/panel matching (it used to match name + DRM-ID + test code/name only). Middle name is matched too (added on review, 2026-09-30 — Visit Records already matched it).

Wildcards `\ % _ *` in a word are escaped like `archive-search.ts` (PostgREST maps every `*` to `%`, so `*` searches a literal `%`; harmless, and consistent with the sibling helper).

### What stays exactly as is

Paging by test row BEFORE the chemistry fold (panel actions still read full membership via `src/lib/queue/panel-members.ts`); `count: "exact"`; every tab, sort column, role/section gate, the money gate (`LAB_QUEUE_GATE_VISITS_OR`), doctor-kind exclusion, and both live-row filters (`deleted_at` on `test_requests` AND `visits.deleted_at` over `visits!inner`). The view repeats both live-row predicates so it can never widen anything.

### Security / ACLs

- View `with (security_invoker = on)` — base-table RLS applies to whoever reads it. Registered in `src/lib/supabase/hardened-views.test.ts`. `revoke all … from anon, authenticated`, then `grant select … to authenticated, service_role` (queue = RLS client; archive = service-role client). `supabase/seed.sql` re-revokes it from `anon` after the local blanket grant (seed parity, same as 0134/0150 views).
- Function: invoker rights, `language sql stable`, **no `set search_path`** — any SET clause blocks inlining (the whole point); every name inside is schema-qualified instead. `revoke execute … from public, anon; grant execute … to authenticated, service_role;` (inlining checks EXECUTE at plan time, so both callers need it).
- No P-codes (raises nothing). No new data is exposed: every column in `search_text` is already readable by the same roles via the existing embeds.

### UI changes

- Queue: the search is a real filter — subtitle shows `· N matching` like the other filters; the amber "The search box only looks at the {size} tests on this page" note is removed; `cardHaystack` + the post-fold `matchesAllTokens` filter are deleted (`matched` → `cards`).
- Archive: same — subtitle `· N matching`, amber note removed, `filtered` → `rows`.
- Guide: the warn box "Two search boxes only look at the page in front of you" (§2.x) is removed; §4.2 filter line and §4.10 archive describe the search; version bump.
- Skill `drmed-result-templates`: replace the "Free-text search runs after the chemistry fold" bullet; add 0194 to the migration list; mention `lab-search.ts`.

---

## File map

| File | Change |
|---|---|
| `supabase/migrations/0194_lab_search.sql` | Create — view + computed relationship + ACLs |
| `src/lib/queue/lab-search-migration.test.ts` | Create — pins the SQL text (fields, live-row predicates, bucket rule, no SET clause, ACLs) |
| `src/lib/supabase/hardened-views.test.ts` | Modify — register `lab_search_rows: "0194"` |
| `supabase/seed.sql` | Modify — re-revoke the view from anon |
| `src/types/database.ts` | Modify — ONLY the `lab_search_rows` view + `lab_search` function hunks from `npm run db:types` |
| `src/lib/queue/lab-search.ts` | Create — `labSearchPatterns`, `applyLabSearch`, `LAB_SEARCH_TEXT` |
| `src/lib/queue/lab-search.test.ts` | Create — emitted PostgREST URL via a stubbed-fetch client |
| `src/app/(staff)/staff/(dashboard)/queue/page.tsx` | Modify — search select constant + filter; delete post-fold filter + note |
| `src/app/(staff)/staff/(dashboard)/results/page.tsx` | Modify — three search select constants + filter; delete post-filter + note |
| `docs/drmed-user-guide.html` | Modify |
| `.claude/skills/drmed-result-templates/SKILL.md` | Modify |
| `CLAUDE.md` | Modify — ledger note: 0194 written, not yet on prod (then flip after push) |

---

### Task 1: Migration 0194 + pin test

**Files:** Create `supabase/migrations/0194_lab_search.sql`, `src/lib/queue/lab-search-migration.test.ts`; modify `src/lib/supabase/hardened-views.test.ts`, `supabase/seed.sql`.

- [ ] **Step 1: Write the failing pin test** `src/lib/queue/lab-search-migration.test.ts`

```ts
// Reads migration 0194 as text (no database), like
// claim-holder-guard-migration.test.ts. Pins what could silently drift:
//   (a) the searchable fields match the queue's old haystack;
//   (b) both live-row predicates, on the row AND on panel siblings;
//   (c) siblings share the row's tab bucket;
//   (d) the relationship function has NO `set` clause (a SET blocks Postgres
//       from inlining it — measured 1.2 s vs 0.2 s on prod) and is sql/stable;
//   (e) ACLs: view invoker-rights, closed to anon; function closed to
//       public/anon, open to authenticated + service_role.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(process.cwd(), "supabase/migrations/0194_lab_search.sql"),
  "utf8",
).replace(/--.*$/gm, ""); // strip comments so prose can't satisfy a pin

const view = sql.slice(
  sql.indexOf("create view public.lab_search_rows"),
  sql.indexOf("create function public.lab_search("),
);
const fn = sql.slice(
  sql.indexOf("create function public.lab_search("),
  sql.indexOf("$$;", sql.indexOf("create function public.lab_search(")),
);

describe("0194_lab_search.sql", () => {
  it("(a) searches name, DRM-ID, visit #, test and report group", () => {
    for (const field of [
      "p.last_name", "p.first_name", "p.drm_id", "v.visit_number",
      "s.code", "s.name", "rg.code", "rg.name", "s2.code", "s2.name",
    ]) {
      expect(view, field).toContain(field);
    }
  });

  it("(b) keeps only live rows, and only live panel siblings", () => {
    expect(view).toContain("tr.deleted_at is null");
    expect(view).toContain("v.deleted_at is null");
    expect(view).toContain("t2.deleted_at is null");
    expect(view).toContain("t2.id <> tr.id");
    expect(view).toContain("s2.report_group_id = s.report_group_id");
  });

  it("(c) siblings share the row's tab bucket", () => {
    expect(view).toContain(
      "(case when t2.status in ('requested', 'in_progress') then 'bench' else t2.status end)",
    );
    expect(view).toContain(
      "(case when tr.status in ('requested', 'in_progress') then 'bench' else tr.status end)",
    );
  });

  it("(d) the relationship is an inlinable sql function over the view", () => {
    expect(fn).toContain("returns setof public.lab_search_rows");
    expect(fn).toContain("rows 1");
    expect(fn).toContain("language sql");
    expect(fn).toContain("stable");
    expect(fn).not.toMatch(/\bset\s+search_path\b/);
    expect(fn).not.toContain("security definer");
    expect(fn).toContain("where r.test_request_id = $1.id");
  });

  it("(e) ACLs are restated", () => {
    expect(view).toContain("with (security_invoker = on)");
    expect(sql).toContain("revoke all on public.lab_search_rows from anon, authenticated;");
    expect(sql).toContain("grant select on public.lab_search_rows to authenticated, service_role;");
    expect(sql).toContain(
      "revoke execute on function public.lab_search(public.test_requests) from public, anon;",
    );
    expect(sql).toContain(
      "grant execute on function public.lab_search(public.test_requests) to authenticated, service_role;",
    );
  });
});
```

- [ ] **Step 2: Run it — expect FAIL (file missing)**

Run: `npx vitest run src/lib/queue/lab-search-migration.test.ts` → FAIL `ENOENT … 0194_lab_search.sql`.

- [ ] **Step 3: Write `supabase/migrations/0194_lab_search.sql`**

```sql
-- 0194_lab_search.sql — server-side free-text search for the lab queue and the
-- results archive.
--
-- Both worklists page `test_requests` rows with count: "exact" + .range(), but
-- their "Patient / test search" box filtered the page AFTER the fetch, so a
-- match on another page never showed (CLAUDE.md: a filter applied after the
-- fetch breaks server-side paging). This gives PostgREST something to filter
-- ON: each test row's searchable text, reached from `test_requests` as the
-- computed relationship `lab_search`. The pages add `lab_search!inner ( )`
-- and one `lab_search.search_text=ilike.%word%` per word
-- (src/lib/queue/lab-search.ts), so every existing gate stays in their query.
--
-- Why a view + a set-returning function, not a scalar computed field: a SQL
-- function with a FROM clause is never inlined as a scalar, and calling it per
-- row cost 1.2 s over prod's 25k rows; a set-returning SQL function IS inlined,
-- so the planner joins the view once — 0.2 s, measured 2026-09-30.
--
-- No P-codes; raises nothing.

create view public.lab_search_rows
with (security_invoker = on) as
select
  tr.id as test_request_id,
  concat_ws(' ',
    p.last_name, p.first_name, p.drm_id,
    v.visit_number,
    s.code, s.name,
    rg.code, rg.name,
    -- The other live members of the same chemistry panel on the same tab, so
    -- one member's code finds the whole panel card (the queue folds a panel
    -- into one card; before this, the search ran after that fold).
    case when s.report_group_id is not null then (
      select string_agg(concat_ws(' ', s2.code, s2.name), ' ')
      from public.test_requests t2
      join public.services s2 on s2.id = t2.service_id
      where t2.visit_id = tr.visit_id
        and s2.report_group_id = s.report_group_id
        and t2.id <> tr.id
        and t2.deleted_at is null
        and (case when t2.status in ('requested', 'in_progress') then 'bench' else t2.status end)
          = (case when tr.status in ('requested', 'in_progress') then 'bench' else tr.status end)
    ) end
  ) as search_text
from public.test_requests tr
join public.visits v on v.id = tr.visit_id
join public.patients p on p.id = v.patient_id
join public.services s on s.id = tr.service_id
left join public.report_groups rg on rg.id = s.report_group_id
-- Live rows only (0125/0146): deleting a visit does not cascade to its lines.
where tr.deleted_at is null
  and v.deleted_at is null;

comment on view public.lab_search_rows is
  'Searchable text per live test row (patient name, DRM-ID, visit #, test, report group, panel siblings). Read through the lab_search computed relationship by /staff/queue and /staff/results (0194).';

revoke all on public.lab_search_rows from anon, authenticated;
grant select on public.lab_search_rows to authenticated, service_role;

-- PostgREST computed relationship: test_requests -> lab_search_rows (to-one).
-- Deliberately NO `set search_path`: any SET clause stops Postgres inlining
-- the function, which is what makes the search fast. Every name is
-- schema-qualified instead, and it runs with invoker rights.
create function public.lab_search(public.test_requests)
returns setof public.lab_search_rows
rows 1
language sql
stable
as $$
  select r.* from public.lab_search_rows r where r.test_request_id = $1.id
$$;

comment on function public.lab_search(public.test_requests) is
  'Computed relationship for PostgREST: embed lab_search!inner ( ) and filter lab_search.search_text (0194).';

revoke execute on function public.lab_search(public.test_requests) from public, anon;
grant execute on function public.lab_search(public.test_requests) to authenticated, service_role;
```

- [ ] **Step 4: Run the pin test — expect PASS.** Then mutate once to prove it bites (delete `and t2.deleted_at is null` → (b) must fail; restore).

- [ ] **Step 5: Register the view** in `src/lib/supabase/hardened-views.test.ts` `HARDENED` (after `v_patient_dedup_candidate_pairs`):

```ts
  // 0194: the lab queue / results archive search text. Security invoker from
  // birth; registered so a later redefinition cannot drop it.
  lab_search_rows: "0194",
```

Run `npx vitest run src/lib/supabase/hardened-views.test.ts` → PASS.

- [ ] **Step 6: seed.sql parity.** After the existing `revoke all on public.v_ops_daily_expenses …` block, add:

```sql
-- 0194: the lab search view is authenticated + service_role only; the blanket
-- table grant above would hand anon SELECT back on a fresh local database.
revoke all on public.lab_search_rows from anon;
```

- [ ] **Step 7: Apply locally WITHOUT resetting the shared DB.**

```sh
LOCAL_DB_URL=$(supabase status -o env | grep '^DB_URL=' | cut -d= -f2- | tr -d '"')
/opt/homebrew/opt/libpq/bin/psql "$LOCAL_DB_URL" -c "select version from supabase_migrations.schema_migrations order by version desc limit 3"
/opt/homebrew/opt/libpq/bin/psql "$LOCAL_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/0194_lab_search.sql
/opt/homebrew/opt/libpq/bin/psql "$LOCAL_DB_URL" -c "notify pgrst, 'reload schema'"
```

Never `db reset` (other sessions share this stack). If 0194 objects already exist, stop and report.

- [ ] **Step 8: Prove inlining locally.** The plan must contain no `Function Scan on lab_search`:

```sh
/opt/homebrew/opt/libpq/bin/psql "$LOCAL_DB_URL" -c "explain select tr.id from public.test_requests tr left join lateral (select 1 as hit from public.lab_search(tr) x where x.search_text ilike '%a%') m on true where m.hit is not null"
```

- [ ] **Step 9: Types.** `npm run db:types`, then keep ONLY the hunks adding `lab_search_rows` (under `Views`) and `lab_search` (under `Functions`); `git checkout -p src/types/database.ts` away anything else (other branches' objects may be in the shared DB).

- [ ] **Step 10: Commit**

```sh
git add supabase/migrations/0194_lab_search.sql src/lib/queue/lab-search-migration.test.ts src/lib/supabase/hardened-views.test.ts supabase/seed.sql src/types/database.ts
git commit -m "feat(db): lab_search computed relationship for server-side queue/results search (0194)"
```

### Task 2: `src/lib/queue/lab-search.ts` helper

**Files:** Create `src/lib/queue/lab-search.ts`, `src/lib/queue/lab-search.test.ts`.

- [ ] **Step 1: Failing test** `src/lib/queue/lab-search.test.ts` (model: `src/lib/visits/archive-search.test.ts`)

```ts
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import type { Database } from "@/types/database";
import { applyLabSearch, labSearchPatterns, LAB_SEARCH_TEXT } from "./lab-search";

function client() {
  const requests: URL[] = [];
  const db = createClient<Database>("https://example.test", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input) => {
        requests.push(new URL(String(input)));
        return new Response("[]", {
          status: 200,
          headers: { "Content-Type": "application/json", "Content-Range": "*/0" },
        });
      },
    },
  });
  return { db, requests };
}

describe("labSearchPatterns", () => {
  it("is empty for a blank search, so the caller adds no embed or filter", () => {
    expect(labSearchPatterns(undefined)).toEqual([]);
    expect(labSearchPatterns("  , ")).toEqual([]);
  });

  it("makes one contains-pattern per word, commas and spaces both split", () => {
    expect(labSearchPatterns("Castillo, Maria  GLU")).toEqual(["%Castillo%", "%Maria%", "%GLU%"]);
  });

  it("escapes LIKE wildcards and PostgREST's * alias", () => {
    expect(labSearchPatterns("50%_a\\b*")).toEqual(["%50\\%\\_a\\\\b\\*%"]);
  });
});

describe("applyLabSearch", () => {
  it("ANDs one ilike per word on the embedded search text", async () => {
    const { db, requests } = client();
    await applyLabSearch(
      db.from("test_requests").select("id, lab_search!inner ( )"),
      labSearchPatterns("Cruz FBS"),
    );
    expect(LAB_SEARCH_TEXT).toBe("lab_search.search_text");
    expect(requests[0].searchParams.getAll("lab_search.search_text")).toEqual([
      "ilike.%Cruz%",
      "ilike.%FBS%",
    ]);
  });

  it("adds nothing when there are no words", async () => {
    const { db, requests } = client();
    await applyLabSearch(db.from("test_requests").select("id"), []);
    expect(requests[0].searchParams.has("lab_search.search_text")).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`Cannot find module './lab-search'`): `npx vitest run src/lib/queue/lab-search.test.ts`

- [ ] **Step 3: Implement** `src/lib/queue/lab-search.ts`

```ts
import { patientSearchTokens } from "@/lib/patients/search";

/**
 * Server-side free-text search for the two `test_requests` worklists — the lab
 * queue (/staff/queue) and the results archive (/staff/results).
 *
 * Migration 0194 exposes each live test row's searchable text (patient name,
 * DRM-ID, visit #, test code/name, report group, and the other members of its
 * chemistry panel) as the PostgREST computed relationship `lab_search`. A page
 * that is searching selects `lab_search!inner ( )` and chains one ilike per
 * word here, onto the query it already pages with count: "exact" + .range() —
 * so the pager's total and every page are the searched set, and every other
 * gate (tab, section, money, deleted rows) still lives in that one query.
 *
 * Words come from `patientSearchTokens` (whitespace + commas), so matching is
 * AND across words, any order, case-insensitive — what the post-fetch
 * `matchesAllTokens` filter did, minus the page limit.
 */

/** The embedded column the filters target. */
export const LAB_SEARCH_TEXT = "lab_search.search_text";

/**
 * One `%word%` ILIKE pattern per word; `[]` for a blank search. Escapes `\ % _`
 * and PostgREST's `*` wildcard alias the way src/lib/visits/archive-search.ts
 * does, so a typed `%` or `_` is matched literally.
 */
export function labSearchPatterns(query: string | null | undefined): string[] {
  return patientSearchTokens(query).map((token) => `%${token.replace(/[\\%_*]/g, "\\$&")}%`);
}

/** Chain the word filters. The caller must have selected `lab_search!inner ( )`. */
export function applyLabSearch<T extends { ilike: (column: string, pattern: string) => T }>(
  query: T,
  patterns: readonly string[],
): T {
  for (const pattern of patterns) query = query.ilike(LAB_SEARCH_TEXT, pattern);
  return query;
}
```

- [ ] **Step 4: Run — expect PASS.** If tsc rejects the structural `ilike` constraint against `PostgrestFilterBuilder`, copy the constraint shape `archive-search.ts` uses for `or` (same idea).

- [ ] **Step 5: Commit** `git add src/lib/queue/lab-search.ts src/lib/queue/lab-search.test.ts && git commit -m "feat(queue): lab-search helper for server-side worklist search"`

### Task 3: Lab queue page

**File:** `src/app/(staff)/staff/(dashboard)/queue/page.tsx`

- [ ] **Step 1:** Hoist the current select literal into `const QUEUE_SELECT = \`…\`` (unchanged text) and add `const QUEUE_SELECT_SEARCH` = the same text plus a final line `lab_search!inner ( )`, with a short comment: the embed is only sent while searching — an unconditional inner join would run the search view on every page load. `query-surfaces.test.ts` accepts a ternary over hoisted literal constants (the archive shape) — keep both literal, no interpolation.

- [ ] **Step 2:** Near `const q = …` add `const searchPatterns = labSearchPatterns(q); const searching = searchPatterns.length > 0;`. `.select(searching ? QUEUE_SELECT_SEARCH : QUEUE_SELECT, { count: "exact" })`. After the Visit # filter block: `query = applyLabSearch(query, searchPatterns);` with a comment that it counts against the whole queue like every other filter.

- [ ] **Step 3:** Delete `cardHaystack`, the `matchesAllTokens` import, the "Free-text search runs after the fold" comment and `matched`; use `cards` everywhere `matched` was (claimer names, panel refs, selection entries, empty state, row map).

- [ ] **Step 4:** Replace the "`q` is applied after the fetch" comment + flags with `const hasServerFilters = hasDateRange || Boolean(visit) || searching; const hasFilters = hasServerFilters;` (keep `hasFilters` name for the Clear link). Remove the subtitle's `{q ? … on this page match …}` line and the amber `{q && totalPages > 1 ? …}` note + its comment. Keep `q` in `selectionResetKey` and `baseParams`.

- [ ] **Step 5:** `npm run typecheck && npx vitest run src/lib/visits/query-surfaces.test.ts` → PASS. Commit `feat(queue): search box searches the whole queue, not the page`.

### Task 4: Results archive page

**File:** `src/app/(staff)/staff/(dashboard)/results/page.tsx`

- [ ] **Step 1:** Add `ARCHIVE_SELECT_BASE_SEARCH`, `ARCHIVE_SELECT_UPDATED_7D_SEARCH`, `ARCHIVE_SELECT_UPDATED_MINE_SEARCH` — each its sibling's literal text plus `lab_search!inner ( )` on the last line; one comment above the three explaining why they exist (search embed only while searching; literal so query-surfaces can read every branch).

- [ ] **Step 2:** `const searchPatterns = labSearchPatterns(q); const searching = searchPatterns.length > 0;` Select: `updated === "7d" ? (searching ? …_7D_SEARCH : …_7D) : updated === "mine" ? (searching ? …MINE_SEARCH : …MINE) : searching ? …BASE_SEARCH : …BASE`. Chain `query = applyLabSearch(query, searchPatterns);` with the other filters (before the `await`).

- [ ] **Step 3:** Delete the post-fetch `filtered` block + its comment and the `matchesAllTokens` import; iterate `rows`. Subtitle: `hasFilters ? · N matching : · N total` (drop the `q ?` branch and its comment). Remove the amber "only looks at the {size} tests" note. Empty state: `!q` → `!searching`.

- [ ] **Step 4:** `npm run typecheck && npx vitest run src/lib/visits/query-surfaces.test.ts` → PASS. Commit `feat(results): archive search box searches the whole archive`.

### Task 5: Docs

- [ ] `docs/drmed-user-guide.html`: remove the warn box "Two search boxes only look at the page in front of you" (§2, ~line 457). §4.2 Filters line: `Patient / test search` now "name, DRM-ID, test code or name, or visit # — searches the whole queue, not just this page; a chemistry test's code finds its whole panel". §4.10: describe the archive search the same way. Bump the version the way prior PRs did (toc tag + any changelog/"what changed" list the guide keeps) to v2.48, 30 Sep 2026.
- [ ] `.claude/skills/drmed-result-templates/SKILL.md`: replace line ~126's "Free-text search runs after the chemistry fold, so it only narrows the page in hand — the UI says so." with the 0194 mechanism (computed relationship, `lab-search.ts`, select-only-while-searching, panel siblings + tab bucket, never a post-fetch filter); add `0194_lab_search.sql` to its migration tree.
- [ ] `CLAUDE.md`: ledger note — 0194 (`lab_search`) written, NOT yet on prod (pushed right before merge).
- [ ] Commit `docs: server-side queue/results search (guide v2.48, skill)`.

### Task 6: Verification

- [ ] `npm test && npm run typecheck && npm run lint` — all green (report counts).
- [ ] Local browser check (recipe: memory `drmed-queue-panel-claim` — git-excluded `.qss-check/check.mjs`, playwright-core + `pg`, password sign-in `admin@drmed.ph`). OWN fixtures only (patients last name `Qssfixture…`, visits 9301+; never Bsqfixture; clean up after). Assert with `size=5`: (1) a unique surname on what would be page 2+ is found, subtitle shows `N matching` with the right N, no amber note; (2) a chemistry member code finds the whole panel card; (3) two words in reverse order match; (4) archive `/staff/results?q=…&size=5` finds a row outside page 1; (5) deleted visit's rows never appear.
- [ ] Sonnet code review, then Codex astra high review; fix, recheck.

### Task 7: Ship

- [ ] Push branch, open PR.
- [ ] Right before merge: `npm run claim -- list` + `list_migrations` (prod) → `supabase db push --dry-run` must list ONLY 0194 (use `--include-all` only if a lower number is legitimately pending and that is understood) → push → verify by object (view reloption `security_invoker=on`, both ACLs, `explain` on prod shows no Function Scan).
- [ ] Merge, confirm the Vercel production deploy; update CLAUDE.md ledger + memory.
