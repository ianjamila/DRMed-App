# Patient-Dedup Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop new duplicate patient records at the authenticated staff surfaces, let returning patients self-recover their DRM-ID (enumeration-safe), and give admins a ranked "possible duplicates" report with reversible per-pair merges to clear the legacy backlog.

**Architecture:** A single pure, unit-tested scoring module (`duplicates.ts`) is the source of truth. SQL does candidate *blocking* (a view over equality keys); TS does all *scoring*. The same scorer powers the admin report and the staff near-match warning. `resolve.ts` (silent exact-key dedup) is left unchanged. Merges become reversible via a new `patient_merges` ledger.

**Tech Stack:** Next.js 16 (App Router, Server Components + Server Actions), Supabase Postgres + RLS, vitest, Resend (branded HTML email), Vercel Cron, Zod.

**Design spec:** `docs/superpowers/specs/2026-06-17-patient-dedup-hardening-design.md`

**Prod project:** `DRMed App` = `qhptbmafrosgibooelpp`. Remote migrations apply via Supabase MCP (IPv6 push gotcha); local dev uses `scripts/supabase-local.sh`.

**Conventions reminder:** Server Actions return `{ ok: true, ... } | { ok: false, error }`. Every write/access audits via `audit()`. TS strict (no `any` without a comment). Commit messages: Conventional Commits + `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## Phase 1 — Pure scoring engine (no DB, TDD)

### Task 1: `nameSimilarity` + `scorePair` skeleton & types

**Files:**
- Create: `src/lib/patients/duplicates.ts`
- Test: `src/lib/patients/duplicates.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/patients/duplicates.test.ts
import { describe, it, expect } from "vitest";
import { nameSimilarity } from "./duplicates";

describe("nameSimilarity", () => {
  it("is 1 for identical normalized names", () => {
    expect(nameSimilarity("John Cruz", "  john   cruz ")).toBe(1);
  });
  it("is high for a one-letter typo", () => {
    expect(nameSimilarity("Jonathan Cruz", "Jonathon Cruz")).toBeGreaterThan(0.85);
  });
  it("is low for unrelated names", () => {
    expect(nameSimilarity("Maria Santos", "John Cruz")).toBeLessThan(0.4);
  });
  it("is 0 when either side is empty", () => {
    expect(nameSimilarity("", "John")).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/patients/duplicates.test.ts`
Expected: FAIL — `nameSimilarity` is not exported / module not found.

- [ ] **Step 3: Write the module (types + nameSimilarity)**

```ts
// src/lib/patients/duplicates.ts
// PURE module — no `import "server-only"`. The single source of truth for
// duplicate scoring, shared by the admin report and the staff near-match
// warning. Unit-tested without a DB. SQL does blocking; this does scoring.

export interface CandidateFields {
  first_name: string;
  last_name: string;
  birthdate: string | null; // ISO date string or null
  email: string | null;
  phone_normalized: string | null; // last-10-digits, or null
  address: string | null;
  sex: string | null;
}

export type DupTier = "exact_dup" | "strong" | "probable" | "weak";

export type DupSignal =
  | "exact_email"
  | "same_birthdate"
  | "same_last_name"
  | "same_first_name"
  | "fuzzy_name"
  | "same_phone"
  | "same_address"
  | "same_sex";

export interface DupScore {
  score: number;
  signals: DupSignal[];
  tier: DupTier | null; // null = below the weak floor, not a candidate
}

export const DUP_FUZZY_NAME_THRESHOLD = 0.85;
export const DUP_WEAK_FLOOR = 25;
export const DUP_PROBABLE_FLOOR = 45;
export const DUP_STRONG_FLOOR = 70;

const norm = (s: string | null | undefined): string =>
  (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

// Sørensen–Dice coefficient on character bigrams — cheap, dependency-free,
// good enough for short person names. Returns 0..1.
export function nameSimilarity(a: string, b: string): number {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const bigrams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ma = bigrams(x);
  const mb = bigrams(y);
  let inter = 0;
  for (const [g, ca] of ma) {
    const cb = mb.get(g);
    if (cb) inter += Math.min(ca, cb);
  }
  return (2 * inter) / (x.length - 1 + (y.length - 1));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/patients/duplicates.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/patients/duplicates.ts src/lib/patients/duplicates.test.ts
git commit -m "feat(dedup): name-similarity helper + scoring types

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 2: `scorePair` — signals, weights, tiers, family-phone guard

**Files:**
- Modify: `src/lib/patients/duplicates.ts` (append `scorePair`)
- Test: `src/lib/patients/duplicates.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/patients/duplicates.test.ts`:

```ts
import { scorePair, type CandidateFields } from "./duplicates";

const base: CandidateFields = {
  first_name: "John", last_name: "Cruz", birthdate: "1990-01-01",
  email: "john@x.com", phone_normalized: "9171234567",
  address: "1 Main St", sex: "male",
};
const clone = (o: Partial<CandidateFields>): CandidateFields => ({ ...base, ...o });

describe("scorePair", () => {
  it("flags exact_dup when email+first+last+birthdate all match", () => {
    const r = scorePair(base, clone({ phone_normalized: null, address: null }));
    expect(r.tier).toBe("exact_dup");
    expect(r.signals).toContain("exact_email");
  });

  it("same email + same birthdate + same last, first typo => strong (not exact_dup)", () => {
    const r = scorePair(base, clone({ first_name: "Jon" }));
    expect(r.tier).toBe("strong");
    expect(r.signals).toContain("exact_email");
  });

  it("same first+last+birthdate, different email => probable or strong, corroborated", () => {
    const r = scorePair(base, clone({ email: "other@x.com", phone_normalized: null }));
    expect(["probable", "strong"]).toContain(r.tier);
  });

  it("FAMILY PHONE: same phone, different surname, different birthdate => never above weak", () => {
    const r = scorePair(
      clone({ first_name: "Ana", last_name: "Reyes", birthdate: "1988-05-05", email: null }),
      clone({ first_name: "Ben", last_name: "Santos", birthdate: "2010-09-09", email: null }),
    );
    expect(r.signals).toContain("same_phone");
    expect(r.tier === "weak" || r.tier === null).toBe(true);
  });

  it("SIBLINGS: same last+phone+address, different first+birthdate => not above weak (no corroboration)", () => {
    const r = scorePair(
      clone({ first_name: "Ana", birthdate: "2008-01-01", email: null }),
      clone({ first_name: "Ben", birthdate: "2010-01-01", email: null }),
    );
    expect(r.tier === "weak" || r.tier === null).toBe(true);
  });

  it("unrelated people => no tier", () => {
    const r = scorePair(
      clone({ first_name: "Ana", last_name: "Reyes", birthdate: "1988-05-05", email: "a@x.com", phone_normalized: "9001112222", address: "X" }),
      clone({ first_name: "Ben", last_name: "Santos", birthdate: "2010-09-09", email: "b@y.com", phone_normalized: "9003334444", address: "Y", sex: "female" }),
    );
    expect(r.tier).toBeNull();
  });

  it("same email only => probable (email corroborates)", () => {
    const r = scorePair(
      clone({ first_name: "Ana", last_name: "Reyes", birthdate: null, phone_normalized: null, address: null, sex: null }),
      clone({ first_name: "Bea", last_name: "Tan", birthdate: null, phone_normalized: null, address: null, sex: null }),
    );
    expect(r.tier).toBe("probable");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/patients/duplicates.test.ts`
Expected: FAIL — `scorePair` not exported.

- [ ] **Step 3: Implement `scorePair`**

Append to `src/lib/patients/duplicates.ts`:

```ts
export function scorePair(a: CandidateFields, b: CandidateFields): DupScore {
  const signals: DupSignal[] = [];
  let score = 0;

  const emailA = norm(a.email);
  const emailB = norm(b.email);
  const exactEmail = !!emailA && emailA === emailB;
  const sameLast = !!norm(a.last_name) && norm(a.last_name) === norm(b.last_name);
  const sameFirst = !!norm(a.first_name) && norm(a.first_name) === norm(b.first_name);
  const sameBirth = !!a.birthdate && a.birthdate === b.birthdate;
  const fullA = `${norm(a.first_name)} ${norm(a.last_name)}`.trim();
  const fullB = `${norm(b.first_name)} ${norm(b.last_name)}`.trim();
  const fuzzyName =
    !(sameFirst && sameLast) && nameSimilarity(fullA, fullB) >= DUP_FUZZY_NAME_THRESHOLD;
  const samePhone =
    !!a.phone_normalized &&
    a.phone_normalized.length === 10 &&
    a.phone_normalized === b.phone_normalized;
  const sameAddress = !!norm(a.address) && norm(a.address) === norm(b.address);
  const sameSex = !!a.sex && a.sex === b.sex;

  if (exactEmail) { signals.push("exact_email"); score += 50; }
  if (sameBirth) { signals.push("same_birthdate"); score += 25; }
  if (sameLast) { signals.push("same_last_name"); score += 15; }
  if (sameFirst) { signals.push("same_first_name"); score += 15; }
  if (fuzzyName) { signals.push("fuzzy_name"); score += 10; }
  if (samePhone) { signals.push("same_phone"); score += sameLast ? 20 : 8; } // family-phone down-weight
  if (sameAddress) { signals.push("same_address"); score += 10; }
  if (sameSex) { signals.push("same_sex"); score += 3; }

  // exact_dup short-circuit: definitionally the same person.
  if (exactEmail && sameFirst && sameLast && sameBirth) {
    return { score, signals, tier: "exact_dup" };
  }

  // Corroboration guard: strong/probable require a NON-phone identity anchor,
  // so shared family phones (and shared sibling households) can never reach an
  // actionable tier on phone/address alone.
  const corroborated =
    exactEmail ||
    (sameBirth && sameLast) ||
    (sameFirst && sameLast) ||
    (fuzzyName && sameBirth);

  let tier: DupTier | null = null;
  if (score >= DUP_STRONG_FLOOR && corroborated) tier = "strong";
  else if (score >= DUP_PROBABLE_FLOOR && corroborated) tier = "probable";
  else if (score >= DUP_WEAK_FLOOR) tier = "weak";

  return { score, signals, tier };
}
```

- [ ] **Step 4: Run to verify all pass**

Run: `npx vitest run src/lib/patients/duplicates.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/patients/duplicates.ts src/lib/patients/duplicates.test.ts
git commit -m "feat(dedup): scorePair with tiers + family-phone corroboration guard

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 2 — Migrations (DB foundation)

> Apply each to the local stack to verify, then (at rollout) to prod via Supabase MCP. After all three: `npm run db:types`. See the `drmed-migrations` skill.

### Task 3: Migration 0105 — `phone_normalized` column + trigger + backfill

**Files:**
- Create: `supabase/migrations/0105_patient_phone_normalized.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0105_patient_phone_normalized.sql
-- Maintained last-10-digits phone for index-friendly dedup blocking.

alter table public.patients add column if not exists phone_normalized text;

create or replace function public.normalise_patient_phone()
returns trigger language plpgsql as $$
begin
  if new.phone is null then
    new.phone_normalized := null;
  else
    new.phone_normalized := right(regexp_replace(new.phone, '\D', '', 'g'), 10);
    if new.phone_normalized = '' or length(new.phone_normalized) <> 10 then
      new.phone_normalized := null;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_patients_normalise_phone on public.patients;
create trigger trg_patients_normalise_phone
  before insert or update of phone on public.patients
  for each row execute function public.normalise_patient_phone();

-- One-time backfill (sets column directly; does not re-fire the phone trigger).
update public.patients
set phone_normalized = right(regexp_replace(phone, '\D', '', 'g'), 10)
where phone is not null;
update public.patients
set phone_normalized = null
where phone_normalized is not null and length(phone_normalized) <> 10;

create index if not exists idx_patients_phone_normalized
  on public.patients (phone_normalized) where phone_normalized is not null;
```

- [ ] **Step 2: Apply locally & verify**

Run: `./scripts/supabase-local.sh` (start local stack), then apply migrations:
`npm run db:reset` (applies all migrations to local).
Then verify with psql against the local DB:
```sql
select count(*) filter (where phone is not null) as with_phone,
       count(*) filter (where phone_normalized is not null) as normalized
from patients;
-- normalized should be <= with_phone (rows with <10 digits stay null)
```
Expected: query runs; `normalized` ≤ `with_phone`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0105_patient_phone_normalized.sql
git commit -m "feat(dedup): migration 0105 phone_normalized column + trigger + backfill

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 4: Migration 0106 — candidate-pairs view

**Files:**
- Create: `supabase/migrations/0106_patient_dedup_candidates_view.sql`

> Note: blocking is **equality-only** (email / phone / last_name+birthdate) so every join is index-assisted. A standalone trigram cross-join over ~6,800 rows is ~47M comparisons and is intentionally excluded; the `fuzzy_name` signal is still computed in TS for pairs surfaced by the equality blocks (e.g. same phone + name typo). Fuzzy-only matches (no shared email/phone/last+birthdate) are out of scope for candidate generation — they would be weak-tier anyway.

- [ ] **Step 1: Write the migration**

```sql
-- 0106_patient_dedup_candidates_view.sql
-- Candidate duplicate PAIRS (id_a < id_b) sharing >=1 equality blocking key.
-- Emits raw fields for both sides; scoring happens in TS (scorePair).

create or replace view public.v_patient_dedup_candidate_pairs
with (security_invoker = true) as
with active as (
  select id, drm_id, first_name, last_name, middle_name, birthdate, email,
         phone_normalized, address, sex,
         (legacy_import_run_id is not null) as is_legacy, created_at
  from public.patients
  where merged_into_id is null
),
pairs as (
  select a.id as id_a, b.id as id_b
  from active a join active b
    on a.id < b.id and a.email is not null and a.email = b.email
  union
  select a.id, b.id
  from active a join active b
    on a.id < b.id and a.phone_normalized is not null
       and a.phone_normalized = b.phone_normalized
  union
  select a.id, b.id
  from active a join active b
    on a.id < b.id and a.birthdate is not null and a.birthdate = b.birthdate
       and lower(trim(a.last_name)) = lower(trim(b.last_name))
)
select
  p.id_a, p.id_b,
  a.drm_id as a_drm_id, a.first_name as a_first_name, a.last_name as a_last_name,
  a.middle_name as a_middle_name, a.birthdate as a_birthdate, a.email as a_email,
  a.phone_normalized as a_phone_normalized, a.address as a_address, a.sex as a_sex,
  a.is_legacy as a_is_legacy, a.created_at as a_created_at,
  b.drm_id as b_drm_id, b.first_name as b_first_name, b.last_name as b_last_name,
  b.middle_name as b_middle_name, b.birthdate as b_birthdate, b.email as b_email,
  b.phone_normalized as b_phone_normalized, b.address as b_address, b.sex as b_sex,
  b.is_legacy as b_is_legacy, b.created_at as b_created_at
from pairs p
join active a on a.id = p.id_a
join active b on b.id = p.id_b;
```

- [ ] **Step 2: Apply locally & verify**

Run: `npm run db:reset`, then query the view:
```sql
select count(*) from v_patient_dedup_candidate_pairs;
```
Expected: returns a count (0+ on local seed data; the query plan must not error).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0106_patient_dedup_candidates_view.sql
git commit -m "feat(dedup): migration 0106 candidate-pairs view (equality blocking)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 5: Migration 0107 — `patient_merges` ledger (for reversible merges)

**Files:**
- Create: `supabase/migrations/0107_patient_merges.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0107_patient_merges.sql
-- Ledger of merges so each can be reversed within an undo window. All access
-- via the service-role client (merge/undo actions, admin report); RLS enabled
-- with no policies => denied to anon/authenticated, service role bypasses.

create table if not exists public.patient_merges (
  id               uuid primary key default gen_random_uuid(),
  keep_id          uuid not null references public.patients(id),
  source_id        uuid not null references public.patients(id),
  merged_by        uuid references auth.users(id),
  merged_at        timestamptz not null default now(),
  moved            jsonb not null default '{}'::jsonb, -- { visits:[], appointments:[], audit_log:[], critical_alerts:[], patient_consents:[] }
  filled_from_source text[] not null default '{}',
  undone_at        timestamptz,
  undone_by        uuid references auth.users(id)
);

create index if not exists idx_patient_merges_active
  on public.patient_merges (merged_at desc) where undone_at is null;
create index if not exists idx_patient_merges_source
  on public.patient_merges (source_id);

alter table public.patient_merges enable row level security;
-- No policies on purpose: only the service-role client touches this table.
```

- [ ] **Step 2: Apply locally & verify + regen types**

Run: `npm run db:reset`, then:
```sql
insert into patient_merges (keep_id, source_id) values
  ((select id from patients limit 1), (select id from patients offset 1 limit 1)) returning id;
```
Expected: returns a uuid (then delete it). Then regenerate types:
Run: `npm run db:types`
Expected: `src/types/database.ts` now contains `patient_merges` and `v_patient_dedup_candidate_pairs`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0107_patient_merges.sql src/types/database.ts
git commit -m "feat(dedup): migration 0107 patient_merges ledger + regen types

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 3 — DB wrappers (candidate loaders)

### Task 6: `find-duplicates.ts` — pairs loader + single-input finder

**Files:**
- Create: `src/lib/patients/find-duplicates.ts`

> Not separately vitest-tested (it's thin DB I/O; verified by typecheck + smoke). Scoring it delegates to `scorePair`, which is already tested.

- [ ] **Step 1: Write the module**

```ts
// src/lib/patients/find-duplicates.ts
import "server-only";
import type { createAdminClient } from "@/lib/supabase/admin";
import { scorePair, type CandidateFields, type DupScore, type DupTier } from "./duplicates";

type AdminClient = ReturnType<typeof createAdminClient>;

export interface CandidatePatient extends CandidateFields {
  id: string;
  drm_id: string;
  middle_name: string | null;
  is_legacy: boolean;
  created_at: string;
}

export interface CandidatePair {
  id_a: string;
  id_b: string;
  a: CandidatePatient;
  b: CandidatePatient;
  score: DupScore;
}

export interface ScoredCandidate {
  patient: CandidatePatient;
  score: DupScore;
}

const TIER_RANK: Record<DupTier, number> = { weak: 1, probable: 2, strong: 3, exact_dup: 4 };
export function tierAtLeast(tier: DupTier | null, min: DupTier): boolean {
  return tier !== null && TIER_RANK[tier] >= TIER_RANK[min];
}

// Map one side (a_/b_) of a view row to a CandidatePatient.
function side(row: Record<string, unknown>, p: "a" | "b", idKey: "id_a" | "id_b"): CandidatePatient {
  const g = (k: string) => row[`${p}_${k}`] as never;
  return {
    id: row[idKey] as string,
    drm_id: g("drm_id"),
    first_name: g("first_name"),
    last_name: g("last_name"),
    middle_name: g("middle_name"),
    birthdate: g("birthdate"),
    email: g("email"),
    phone_normalized: g("phone_normalized"),
    address: g("address"),
    sex: g("sex"),
    is_legacy: g("is_legacy"),
    created_at: g("created_at"),
  };
}

// All candidate pairs for the admin report, scored and ranked.
export async function loadCandidatePairs(
  admin: AdminClient,
  opts: { minTier?: DupTier } = {},
): Promise<CandidatePair[]> {
  const min = opts.minTier ?? "probable";
  const { data, error } = await admin.from("v_patient_dedup_candidate_pairs").select("*");
  if (error || !data) return [];
  const out: CandidatePair[] = [];
  for (const row of data as Record<string, unknown>[]) {
    const a = side(row, "a", "id_a");
    const b = side(row, "b", "id_b");
    const score = scorePair(a, b);
    if (tierAtLeast(score.tier, min)) {
      out.push({ id_a: a.id, id_b: b.id, a, b, score });
    }
  }
  out.sort((x, y) => y.score.score - x.score.score);
  return out;
}

// Candidates for one in-progress patient (staff near-match warning).
export async function findCandidatesForInput(
  admin: AdminClient,
  input: CandidateFields & { excludeId?: string },
  opts: { minTier?: DupTier } = {},
): Promise<ScoredCandidate[]> {
  const min = opts.minTier ?? "probable";
  const email = (input.email ?? "").trim().toLowerCase();
  const phone = input.phone_normalized;
  const last = input.last_name.trim();
  const birth = input.birthdate;

  const clauses: string[] = [];
  if (email) clauses.push(`email.eq.${email}`);
  if (phone && phone.length === 10) clauses.push(`phone_normalized.eq.${phone}`);
  if (last && birth) clauses.push(`and(last_name.eq.${last},birthdate.eq.${birth})`);
  if (clauses.length === 0) return [];

  const { data, error } = await admin
    .from("patients")
    .select(
      "id, drm_id, first_name, last_name, middle_name, birthdate, email, phone_normalized, address, sex, legacy_import_run_id, created_at",
    )
    .is("merged_into_id", null)
    .or(clauses.join(","))
    .limit(50);
  if (error || !data) return [];

  const out: ScoredCandidate[] = [];
  for (const r of data) {
    if (input.excludeId && r.id === input.excludeId) continue;
    const patient: CandidatePatient = {
      id: r.id, drm_id: r.drm_id, first_name: r.first_name, last_name: r.last_name,
      middle_name: r.middle_name, birthdate: r.birthdate, email: r.email,
      phone_normalized: r.phone_normalized, address: r.address, sex: r.sex,
      is_legacy: r.legacy_import_run_id !== null, created_at: r.created_at,
    };
    const score = scorePair(input, patient);
    if (tierAtLeast(score.tier, min)) out.push({ patient, score });
  }
  out.sort((x, y) => y.score.score - x.score.score);
  return out;
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `npm run typecheck`
Expected: no errors. (If `.or()` with the `and(...)` group complains about field names, confirm against an existing `.or()` call — e.g. grep `.or(` in `src/app` — and match the exact comma/paren format.)

- [ ] **Step 3: Commit**

```bash
git add src/lib/patients/find-duplicates.ts
git commit -m "feat(dedup): candidate loaders (report pairs + single-input finder)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 4 — Merge ledger + reversible merge (extends existing tool)

### Task 7: Record `patient_merges` row on every merge (capture moved IDs)

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/admin/patient-merge/actions.ts`

The existing `mergePatientsAction` already uses `.update(...).select("id")` on each table, so `visits/appts/auditRows/criticalAlerts/consents` hold the moved row IDs. We add a `patient_merges` insert just before the audit call.

- [ ] **Step 1: Add the ledger insert**

In `mergePatientsAction`, after the tombstone block (after line ~207, the `if (tombErr) { return ... }`) and before `const h = await headers();`, insert:

```ts
  // Record the merge for reversibility (exact moved IDs + filled fields).
  const movedIds = {
    visits: (visits ?? []).map((r) => r.id),
    appointments: (appts ?? []).map((r) => r.id),
    audit_log: (auditRows ?? []).map((r) => r.id),
    critical_alerts: (criticalAlerts ?? []).map((r) => r.id),
    patient_consents: (consents ?? []).map((r) => r.id),
  };
  await admin.from("patient_merges").insert({
    keep_id,
    source_id,
    merged_by: session.user_id,
    moved: movedIds,
    filled_from_source: Object.keys(fill),
  });
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/admin/patient-merge/actions.ts"
git commit -m "feat(dedup): record patient_merges ledger row on merge

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 8: `undoMergeAction` + recent-merges loader

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/admin/patient-merge/actions.ts`

- [ ] **Step 1: Add the undo window constant, loader, and action**

Append to `actions.ts`:

```ts
import { z as _zKeep } from "zod"; // (z already imported at top — do not duplicate; this line is illustrative, remove if z exists)

export const MERGE_UNDO_WINDOW_DAYS = 30;

export interface RecentMerge {
  id: string;
  keep_id: string;
  source_id: string;
  keep_drm_id: string | null;
  source_drm_id: string | null;
  merged_at: string;
  undoable: boolean;
}

export async function loadRecentMerges(): Promise<RecentMerge[]> {
  await requireAdminStaff();
  const admin = createAdminClient();
  const cutoff = new Date(Date.now() - MERGE_UNDO_WINDOW_DAYS * 86400_000).toISOString();
  const { data } = await admin
    .from("patient_merges")
    .select("id, keep_id, source_id, merged_at, undone_at")
    .is("undone_at", null)
    .gte("merged_at", cutoff)
    .order("merged_at", { ascending: false })
    .limit(50);
  if (!data) return [];
  const ids = Array.from(new Set(data.flatMap((m) => [m.keep_id, m.source_id])));
  const { data: pts } = await admin.from("patients").select("id, drm_id").in("id", ids);
  const drm = new Map((pts ?? []).map((p) => [p.id, p.drm_id]));
  return data.map((m) => ({
    id: m.id,
    keep_id: m.keep_id,
    source_id: m.source_id,
    keep_drm_id: drm.get(m.keep_id) ?? null,
    source_drm_id: drm.get(m.source_id) ?? null,
    merged_at: m.merged_at,
    undoable: true,
  }));
}

export type UndoResult = { ok: true } | { ok: false; error: string };

export async function undoMergeAction(
  _prev: UndoResult | null,
  formData: FormData,
): Promise<UndoResult> {
  const session = await requireAdminStaff();
  const mergeId = z.string().uuid().safeParse(formData.get("merge_id"));
  if (!mergeId.success) return { ok: false, error: "Invalid merge id." };

  const admin = createAdminClient();
  const { data: m } = await admin
    .from("patient_merges")
    .select("id, keep_id, source_id, merged_at, moved, filled_from_source, undone_at")
    .eq("id", mergeId.data)
    .maybeSingle();
  if (!m) return { ok: false, error: "Merge record not found." };
  if (m.undone_at) return { ok: false, error: "This merge was already undone." };

  const ageDays = (Date.now() - new Date(m.merged_at).getTime()) / 86400_000;
  if (ageDays > MERGE_UNDO_WINDOW_DAYS) {
    return { ok: false, error: `Merges can only be undone within ${MERGE_UNDO_WINDOW_DAYS} days.` };
  }

  const moved = (m.moved ?? {}) as Record<string, string[]>;
  // Re-point each recorded row back to the source patient.
  const repoint = async (table: "visits" | "appointments" | "audit_log" | "critical_alerts" | "patient_consents") => {
    const ids = moved[table] ?? [];
    if (ids.length === 0) return;
    await admin.from(table).update({ patient_id: m.source_id }).in("id", ids);
  };
  await repoint("visits");
  await repoint("appointments");
  await repoint("audit_log");
  await repoint("critical_alerts");
  await repoint("patient_consents");

  // Null out exactly the fields the merge filled (merge only fills NULL keep fields).
  const filled = (m.filled_from_source ?? []) as string[];
  if (filled.length > 0) {
    const clear: Record<string, null> = {};
    for (const f of filled) clear[f] = null;
    await admin.from("patients").update(clear).eq("id", m.keep_id);
  }

  // Restore the source row.
  await admin.from("patients").update({ merged_into_id: null, merged_at: null }).eq("id", m.source_id);

  // Mark the ledger row undone.
  await admin.from("patient_merges").update({ undone_at: new Date().toISOString(), undone_by: session.user_id }).eq("id", m.id);

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    patient_id: m.keep_id,
    action: "patient.merge.undone",
    resource_type: "patient",
    resource_id: m.source_id,
    metadata: { merge_id: m.id, keep_id: m.keep_id, source_id: m.source_id, restored: moved, cleared_fields: filled },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath("/staff/admin/patient-merge");
  revalidatePath("/staff/admin/patient-merge/candidates");
  revalidatePath("/staff/patients");
  return { ok: true };
}
```

> NOTE: `z`, `createAdminClient`, `audit`, `requireAdminStaff`, `headers`, `revalidatePath` are already imported at the top of `actions.ts` — do NOT re-import. Remove the illustrative `_zKeep` line above; it is only there to flag that `z` is needed.

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: no errors. (Supabase typed-table `.from(table)` with a union string may need `// @ts-expect-error`-free handling — if the union argument errors, switch the `repoint` helper to a `switch` over literal table names so each `.from("visits")` etc. is a literal.)

- [ ] **Step 3: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/admin/patient-merge/actions.ts"
git commit -m "feat(dedup): reversible merges — undoMergeAction + recent-merges loader

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 5 — Admin "possible duplicates" report (D)

### Task 9: `mergeCandidateAction` (one-click merge by ids, with preview)

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/admin/patient-merge/actions.ts`

The report has both uuids already, so it doesn't need the `confirm: "MERGE"` typed gate (that's for the manual two-DRM-ID tool). Add a thin wrapper that reuses the merge body. Simplest: a new action that builds the FormData and calls `mergePatientsAction` internally.

- [ ] **Step 1: Add the wrapper**

Append to `actions.ts`:

```ts
// One-click merge from the candidates report (ids already known + admin-confirmed
// in the UI). Reuses the audited merge path; keep_id is the OLDER record by default.
export async function mergeCandidateAction(
  _prev: MergeResult | null,
  formData: FormData,
): Promise<MergeResult> {
  const fd = new FormData();
  fd.set("keep_id", String(formData.get("keep_id") ?? ""));
  fd.set("source_id", String(formData.get("source_id") ?? ""));
  fd.set("confirm", "MERGE");
  const res = await mergePatientsAction(null, fd);
  if (res.ok) revalidatePath("/staff/admin/patient-merge/candidates");
  return res;
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/admin/patient-merge/actions.ts"
git commit -m "feat(dedup): one-click mergeCandidateAction for the report

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 10: Candidates report page + cross-links

**Files:**
- Create: `src/app/(staff)/staff/(dashboard)/admin/patient-merge/candidates/page.tsx`
- Create: `src/app/(staff)/staff/(dashboard)/admin/patient-merge/candidates/candidates-client.tsx`
- Modify: `src/app/(staff)/staff/(dashboard)/admin/patient-merge/page.tsx` (add a link to the report)

> First READ the existing merge page (`page.tsx` + `merge-client.tsx`) and one report page (`src/app/(staff)/staff/(dashboard)/admin/reports/lab-tat/page.tsx`) to match layout, table styling (`text-xs font-bold uppercase tracking-wider` thead, `divide-y` tbody), and the `useActionState` form pattern used by `merge-client.tsx`.

- [ ] **Step 1: Write the server page**

```tsx
// src/app/(staff)/staff/(dashboard)/admin/patient-merge/candidates/page.tsx
import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadCandidatePairs } from "@/lib/patients/find-duplicates";
import { loadRecentMerges } from "../actions";
import { CandidatesClient } from "./candidates-client";

export const dynamic = "force-dynamic";

export default async function CandidatesPage({
  searchParams,
}: {
  searchParams: Promise<{ tier?: string }>;
}) {
  await requireAdminStaff();
  const sp = await searchParams;
  const minTier = sp.tier === "weak" ? "weak" : "probable";
  const admin = createAdminClient();
  const [pairs, recent] = await Promise.all([
    loadCandidatePairs(admin, { minTier }),
    loadRecentMerges(),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Possible duplicate patients</h1>
          <p className="text-sm text-slate-500">
            Ranked candidate pairs. Review each before merging — merges can be undone within 30 days.
          </p>
        </div>
        <Link href="/staff/admin/patient-merge" className="text-sm font-semibold text-cyan-700 hover:underline">
          Manual merge by DRM-ID →
        </Link>
      </div>

      <div className="flex gap-2 text-sm">
        <Link href="/staff/admin/patient-merge/candidates" className={minTier === "probable" ? "font-bold" : "text-slate-500"}>Probable+</Link>
        <Link href="/staff/admin/patient-merge/candidates?tier=weak" className={minTier === "weak" ? "font-bold" : "text-slate-500"}>Include weak</Link>
      </div>

      <CandidatesClient pairs={pairs} recent={recent} />
    </div>
  );
}
```

- [ ] **Step 2: Write the client component**

Build a client component that renders each pair as a card showing both records (name, DRM-ID, birthdate, email, phone), the matched signal chips, the tier badge, a legacy/organic marker, and a "Review & merge" button wired to `mergeCandidateAction` via `useActionState` with a confirm dialog (reuse the confirm pattern from `merge-client.tsx`). Default `keep_id` = the OLDER `created_at` of the pair (the original record). Also render the "Recently merged" list with an Undo button wired to `undoMergeAction`.

```tsx
// src/app/(staff)/staff/(dashboard)/admin/patient-merge/candidates/candidates-client.tsx
"use client";
import { useActionState } from "react";
import type { CandidatePair } from "@/lib/patients/find-duplicates";
import type { DupSignal } from "@/lib/patients/duplicates";
import { mergeCandidateAction, undoMergeAction, type MergeResult, type UndoResult, type RecentMerge } from "../actions";

const SIGNAL_LABEL: Record<DupSignal, string> = {
  exact_email: "Same email",
  same_birthdate: "Same birthdate",
  same_last_name: "Same surname",
  same_first_name: "Same first name",
  fuzzy_name: "Similar name",
  same_phone: "Same phone",
  same_address: "Same address",
  same_sex: "Same sex",
};

const TIER_STYLE: Record<string, string> = {
  exact_dup: "bg-red-100 text-red-800",
  strong: "bg-orange-100 text-orange-800",
  probable: "bg-amber-100 text-amber-800",
  weak: "bg-slate-100 text-slate-600",
};

function MergeButton({ pair }: { pair: CandidatePair }) {
  const [state, action, pending] = useActionState<MergeResult | null, FormData>(mergeCandidateAction, null);
  // keep = older record; source = newer.
  const older = pair.a.created_at <= pair.b.created_at ? pair.a : pair.b;
  const newer = older.id === pair.a.id ? pair.b : pair.a;
  if (state?.ok) return <span className="text-sm font-semibold text-green-700">Merged ✓</span>;
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!confirm(`Merge ${newer.drm_id} into ${older.drm_id}? This can be undone within 30 days.`)) e.preventDefault();
      }}
    >
      <input type="hidden" name="keep_id" value={older.id} />
      <input type="hidden" name="source_id" value={newer.id} />
      <button disabled={pending} className="rounded bg-cyan-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
        {pending ? "Merging…" : `Merge into ${older.drm_id}`}
      </button>
      {state && !state.ok && <p className="mt-1 text-xs text-red-600">{state.error}</p>}
    </form>
  );
}

function UndoButton({ merge }: { merge: RecentMerge }) {
  const [state, action, pending] = useActionState<UndoResult | null, FormData>(undoMergeAction, null);
  if (state?.ok) return <span className="text-xs text-green-700">Undone ✓</span>;
  return (
    <form action={action} onSubmit={(e) => { if (!confirm("Undo this merge?")) e.preventDefault(); }}>
      <input type="hidden" name="merge_id" value={merge.id} />
      <button disabled={pending} className="text-xs font-semibold text-cyan-700 hover:underline disabled:opacity-50">
        {pending ? "Undoing…" : "Undo"}
      </button>
      {state && !state.ok && <span className="ml-2 text-xs text-red-600">{state.error}</span>}
    </form>
  );
}

function Person({ p }: { p: CandidatePair["a"] }) {
  return (
    <div className="text-sm">
      <div className="font-semibold">{p.first_name} {p.last_name} <span className="text-slate-400">· {p.drm_id}</span> {p.is_legacy && <span className="ml-1 rounded bg-slate-100 px-1 text-[10px] text-slate-500">legacy</span>}</div>
      <div className="text-slate-500">{p.birthdate ?? "—"} · {p.email ?? "no email"} · {p.phone_normalized ?? "no phone"}</div>
    </div>
  );
}

export function CandidatesClient({ pairs, recent }: { pairs: CandidatePair[]; recent: RecentMerge[] }) {
  return (
    <div className="space-y-6">
      {pairs.length === 0 ? (
        <p className="text-sm text-slate-500">No candidate pairs at this confidence level. 🎉</p>
      ) : (
        <ul className="space-y-3">
          {pairs.map((pair) => (
            <li key={`${pair.id_a}:${pair.id_b}`} className="rounded-lg border p-4">
              <div className="mb-2 flex items-center gap-2">
                <span className={`rounded px-2 py-0.5 text-xs font-bold uppercase ${TIER_STYLE[pair.score.tier ?? "weak"]}`}>{pair.score.tier}</span>
                <div className="flex flex-wrap gap-1">
                  {pair.score.signals.map((s) => (
                    <span key={s} className="rounded bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">{SIGNAL_LABEL[s]}</span>
                  ))}
                </div>
              </div>
              <div className="flex items-center justify-between gap-4">
                <div className="grid flex-1 gap-2 sm:grid-cols-2">
                  <Person p={pair.a} />
                  <Person p={pair.b} />
                </div>
                <MergeButton pair={pair} />
              </div>
            </li>
          ))}
        </ul>
      )}

      {recent.length > 0 && (
        <div className="rounded-lg border p-4">
          <h2 className="mb-2 text-sm font-bold">Recently merged (undo within 30 days)</h2>
          <ul className="divide-y">
            {recent.map((m) => (
              <li key={m.id} className="flex items-center justify-between py-2 text-sm">
                <span>{m.source_drm_id} → {m.keep_drm_id} <span className="text-slate-400">· {new Date(m.merged_at).toLocaleDateString("en-PH")}</span></span>
                <UndoButton merge={m} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
```

> If `merge-client.tsx` uses a `Modal`/`Dialog` component instead of `window.confirm`, swap the inline `confirm()` calls for that component to match house style. Grep `merge-client.tsx` first.

- [ ] **Step 3: Add a cross-link on the manual merge page**

In `src/app/(staff)/staff/(dashboard)/admin/patient-merge/page.tsx`, add near the page heading a link:

```tsx
<Link href="/staff/admin/patient-merge/candidates" className="text-sm font-semibold text-cyan-700 hover:underline">
  View possible duplicates →
</Link>
```
(Match the existing import style; `Link` from `next/link`.)

- [ ] **Step 4: Verify build**

Run: `npm run typecheck && npm run build`
Expected: compiles. Then smoke locally (see Phase 9) — `/staff/admin/patient-merge/candidates` renders pairs.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/admin/patient-merge/candidates" "src/app/(staff)/staff/(dashboard)/admin/patient-merge/page.tsx"
git commit -m "feat(dedup): admin possible-duplicates report with inline merge + undo

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 6 — Staff near-match warning (C)

### Task 11: `checkPatientDuplicatesAction`

**Files:**
- Create: `src/lib/patients/check-duplicates-action.ts`

- [ ] **Step 1: Write the action**

```ts
// src/lib/patients/check-duplicates-action.ts
"use server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { findCandidatesForInput, type ScoredCandidate } from "./find-duplicates";

export interface DupCheckInput {
  first_name: string;
  last_name: string;
  birthdate: string | null;
  email: string | null;
  phone: string | null; // raw phone; normalized here
  excludeId?: string;
}

export type DupCheckResult =
  | { ok: true; candidates: PublicCandidate[] }
  | { ok: false; error: string };

// Staff-only payload — staff are authorized to see identifying details.
export interface PublicCandidate {
  id: string;
  drm_id: string;
  first_name: string;
  last_name: string;
  birthdate: string | null;
  email: string | null;
  phone: string | null;
  tier: ScoredCandidate["score"]["tier"];
  signals: ScoredCandidate["score"]["signals"];
}

function normPhone(raw: string | null): string | null {
  if (!raw) return null;
  const d = raw.replace(/\D/g, "").slice(-10);
  return d.length === 10 ? d : null;
}

export async function checkPatientDuplicatesAction(input: DupCheckInput): Promise<DupCheckResult> {
  await requireActiveStaff();
  if (!input.last_name?.trim() || (!input.email && !input.phone && !input.birthdate)) {
    return { ok: true, candidates: [] };
  }
  const admin = createAdminClient();
  const found = await findCandidatesForInput(
    admin,
    {
      first_name: input.first_name ?? "",
      last_name: input.last_name,
      birthdate: input.birthdate,
      email: input.email,
      phone_normalized: normPhone(input.phone),
      address: null,
      sex: null,
      excludeId: input.excludeId,
    },
    { minTier: "probable" },
  );
  return {
    ok: true,
    candidates: found.map((c) => ({
      id: c.patient.id,
      drm_id: c.patient.drm_id,
      first_name: c.patient.first_name,
      last_name: c.patient.last_name,
      birthdate: c.patient.birthdate,
      email: c.patient.email,
      phone: c.patient.phone_normalized,
      tier: c.score.tier,
      signals: c.score.signals,
    })),
  };
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: no errors. (Confirm `requireActiveStaff` is exported from `@/lib/auth/require-staff`; grep if unsure.)

- [ ] **Step 3: Commit**

```bash
git add src/lib/patients/check-duplicates-action.ts
git commit -m "feat(dedup): staff checkPatientDuplicatesAction

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 12: Wire the warning into the slide-over "New patient" mode

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/appointments/new-appointment-sheet.tsx`

> READ this file first to find the "New patient" mode inputs and state. Add a debounced effect that calls `checkPatientDuplicatesAction` when last_name + (email|phone|birthdate) are present, and render the matches inline with a "Use this patient instead" button that switches the sheet to "Existing" mode preselected with that patient.

- [ ] **Step 1: Add the dup-check state + debounced effect**

In the "New patient" mode section, add:

```tsx
// near the other useState hooks
const [dupCandidates, setDupCandidates] = useState<PublicCandidate[]>([]);

// debounced near-match check
useEffect(() => {
  if (!newLastName.trim() || (!newEmail && !newPhone && !newBirthdate)) {
    setDupCandidates([]);
    return;
  }
  const t = setTimeout(async () => {
    const res = await checkPatientDuplicatesAction({
      first_name: newFirstName,
      last_name: newLastName,
      birthdate: newBirthdate || null,
      email: newEmail || null,
      phone: newPhone || null,
    });
    if (res.ok) setDupCandidates(res.candidates);
  }, 400);
  return () => clearTimeout(t);
}, [newFirstName, newLastName, newBirthdate, newEmail, newPhone]);
```
(Use the ACTUAL state variable names from the file — the above assumes `newFirstName/newLastName/newBirthdate/newEmail/newPhone`; rename to match.)

Add imports at top:
```tsx
import { checkPatientDuplicatesAction, type PublicCandidate } from "@/lib/patients/check-duplicates-action";
```

- [ ] **Step 2: Render the inline advisory**

Below the new-patient fields, render (non-blocking):

```tsx
{dupCandidates.length > 0 && (
  <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
    <p className="mb-2 font-semibold text-amber-900">Possible existing patient{dupCandidates.length > 1 ? "s" : ""}:</p>
    <ul className="space-y-2">
      {dupCandidates.map((c) => (
        <li key={c.id} className="flex items-center justify-between gap-2">
          <span>{c.first_name} {c.last_name} · {c.drm_id} · {c.birthdate ?? "—"}{c.tier === "exact_dup" && <span className="ml-1 font-bold text-red-700">exact match</span>}</span>
          <button type="button" onClick={() => useExistingPatient(c.id)} className="shrink-0 rounded bg-amber-600 px-2 py-1 text-xs font-semibold text-white">
            Use this patient
          </button>
        </li>
      ))}
    </ul>
  </div>
)}
```

`useExistingPatient(id)` switches the sheet to "Existing" mode and preselects that patient. Implement by reusing whatever state setter the "Existing" mode uses (the file already has an existing-patient selection path via `searchPatientsAction`) — set the mode to existing and set the selected patient id; if existing mode keeps a full patient object, fetch it via the existing selection handler.

- [ ] **Step 3: exact_dup soft confirm on submit**

In the new-patient submit handler, before calling `createStaffAppointmentAction`, if any candidate has `tier === "exact_dup"` and the user hasn't acknowledged, block with a confirm:

```tsx
const hasExact = dupCandidates.some((c) => c.tier === "exact_dup");
if (hasExact && !window.confirm("This looks like an exact match for an existing patient. Create a SEPARATE record anyway?")) {
  return;
}
```
The create-anyway override is audit-logged server-side in Task 14 via an `ack_dup` flag passed to the action; if threading a flag is heavy here, rely on the server-side check in Task 14 instead and keep this as the client guard.

- [ ] **Step 4: Verify build**

Run: `npm run typecheck && npm run build`
Expected: compiles.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/appointments/new-appointment-sheet.tsx"
git commit -m "feat(dedup): near-match advisory in the + New appointment slide-over

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 13: Wire the warning into reception's `/staff/patients/new`

**Files:**
- Modify: the reception new-patient form (find it: `grep -rl "patients/new" src/app/(staff)` or look under `src/app/(staff)/staff/(dashboard)/patients/new/`). It is likely a client form component.

> READ the form first. Apply the same pattern as Task 12: debounced `checkPatientDuplicatesAction`, inline advisory listing matches with a "Use this patient" link that navigates to `/staff/patients/<id>` (reception flow doesn't have a sheet to switch — a link to the existing record is the right shortcut). Add the `exact_dup` soft confirm before submit.

- [ ] **Step 1: Add dup-check state + debounced effect** (same shape as Task 12, with field names from this form).

- [ ] **Step 2: Render inline advisory** — same component, but "Use this patient" is a `<Link href={\`/staff/patients/${c.id}\`}>` opening the existing record.

- [ ] **Step 3: exact_dup soft confirm** before the create submit (same `window.confirm` guard).

- [ ] **Step 4: Verify build**

Run: `npm run typecheck && npm run build`
Expected: compiles.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/patients/new"
git commit -m "feat(dedup): near-match advisory on reception new-patient form

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 14: Audit the create-anyway override (server-side)

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/appointments/new-appointment-actions.ts` (and the reception new-patient action found in Task 13).

> The reliable place to record `patient.create.dup_override` is server-side: right after `resolvePatient` returns `reused: false` (a NEW row was created), re-check for a same-tier match and, if an `exact_dup`/`strong` candidate exists, audit the override. This catches the override regardless of client behavior.

- [ ] **Step 1: After a NEW patient is created, audit if a strong/exact candidate existed**

In `new-appointment-actions.ts`, in the `mode === "new"` branch, after `resolvePatient` returns with `reused === false`:

```ts
if (!r.reused) {
  const { findCandidatesForInput } = await import("@/lib/patients/find-duplicates");
  const dupes = await findCandidatesForInput(admin, {
    first_name: data.patient.first_name,
    last_name: data.patient.last_name,
    birthdate: data.patient.birthdate ?? null,
    email: data.patient.email ?? null,
    phone_normalized: (data.patient.phone ?? "").replace(/\D/g, "").slice(-10) || null,
    address: null, sex: null,
    excludeId: r.id,
  }, { minTier: "strong" });
  if (dupes.length > 0) {
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      patient_id: r.id,
      action: "patient.create.dup_override",
      resource_type: "patient",
      resource_id: r.id,
      metadata: { created_drm_id: r.drm_id, matched: dupes.map((d) => ({ drm_id: d.patient.drm_id, tier: d.score.tier })) },
    });
  }
}
```
(Adapt field access to the validated `data` shape and the `session`/`admin`/`audit` already in scope. Apply the equivalent in the reception new-patient action.)

- [ ] **Step 2: Verify build**

Run: `npm run typecheck && npm run build`
Expected: compiles.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/appointments/new-appointment-actions.ts"
git commit -m "feat(dedup): audit create-anyway override when a strong match existed

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 7 — Public DRM-ID recovery (A)

### Task 15: Rate-limit bucket `patient_id_recovery`

**Files:**
- Modify: `src/lib/rate-limit/check.ts`

- [ ] **Step 1: Add the bucket to the union and budgets**

In `RateLimitBucket`, add `| "patient_id_recovery"`. In `RATE_LIMITS`, add:

```ts
  // Public DRM-ID recovery. Emails a DRM-ID to an on-file address only; 5/hour
  // per IP matches patient_registration / contact_form.
  patient_id_recovery: { windowSec: 60 * 60, max: 5 },
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/rate-limit/check.ts
git commit -m "feat(dedup): patient_id_recovery rate-limit bucket

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 16: Recovery schema + action

**Files:**
- Create: `src/app/(marketing)/find-my-id/schema.ts`
- Create: `src/app/(marketing)/find-my-id/actions.ts`
- Test: `src/app/(marketing)/find-my-id/schema.test.ts`

> READ `src/app/(marketing)/register/actions.ts` first (the matched-path email + audit pattern) and `src/lib/notifications/branded-email.ts` (`renderEmailShell`, `emailHighlight`, `emailParagraph`, `escapeHtml`) — this action mirrors the `/register` `res.reused` branch.

- [ ] **Step 1: Write the schema + a failing test**

```ts
// src/app/(marketing)/find-my-id/schema.ts
import { z } from "zod";

export const RecoverIdSchema = z.object({
  last_name: z.string().trim().min(1, "Enter your last name."),
  email: z.string().trim().toLowerCase().email("Enter a valid email."),
  birthdate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter your date of birth."),
  // honeypot — must be empty
  company: z.string().max(0).optional(),
});
export type RecoverIdInput = z.infer<typeof RecoverIdSchema>;
```

```ts
// src/app/(marketing)/find-my-id/schema.test.ts
import { describe, it, expect } from "vitest";
import { RecoverIdSchema } from "./schema";

describe("RecoverIdSchema", () => {
  it("accepts a valid payload", () => {
    expect(RecoverIdSchema.safeParse({ last_name: "Cruz", email: "A@X.com", birthdate: "1990-01-01" }).success).toBe(true);
  });
  it("lowercases the email", () => {
    const r = RecoverIdSchema.parse({ last_name: "Cruz", email: "A@X.com", birthdate: "1990-01-01" });
    expect(r.email).toBe("a@x.com");
  });
  it("rejects a filled honeypot", () => {
    expect(RecoverIdSchema.safeParse({ last_name: "Cruz", email: "a@x.com", birthdate: "1990-01-01", company: "bot" }).success).toBe(false);
  });
  it("rejects a bad date", () => {
    expect(RecoverIdSchema.safeParse({ last_name: "Cruz", email: "a@x.com", birthdate: "01/01/1990" }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/app/(marketing)/find-my-id/schema.test.ts`
Expected: FAIL (module not found) → then PASS once schema.ts exists.

- [ ] **Step 3: Write the action**

```ts
// src/app/(marketing)/find-my-id/actions.ts
"use server";
import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit/check";
import { sendEmail } from "@/lib/notifications/email";
import { renderEmailShell, emailParagraph, emailHighlight, escapeHtml } from "@/lib/notifications/branded-email";
import { RecoverIdSchema } from "./schema";

// Always returns the same neutral response — never reveals whether a record
// matched (enumeration safety).
export type RecoverResult = { ok: true } | { ok: false; error: string };

const NEUTRAL: RecoverResult = { ok: true };

export async function recoverDrmIdAction(_prev: RecoverResult | null, formData: FormData): Promise<RecoverResult> {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  const ua = h.get("user-agent");

  const limit = await checkRateLimit({ bucket: "patient_id_recovery", identifier: ip, ...RATE_LIMITS.patient_id_recovery });
  if (!limit.allowed) {
    return { ok: false, error: `Too many attempts. Try again in ${Math.ceil(limit.retryAfterSec / 60)} minutes.` };
  }

  const parsed = RecoverIdSchema.safeParse({
    last_name: formData.get("last_name"),
    email: formData.get("email"),
    birthdate: formData.get("birthdate"),
    company: formData.get("company") ?? undefined,
  });
  if (!parsed.success) {
    // Honeypot or malformed: respond neutrally to avoid probing, but don't email.
    return NEUTRAL;
  }
  const { last_name, email, birthdate } = parsed.data;

  const admin = createAdminClient();
  const { data: match } = await admin
    .from("patients")
    .select("id, drm_id, first_name")
    .eq("email", email)
    .eq("last_name", last_name)
    .eq("birthdate", birthdate)
    .is("merged_into_id", null)
    .limit(1)
    .maybeSingle();

  if (match) {
    const send = await sendEmail({
      to: email,
      subject: "Your DRMed DRM-ID",
      text: `Hi ${match.first_name},\n\nYour DRMed DRM-ID is ${match.drm_id}. Use it with your receipt PIN to view your results at drmed.ph/portal.\n\nIf you didn't request this, you can ignore this email.`,
      html: renderEmailShell({
        heading: "Your DRMed patient ID",
        contentHtml:
          emailParagraph(`Hi <b>${escapeHtml(match.first_name)}</b>,`) +
          emailParagraph("Here is the DRM-ID linked to your details:") +
          emailHighlight("Your DRM-ID", match.drm_id) +
          emailParagraph("Use it with your receipt PIN to view your results at drmed.ph/portal. If you didn't request this, you can ignore this email."),
        receivedNote: "You received this because someone requested a DRM-ID for this email at drmed.ph.",
      }),
    });
    await audit({
      actor_id: null, actor_type: "anonymous", patient_id: match.id,
      action: "patient.id_recovery.matched", resource_type: "patient", resource_id: match.id,
      metadata: { drm_id: match.drm_id, email: send.ok ? { ok: true, id: send.id, to: email } : send.kind === "skipped" ? { ok: false, skipped: true, reason: send.reason } : { ok: false, error: send.error, to: email } },
      ip_address: ip || null, user_agent: ua,
    });
  } else {
    await audit({
      actor_id: null, actor_type: "anonymous",
      action: "patient.id_recovery.no_match", resource_type: "patient",
      metadata: { attempted_email: email },
      ip_address: ip || null, user_agent: ua,
    });
  }

  return NEUTRAL;
}
```

- [ ] **Step 4: Run schema test + typecheck**

Run: `npx vitest run src/app/(marketing)/find-my-id/schema.test.ts && npm run typecheck`
Expected: PASS + no type errors. (Confirm `renderEmailShell` accepts `receivedNote` — grep `branded-email.ts`; adjust the option name if different.)

- [ ] **Step 5: Commit**

```bash
git add "src/app/(marketing)/find-my-id/schema.ts" "src/app/(marketing)/find-my-id/actions.ts" "src/app/(marketing)/find-my-id/schema.test.ts"
git commit -m "feat(dedup): public DRM-ID recovery action (enumeration-safe)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 17: Recovery page + form + entry links

**Files:**
- Create: `src/app/(marketing)/find-my-id/page.tsx`
- Create: `src/app/(marketing)/find-my-id/find-my-id-form.tsx`
- Modify: portal sign-in page + `/schedule` existing-patient path (add links)

> READ `src/app/(marketing)/register/register-form.tsx` for the controlled-input + `useActionState` pattern (React-19 form-reset gotcha: inputs MUST be controlled). Match marketing page chrome from a sibling marketing page.

- [ ] **Step 1: Write the form (controlled inputs, neutral success)**

```tsx
// src/app/(marketing)/find-my-id/find-my-id-form.tsx
"use client";
import { useActionState, useState } from "react";
import { recoverDrmIdAction, type RecoverResult } from "./actions";

export function FindMyIdForm() {
  const [state, action, pending] = useActionState<RecoverResult | null, FormData>(recoverDrmIdAction, null);
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [birthdate, setBirthdate] = useState("");

  if (state?.ok) {
    return (
      <p className="rounded-md bg-green-50 p-4 text-sm text-green-800">
        If a record matches those details, we've emailed the DRM-ID to that address. Check your inbox (and spam).
        No email on file? Please visit or call reception.
      </p>
    );
  }

  return (
    <form action={action} className="space-y-4">
      <input type="text" name="company" tabIndex={-1} autoComplete="off" className="hidden" aria-hidden />
      <label className="block text-sm">Last name
        <input required name="last_name" value={lastName} onChange={(e) => setLastName(e.target.value)} className="mt-1 w-full rounded border px-3 py-2" />
      </label>
      <label className="block text-sm">Email
        <input required type="email" name="email" value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1 w-full rounded border px-3 py-2" />
      </label>
      <label className="block text-sm">Date of birth
        <input required type="date" name="birthdate" value={birthdate} onChange={(e) => setBirthdate(e.target.value)} className="mt-1 w-full rounded border px-3 py-2" />
      </label>
      {state && !state.ok && <p className="text-sm text-red-600">{state.error}</p>}
      <button disabled={pending} className="rounded bg-cyan-600 px-4 py-2 font-semibold text-white disabled:opacity-50">
        {pending ? "Sending…" : "Email me my DRM-ID"}
      </button>
    </form>
  );
}
```

- [ ] **Step 2: Write the page** (match marketing page layout; include metadata + a short explainer)

```tsx
// src/app/(marketing)/find-my-id/page.tsx
import type { Metadata } from "next";
import { FindMyIdForm } from "./find-my-id-form";

export const metadata: Metadata = {
  title: "Find my DRM-ID · DRMed",
  description: "Recover your DRMed patient ID by email.",
  robots: { index: false }, // utility page, keep out of the index
};

export default function FindMyIdPage() {
  return (
    <main className="mx-auto max-w-md px-4 py-12">
      <h1 className="text-2xl font-bold">Find my DRM-ID</h1>
      <p className="mt-2 text-sm text-slate-600">
        Enter the details from your registration and we'll email your DRM-ID to your address on file.
      </p>
      <div className="mt-6"><FindMyIdForm /></div>
    </main>
  );
}
```

- [ ] **Step 3: Add entry links**

- On the **portal sign-in page** (find it: `grep -rl "drmed_patient_session\|DRM-ID" src/app/(patient)` or the portal login route), add under the sign-in form: `<Link href="/find-my-id" className="text-sm text-cyan-700 hover:underline">Forgot your DRM-ID?</Link>`.
- On the **`/schedule` existing-patient path** (`booking-form.tsx`, the existing-patient lookup section), add the same link near the DRM-ID input. Do NOT refactor `booking-form.tsx` — only add the link line.

- [ ] **Step 4: Verify build**

Run: `npm run typecheck && npm run build`
Expected: compiles; `/find-my-id` is in the route manifest.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(marketing)/find-my-id"
git commit -m "feat(dedup): /find-my-id recovery page + form + entry links

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 8 — Extras: dashboard card + weekly digest

### Task 18: Admin dashboard "Possible duplicates" card

**Files:**
- Modify: `src/lib/dashboards/cards.ts`
- Modify: the admin dashboard card data fetcher / renderer (find it: `grep -rl "admin.revenue_today\|DASHBOARD_CARDS\|cardsForRole" src/app/(staff)`).

> READ how an existing admin card (e.g. `admin.queue_total`) is wired from `cards.ts` → its count query → its `StatCard` render, and mirror it.

- [ ] **Step 1: Register the card**

In `cards.ts`, in the "Admin: Operations" block, add:

```ts
  { id: "admin.dup_candidates",    label: "Possible duplicates", roles: ["admin"], group: "operations" },
```

- [ ] **Step 2: Wire its count + link**

In the admin dashboard data layer, add a fetch that returns the open-candidate count and render a `StatCard` linking to the report:

```ts
import { createAdminClient } from "@/lib/supabase/admin";
import { loadCandidatePairs } from "@/lib/patients/find-duplicates";
// ...
const dupCandidates = (await loadCandidatePairs(createAdminClient(), { minTier: "probable" })).length;
```
Render (matching the existing StatCard usage):
```tsx
<StatCard label="Possible duplicates" value={dupCandidates} href="/staff/admin/patient-merge/candidates" />
```
(Use the exact StatCard prop names from the existing cards; add it under the `admin.dup_candidates` id guard so the card-prefs toggle works.)

- [ ] **Step 3: Verify build**

Run: `npm run typecheck && npm run build`
Expected: compiles.

- [ ] **Step 4: Commit**

```bash
git add src/lib/dashboards/cards.ts "src/app/(staff)"
git commit -m "feat(dedup): admin dashboard possible-duplicates card

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 19: Weekly digest cron

**Files:**
- Create: `src/app/api/cron/dedup-digest/route.ts`
- Modify: `vercel.json` (add the cron)

> Mirror `src/app/api/cron/appointment-reminders/route.ts`: GET, `Authorization: Bearer ${CRON_SECRET}`, `force-dynamic`, admin client, `reportError` on failure.

- [ ] **Step 1: Write the route**

```ts
// src/app/api/cron/dedup-digest/route.ts
import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/observability/report-error";
import { audit } from "@/lib/audit/log";
import { loadCandidatePairs } from "@/lib/patients/find-duplicates";
import { sendEmail } from "@/lib/notifications/email";
import { renderEmailShell, emailParagraph, emailButton } from "@/lib/notifications/branded-email";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = request.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const admin = createAdminClient();
  try {
    const pairs = await loadCandidatePairs(admin, { minTier: "probable" });
    const byTier = { exact_dup: 0, strong: 0, probable: 0 } as Record<string, number>;
    for (const p of pairs) if (p.score.tier) byTier[p.score.tier] = (byTier[p.score.tier] ?? 0) + 1;

    if (pairs.length === 0) {
      return Response.json({ candidates: 0, emailed: 0 });
    }

    const { data: admins } = await admin
      .from("staff_profiles")
      .select("email")
      .eq("role", "admin")
      .eq("active", true)
      .not("email", "is", null);
    const recipients = (admins ?? []).map((a) => a.email).filter(Boolean) as string[];

    const base = process.env.NEXT_PUBLIC_SITE_URL ?? "https://drmed.ph";
    const html = renderEmailShell({
      heading: "Possible duplicate patients",
      contentHtml:
        emailParagraph(`There are <b>${pairs.length}</b> possible duplicate patient pairs to review (${byTier.exact_dup ?? 0} exact, ${byTier.strong ?? 0} strong, ${byTier.probable ?? 0} probable).`) +
        emailButton("Review duplicates", `${base}/staff/admin/patient-merge/candidates`, "cyan"),
    });

    let emailed = 0;
    for (const to of recipients) {
      const r = await sendEmail({ to, subject: `DRMed: ${pairs.length} possible duplicate patients`, text: `${pairs.length} possible duplicate pairs to review at ${base}/staff/admin/patient-merge/candidates`, html });
      if (r.ok) emailed += 1;
    }
    await audit({ actor_id: null, actor_type: "system", action: "system.dedup_digest.sent", metadata: { candidates: pairs.length, by_tier: byTier, recipients: recipients.length, emailed } });
    return Response.json({ candidates: pairs.length, recipients: recipients.length, emailed });
  } catch (error) {
    await reportError({ scope: "cron/dedup-digest", error });
    return Response.json({ error: "failed" }, { status: 500 });
  }
}
```
(Confirm `staff_profiles` has `email` + `active` columns + `role`; grep `staff_profiles` select usages — adjust the active/email column names to match. Confirm `emailButton` signature in `branded-email.ts`.)

- [ ] **Step 2: Add the cron to `vercel.json`**

Add to the `crons` array:
```json
    { "path": "/api/cron/dedup-digest", "schedule": "0 1 * * 1" }
```
(01:00 UTC Monday = 09:00 Manila Monday.)

- [ ] **Step 3: Verify build + local hit**

Run: `npm run typecheck && npm run build`
Expected: compiles. Locally, hit `GET /api/cron/dedup-digest` with `Authorization: Bearer <CRON_SECRET>` → returns a JSON summary (200) or `{candidates:0}`.

- [ ] **Step 4: Commit**

```bash
git add "src/app/api/cron/dedup-digest/route.ts" vercel.json
git commit -m "feat(dedup): weekly possible-duplicates email digest cron

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 9 — Final verification

### Task 20: Full suite + smoke + push

- [ ] **Step 1: Run the whole gate**

Run: `npm run lint && npm run typecheck && npm test && npm run build`
Expected: lint clean, no type errors, all vitest pass (incl. `duplicates.test.ts`, `schema.test.ts`), build succeeds.

- [ ] **Step 2: Local UI smoke** (local stack via `scripts/supabase-local.sh`; see the local/prod smoke recipes in memory). Verify:
  - Seed two near-duplicate patients (same email, name typo) → `/staff/admin/patient-merge/candidates` lists the pair as `strong`/`exact_dup` with signal chips.
  - Click "Merge into DRM-…" → pair disappears, "Recently merged" shows it → click "Undo" → the source patient is restored (visits/appointments re-pointed; `merged_into_id` cleared).
  - In `+ New appointment` → New patient, type a matching name+email → inline advisory appears; "Use this patient" switches to Existing.
  - `/find-my-id`: matching details → neutral success + email sent (check Resend/inbucket); non-matching → identical neutral message.
  - `GET /api/cron/dedup-digest` with the bearer → JSON summary.

- [ ] **Step 3: Push the branch**

```bash
git push -u origin feat/patient-dedup-hardening
```

> Migrations apply to prod via Supabase MCP at rollout (not in CI); then `npm run db:types`. See §15 of the spec for the rollout + legacy-cleanup runbook.

---

## Self-review notes (author)

- **Spec coverage:** scorer §4→T1-2; phone-normalize §5a→T3; view §5b→T4; report D §6→T9-10; staff warning C §7→T11-14; recovery A §8→T15-17; phone signal B §9→T2 (folded into scorePair); merge undo §10.5→T5,T7-8; dashboard card §10.3→T18; weekly digest §10.4→T19; legacy backlog §10.1→spec §15 runbook (operational, no task); rate-limit/audit §12→T15,T14,T16,T8,T19. All covered.
- **Deviation from spec:** the candidate view drops the standalone trigram cross-join for performance (equality blocking only); `fuzzy_name` is still scored for pairs caught by equality blocks. Documented in Task 4. Update spec §5b if desired.
- **Type consistency:** `CandidateFields`, `DupScore`, `DupTier`, `DupSignal` defined in T1-2 and consumed unchanged in `find-duplicates.ts` (T6), the check action (T11), report (T10). `scorePair`, `loadCandidatePairs`, `findCandidatesForInput`, `mergeCandidateAction`, `undoMergeAction`, `loadRecentMerges`, `checkPatientDuplicatesAction`, `recoverDrmIdAction` names are used consistently across tasks.
