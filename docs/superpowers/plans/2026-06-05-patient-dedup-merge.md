# Patient De-dup / Merge Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse duplicate `patients` rows (from the v1.11.0 CUSTOMER_LIST2 import) into one canonical record each, conservatively and auditably, so the Marketing pack's customer counts are accurate and the held clinical backfill rows auto-attach on a re-run.

**Architecture:** A standalone script package `scripts/patient-dedup/`, mirroring the existing `scripts/clinical-enrich/` engine: a pure, unit-tested core (`normalize` → `cluster` → `plan`) plus an I/O engine on the Supabase service-role client with a dry-run-gated CLI. Clustering is strictly by `matchKey` (surname + first given token) so families on a shared phone are never joined. Auto-merge only at high confidence (name+DOB / name+phone / name+email, with DOB/sex conflict guards); everything else goes to a review CSV.

**Tech Stack:** TypeScript (strict), `tsx` runner, `@supabase/supabase-js` service-role client, `vitest` for pure-logic tests. Reuses `scripts/clinical-backfill/lib/names.ts` (`matchKey`), `scripts/clinical-backfill/report.ts` (`writeCsv`), `scripts/lib/env-guard.ts` (`requireLocalOrExplicitProd`).

**Spec:** `docs/superpowers/specs/2026-06-05-patient-dedup-merge-design.md`

---

## File Structure

```
scripts/patient-dedup/
  index.ts            # CLI entry — calls engine.run()
  engine.ts           # I/O: load rows + visit counts, build plan, dry-run CSVs, commit merges
  validate.sql        # post-run verification queries
  lib/
    types.ts          # shared PatientRow / ClusterPlan / Tier types (no behavior)
    normalize.ts      # re-export matchKey/normalizeName; phoneKey, emailKey
    normalize.test.ts
    cluster.ts        # (pure) group live patients by matchKey
    cluster.test.ts
    plan.ts           # (pure) pickCanonical + classify → ClusterPlan
    plan.test.ts
```
Plus one line added to `package.json` scripts.

---

### Task 1: Normalizers (`lib/normalize.ts`)

**Files:**
- Create: `scripts/patient-dedup/lib/normalize.ts`
- Test: `scripts/patient-dedup/lib/normalize.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// scripts/patient-dedup/lib/normalize.test.ts
import { describe, it, expect } from "vitest";
import { phoneKey, emailKey, matchKey } from "./normalize";

describe("phoneKey", () => {
  it("strips non-digits", () => {
    expect(phoneKey("0917-123 4567")).toBe("09171234567");
  });
  it("returns null for too-short / empty / nullish", () => {
    expect(phoneKey("123")).toBeNull();
    expect(phoneKey("")).toBeNull();
    expect(phoneKey(null)).toBeNull();
    expect(phoneKey(undefined)).toBeNull();
  });
});

describe("emailKey", () => {
  it("lowercases and trims", () => {
    expect(emailKey("  Foo@Bar.COM ")).toBe("foo@bar.com");
  });
  it("returns null for empty / nullish", () => {
    expect(emailKey("   ")).toBeNull();
    expect(emailKey(null)).toBeNull();
  });
});

describe("matchKey re-export", () => {
  it("is the backfill matcher (surname + first given token)", () => {
    expect(matchKey("Blancaflor", "Elmer Jr")).toBe("blancaflor|elmer");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/patient-dedup/lib/normalize.test.ts`
Expected: FAIL — `Cannot find module './normalize'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// scripts/patient-dedup/lib/normalize.ts
// Keep the name key IDENTICAL to the backfill matcher so this pass dissolves
// exactly the rows the backfill held as ambiguous.
export { matchKey, normalizeName } from "../../clinical-backfill/lib/names";

/** Digits-only phone key; null if fewer than 7 digits. */
export function phoneKey(raw: string | null | undefined): string | null {
  const d = (raw ?? "").replace(/\D/g, "");
  return d.length >= 7 ? d : null;
}

/** Lowercased, trimmed email key; null if empty. */
export function emailKey(raw: string | null | undefined): string | null {
  const e = (raw ?? "").trim().toLowerCase();
  return e === "" ? null : e;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/patient-dedup/lib/normalize.test.ts`
Expected: PASS (3 suites).

- [ ] **Step 5: Commit**

```bash
git add scripts/patient-dedup/lib/normalize.ts scripts/patient-dedup/lib/normalize.test.ts
git commit -m "feat(dedup): patient normalizers (phone/email keys, matchKey re-export)"
```

---

### Task 2: Types + name clustering (`lib/types.ts`, `lib/cluster.ts`)

**Files:**
- Create: `scripts/patient-dedup/lib/types.ts`
- Create: `scripts/patient-dedup/lib/cluster.ts`
- Test: `scripts/patient-dedup/lib/cluster.test.ts`

- [ ] **Step 1: Create the shared types (no behavior — no test)**

```typescript
// scripts/patient-dedup/lib/types.ts
export interface PatientRow {
  id: string;
  drm_id: string;
  first_name: string | null;
  last_name: string | null;
  middle_name: string | null;
  sex: string | null;
  phone: string | null;
  email: string | null;
  birthdate: string | null;   // ISO date (YYYY-MM-DD) or null
  address: string | null;
  created_at: string;          // ISO timestamp
  visit_count: number;
}

export type Tier = "name+dob" | "name+phone" | "name+email";
export type ReviewReason = "name-only" | "dob-conflict" | "sex-conflict";

export interface ClusterPlan {
  canonical: PatientRow;
  auto: Array<{ row: PatientRow; tier: Tier }>;
  review: Array<{ row: PatientRow; reason: ReviewReason }>;
}
```

- [ ] **Step 2: Write the failing test**

```typescript
// scripts/patient-dedup/lib/cluster.test.ts
import { describe, it, expect } from "vitest";
import { clusterByName } from "./cluster";
import type { PatientRow } from "./types";

function p(over: Partial<PatientRow>): PatientRow {
  return {
    id: over.id ?? "x", drm_id: over.drm_id ?? "DRM-0001",
    first_name: over.first_name ?? null, last_name: over.last_name ?? null,
    middle_name: over.middle_name ?? null, sex: over.sex ?? null,
    phone: over.phone ?? null, email: over.email ?? null,
    birthdate: over.birthdate ?? null, address: over.address ?? null,
    created_at: over.created_at ?? "2025-01-01T00:00:00Z",
    visit_count: over.visit_count ?? 0,
  };
}

describe("clusterByName", () => {
  it("groups rows with the same matchKey", () => {
    const rows = [
      p({ id: "a", last_name: "Blancaflor", first_name: "Elmer" }),
      p({ id: "b", last_name: "Blancaflor", first_name: "Elmer Jr" }),
      p({ id: "c", last_name: "Blancaflor", first_name: "Elmer" }),
    ];
    const clusters = clusterByName(rows);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].map((r) => r.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("does NOT join different surnames sharing a phone (families)", () => {
    const rows = [
      p({ id: "mom", last_name: "Reyes", first_name: "Ana", phone: "09170000000" }),
      p({ id: "kid", last_name: "Reyes-Cruz", first_name: "Ben", phone: "09170000000" }),
    ];
    expect(clusterByName(rows)).toHaveLength(0);
  });

  it("excludes singletons", () => {
    const rows = [
      p({ id: "a", last_name: "Solo", first_name: "Han" }),
      p({ id: "b", last_name: "Blancaflor", first_name: "Elmer" }),
      p({ id: "c", last_name: "Blancaflor", first_name: "Elmer" }),
    ];
    const clusters = clusterByName(rows);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toHaveLength(2);
  });

  it("skips rows with empty name key", () => {
    const rows = [
      p({ id: "a", last_name: null, first_name: null }),
      p({ id: "b", last_name: "", first_name: "" }),
    ];
    expect(clusterByName(rows)).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run scripts/patient-dedup/lib/cluster.test.ts`
Expected: FAIL — `Cannot find module './cluster'`.

- [ ] **Step 4: Write minimal implementation**

```typescript
// scripts/patient-dedup/lib/cluster.ts
import { matchKey } from "./normalize";
import type { PatientRow } from "./types";

export type Cluster = PatientRow[];

/** Group live patients strictly by matchKey. A cluster is any name key shared by
 *  >= 2 rows. Corroborating signals (DOB/phone/email) are NOT used here — that is
 *  plan.ts's job. Different surnames -> different keys -> never joined, so a shared
 *  family phone can never pull two different people into one cluster. */
export function clusterByName(rows: PatientRow[]): Cluster[] {
  const groups = new Map<string, PatientRow[]>();
  for (const r of rows) {
    const k = matchKey(r.last_name ?? "", r.first_name ?? "");
    if (!k) continue;
    const arr = groups.get(k);
    if (arr) arr.push(r);
    else groups.set(k, [r]);
  }
  return [...groups.values()].filter((g) => g.length >= 2);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run scripts/patient-dedup/lib/cluster.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add scripts/patient-dedup/lib/types.ts scripts/patient-dedup/lib/cluster.ts scripts/patient-dedup/lib/cluster.test.ts
git commit -m "feat(dedup): shared types + matchKey clustering"
```

---

### Task 3: Canonical selection + classification (`lib/plan.ts`)

**Files:**
- Create: `scripts/patient-dedup/lib/plan.ts`
- Test: `scripts/patient-dedup/lib/plan.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// scripts/patient-dedup/lib/plan.test.ts
import { describe, it, expect } from "vitest";
import { pickCanonical, planCluster, completeness } from "./plan";
import type { PatientRow } from "./types";

function p(over: Partial<PatientRow>): PatientRow {
  return {
    id: over.id ?? "x", drm_id: over.drm_id ?? "DRM-0001",
    first_name: over.first_name ?? "Elmer", last_name: over.last_name ?? "Blancaflor",
    middle_name: over.middle_name ?? null, sex: over.sex ?? null,
    phone: over.phone ?? null, email: over.email ?? null,
    birthdate: over.birthdate ?? null, address: over.address ?? null,
    created_at: over.created_at ?? "2025-01-01T00:00:00Z",
    visit_count: over.visit_count ?? 0,
  };
}

describe("pickCanonical", () => {
  it("prefers most visits, then most complete, then oldest", () => {
    const most = p({ id: "v", visit_count: 3, created_at: "2025-06-01T00:00:00Z" });
    const complete = p({ id: "c", visit_count: 0, phone: "09170000000", email: "a@b.com", birthdate: "1990-01-01" });
    const old = p({ id: "o", visit_count: 0, created_at: "2024-01-01T00:00:00Z" });
    expect(pickCanonical([complete, old, most]).id).toBe("v");
    expect(pickCanonical([old, complete]).id).toBe("c");      // complete beats older
    const oldA = p({ id: "oa", created_at: "2024-01-01T00:00:00Z" });
    const oldB = p({ id: "ob", created_at: "2025-01-01T00:00:00Z" });
    expect(pickCanonical([oldB, oldA]).id).toBe("oa");        // oldest wins
  });
  it("tie-breaks equal timestamps by lowest DRM number", () => {
    const a = p({ id: "a", drm_id: "DRM-1838" });
    const b = p({ id: "b", drm_id: "DRM-1837" });
    expect(pickCanonical([a, b]).id).toBe("b");
  });
});

describe("classify via planCluster", () => {
  const canon = p({ id: "canon", drm_id: "DRM-0001", birthdate: "1990-05-05", sex: "F", phone: "09171112222", email: "x@y.com", created_at: "2024-01-01T00:00:00Z" });

  it("Tier 1: same DOB -> auto name+dob", () => {
    const m = p({ id: "m", birthdate: "1990-05-05" });
    const plan = planCluster([canon, m]);
    expect(plan.canonical.id).toBe("canon");
    expect(plan.auto).toEqual([{ row: expect.objectContaining({ id: "m" }), tier: "name+dob" }]);
  });
  it("Tier 2: same phone, no DOB on member -> auto name+phone", () => {
    const m = p({ id: "m", phone: "09171112222" });
    expect(planCluster([canon, m]).auto[0].tier).toBe("name+phone");
  });
  it("Tier 2': same email only -> auto name+email", () => {
    const m = p({ id: "m", email: "X@Y.com" });
    expect(planCluster([canon, m]).auto[0].tier).toBe("name+email");
  });
  it("DOB conflict -> review dob-conflict (even if phone matches)", () => {
    const m = p({ id: "m", birthdate: "1991-01-01", phone: "09171112222" });
    expect(planCluster([canon, m]).review).toEqual([{ row: expect.objectContaining({ id: "m" }), reason: "dob-conflict" }]);
  });
  it("sex conflict -> review sex-conflict", () => {
    const m = p({ id: "m", sex: "M", phone: "09171112222" });
    expect(planCluster([canon, m]).review[0].reason).toBe("sex-conflict");
  });
  it("name-only (no corroboration) -> review name-only", () => {
    const m = p({ id: "m" });
    expect(planCluster([canon, m]).review[0].reason).toBe("name-only");
  });
  it("mixed cluster: true dup auto-merges, odd member -> review (partial)", () => {
    const dup = p({ id: "dup", birthdate: "1990-05-05" });
    const odd = p({ id: "odd", birthdate: "1977-12-12" });
    const plan = planCluster([canon, dup, odd]);
    expect(plan.auto.map((a) => a.row.id)).toEqual(["dup"]);
    expect(plan.review.map((r) => r.row.id)).toEqual(["odd"]);
  });
});

describe("completeness", () => {
  it("counts populated optional fields", () => {
    expect(completeness(p({ phone: "1", email: "a@b.com" }))).toBe(2);
    expect(completeness(p({}))).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/patient-dedup/lib/plan.test.ts`
Expected: FAIL — `Cannot find module './plan'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// scripts/patient-dedup/lib/plan.ts
import { phoneKey, emailKey } from "./normalize";
import type { PatientRow, ClusterPlan, Tier, ReviewReason } from "./types";

/** Number of populated optional fields — the completeness tiebreak. */
export function completeness(r: PatientRow): number {
  return [r.phone, r.email, r.birthdate, r.sex, r.address, r.middle_name]
    .filter((v) => v != null && String(v).trim() !== "").length;
}

function drmNum(r: PatientRow): number {
  const m = /(\d+)/.exec(r.drm_id ?? "");
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

/** most visits -> most complete -> oldest created_at -> lowest DRM number. */
export function pickCanonical(cluster: PatientRow[]): PatientRow {
  return [...cluster].sort((a, b) => {
    if (b.visit_count !== a.visit_count) return b.visit_count - a.visit_count;
    const ca = completeness(a), cb = completeness(b);
    if (cb !== ca) return cb - ca;
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
    return drmNum(a) - drmNum(b);
  })[0];
}

type Verdict =
  | { action: "auto"; tier: Tier }
  | { action: "review"; reason: ReviewReason };

/** Classify a cluster member against the canonical row. Name already matches
 *  (clustering is by matchKey). Hard conflict guards run first. */
function classify(member: PatientRow, canon: PatientRow): Verdict {
  if (member.birthdate && canon.birthdate && member.birthdate !== canon.birthdate)
    return { action: "review", reason: "dob-conflict" };
  if (member.sex && canon.sex && member.sex !== canon.sex)
    return { action: "review", reason: "sex-conflict" };

  if (member.birthdate && canon.birthdate && member.birthdate === canon.birthdate)
    return { action: "auto", tier: "name+dob" };
  const mp = phoneKey(member.phone), cp = phoneKey(canon.phone);
  if (mp && cp && mp === cp) return { action: "auto", tier: "name+phone" };
  const me = emailKey(member.email), ce = emailKey(canon.email);
  if (me && ce && me === ce) return { action: "auto", tier: "name+email" };

  return { action: "review", reason: "name-only" };
}

export function planCluster(cluster: PatientRow[]): ClusterPlan {
  const canonical = pickCanonical(cluster);
  const auto: ClusterPlan["auto"] = [];
  const review: ClusterPlan["review"] = [];
  for (const r of cluster) {
    if (r.id === canonical.id) continue;
    const v = classify(r, canonical);
    if (v.action === "auto") auto.push({ row: r, tier: v.tier });
    else review.push({ row: r, reason: v.reason });
  }
  return { canonical, auto, review };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/patient-dedup/lib/plan.test.ts`
Expected: PASS (all `describe` blocks green).

- [ ] **Step 5: Commit**

```bash
git add scripts/patient-dedup/lib/plan.ts scripts/patient-dedup/lib/plan.test.ts
git commit -m "feat(dedup): canonical selection + tier classification"
```

---

### Task 4: Engine — load, plan, dry-run reporting (`engine.ts`)

**Files:**
- Create: `scripts/patient-dedup/engine.ts`
- Create: `scripts/patient-dedup/index.ts`
- Modify: `package.json` (add `dedup:patients` script)

> This task is I/O glue around the tested core. There is no unit test; it is verified by a **read-only dry-run against prod** in Step 5.

- [ ] **Step 1: Write the engine (dry-run path complete; commit path stubbed for Task 5)**

```typescript
// scripts/patient-dedup/engine.ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../src/types/database";
import { requireLocalOrExplicitProd } from "../lib/env-guard";
import { writeCsv } from "../clinical-backfill/report";
import { clusterByName } from "./lib/cluster";
import { planCluster } from "./lib/plan";
import type { PatientRow, ClusterPlan } from "./lib/types";

interface Args { commit: boolean; confirmed: boolean; }
export function parseArgs(): Args {
  const argv = process.argv.slice(2);
  return {
    commit: argv.includes("--commit"),
    confirmed: argv.includes('--confirm="I-mean-it"') || argv.includes("--confirm=I-mean-it"),
  };
}

function adminClient(): SupabaseClient<Database> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error("NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required."); process.exit(2); }
  return createClient<Database>(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function fetchAll<T>(q: (from: number, to: number) => Promise<T[]>): Promise<T[]> {
  const out: T[] = []; let from = 0; const page = 1000;
  for (;;) { const b = await q(from, from + page - 1); out.push(...b); if (b.length < page) break; from += page; }
  return out;
}

async function loadRows(admin: SupabaseClient<Database>): Promise<PatientRow[]> {
  const patients = await fetchAll(async (from, to) => {
    const { data, error } = await admin
      .from("patients")
      .select("id, drm_id, first_name, last_name, middle_name, sex, phone, email, birthdate, address, created_at")
      .is("merged_into_id", null)
      .order("id")
      .range(from, to);
    if (error) throw new Error(`load patients: ${error.message}`);
    return data ?? [];
  });

  // Visit counts: fetch all visit patient_ids and tally in JS (no group-by in the JS client).
  const visitRows = await fetchAll(async (from, to) => {
    const { data, error } = await admin.from("visits").select("patient_id").order("id").range(from, to);
    if (error) throw new Error(`load visits: ${error.message}`);
    return data ?? [];
  });
  const counts = new Map<string, number>();
  for (const v of visitRows) {
    if (v.patient_id) counts.set(v.patient_id, (counts.get(v.patient_id) ?? 0) + 1);
  }

  return patients.map((p) => ({ ...p, visit_count: counts.get(p.id) ?? 0 }));
}

function summarize(plans: ClusterPlan[]): void {
  const clusters = plans.length;
  const autoMerges = plans.reduce((n, p) => n + p.auto.length, 0);
  const reviews = plans.reduce((n, p) => n + p.review.length, 0);
  const byTier: Record<string, number> = {};
  const byReason: Record<string, number> = {};
  for (const p of plans) {
    for (const a of p.auto) byTier[a.tier] = (byTier[a.tier] ?? 0) + 1;
    for (const r of p.review) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
  }
  console.log(`\nClusters with duplicates: ${clusters}`);
  console.log(`Auto-merge sources:       ${autoMerges}`, byTier);
  console.log(`Review sources:           ${reviews}`, byReason);
}

async function writeReports(plans: ClusterPlan[]): Promise<void> {
  const autoRows: string[][] = [];
  const reviewRows: string[][] = [];
  for (const p of plans) {
    for (const a of p.auto) {
      autoRows.push([p.canonical.drm_id, p.canonical.id, a.row.drm_id, a.row.id, a.tier,
        `${a.row.last_name ?? ""}, ${a.row.first_name ?? ""}`, a.row.birthdate ?? "", a.row.phone ?? ""]);
    }
    for (const r of p.review) {
      reviewRows.push([p.canonical.drm_id, p.canonical.id, r.row.drm_id, r.row.id, r.reason,
        `${r.row.last_name ?? ""}, ${r.row.first_name ?? ""}`, r.row.birthdate ?? "", r.row.phone ?? ""]);
    }
  }
  const head = ["keep_drm", "keep_id", "source_drm", "source_id", "tier_or_reason", "source_name", "source_dob", "source_phone"];
  const autoPath = await writeCsv("patient-dedup-auto-plan", head, autoRows);
  const reviewPath = await writeCsv("patient-dedup-review", head, reviewRows);
  console.log(`\nAuto-merge plan: ${autoPath}`);
  console.log(`Review pile:     ${reviewPath}`);
}

export async function run(): Promise<void> {
  const args = parseArgs();
  if (args.commit && !args.confirmed) {
    console.error('\n--commit requires --confirm="I-mean-it".'); process.exit(3);
  }
  if (args.commit) requireLocalOrExplicitProd("dedup:patients");

  const admin = adminClient();
  const rows = await loadRows(admin);
  console.log(`Loaded ${rows.length} live patients.`);

  const plans = clusterByName(rows).map(planCluster).filter((p) => p.auto.length + p.review.length > 0);
  summarize(plans);
  await writeReports(plans);

  if (!args.commit) {
    console.log(`\nDry-run. To commit against prod: npm run dedup:patients -- --commit --confirm="I-mean-it" --prod\n`);
    return;
  }

  await commitMerges(admin, plans); // implemented in Task 5
}

// --- commit path (Task 5 fills this in) ---
async function commitMerges(_admin: SupabaseClient<Database>, _plans: ClusterPlan[]): Promise<void> {
  throw new Error("commitMerges not implemented yet");
}
```

- [ ] **Step 2: Write the CLI entry**

```typescript
// scripts/patient-dedup/index.ts
import { run } from "./engine";

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 3: Add the npm script**

In `package.json`, in `"scripts"`, after the `enrich:clinical` line, add:

```json
    "dedup:patients": "tsx --env-file=.env.local scripts/patient-dedup/index.ts",
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors in `scripts/patient-dedup/`).

- [ ] **Step 5: Read-only dry-run against prod**

Run: `npm run dedup:patients`
Expected: prints `Loaded ~7015 live patients.`, a cluster summary (auto by tier, review by reason), and writes two CSVs under `tmp/`. **No writes occur** (no `--commit`). Sanity-check against spec grounding facts: auto sources should be on the order of the ~241 high-confidence dup rows; review should hold the name-only remainder.

- [ ] **Step 6: Commit**

```bash
git add scripts/patient-dedup/engine.ts scripts/patient-dedup/index.ts package.json
git commit -m "feat(dedup): engine load + dry-run reporting + CLI"
```

---

### Task 5: Engine — the merge commit path (`commitMerges` + `mergeOne`)

**Files:**
- Modify: `scripts/patient-dedup/engine.ts` (replace the `commitMerges` stub; add `mergeOne`)

- [ ] **Step 1: Replace the stub with the real commit path**

In `scripts/patient-dedup/engine.ts`, replace the `commitMerges` stub block with:

```typescript
// Tables that carry patients(id) FKs — ALL of them. The admin merge Server Action
// currently misses critical_alerts + patient_consents; this pass must not.
const FK_TABLES = ["visits", "appointments", "audit_log", "critical_alerts", "patient_consents"] as const;
const FILL_FIELDS = ["middle_name", "sex", "phone", "email", "address", "birthdate"] as const;

async function mergeOne(
  admin: SupabaseClient<Database>,
  canonical: PatientRow,
  source: PatientRow,
  tier: string,
): Promise<void> {
  // Idempotent: skip a source already tombstoned (re-run safe).
  const { data: cur, error: curErr } = await admin
    .from("patients").select("merged_into_id").eq("id", source.id).maybeSingle();
  if (curErr) throw new Error(`recheck ${source.id}: ${curErr.message}`);
  if (!cur || cur.merged_into_id) return;

  // 1. Reassign every patient_id FK. `as never` because the payload type differs
  //    per table in the generated union; patient_id is uuid on all of them.
  const moved: Record<string, number> = {};
  for (const table of FK_TABLES) {
    const { data, error } = await admin.from(table)
      .update({ patient_id: canonical.id } as never)
      .eq("patient_id", source.id)
      .select("id");
    if (error) throw new Error(`reassign ${table} (${source.drm_id}): ${error.message}`);
    moved[table] = data?.length ?? 0;
  }

  // 2. Collapse any existing tombstone chain pointing at the source.
  const { error: chainErr } = await admin.from("patients")
    .update({ merged_into_id: canonical.id })
    .eq("merged_into_id", source.id);
  if (chainErr) throw new Error(`repoint chain (${source.drm_id}): ${chainErr.message}`);

  // 3. Fill missing fields on the canonical from the source — never overwrite.
  const fill: Record<string, string> = {};
  for (const f of FILL_FIELDS) {
    if (!canonical[f] && source[f]) fill[f] = source[f] as string;
  }
  if (Object.keys(fill).length > 0) {
    const { error } = await admin.from("patients").update(fill as never).eq("id", canonical.id);
    if (error) throw new Error(`fill canonical (${canonical.drm_id}): ${error.message}`);
    Object.assign(canonical, fill); // keep in-memory canonical current for the next source in the cluster
  }

  // 4. Tombstone the source.
  const { error: tombErr } = await admin.from("patients")
    .update({ merged_into_id: canonical.id, merged_at: new Date().toISOString() })
    .eq("id", source.id);
  if (tombErr) throw new Error(`tombstone (${source.drm_id}): ${tombErr.message}`);

  // 5. Audit (audit() is server-only, so insert directly with the AuditEntry shape).
  const { error: auditErr } = await admin.from("audit_log").insert({
    actor_id: null,
    actor_type: "system",
    patient_id: canonical.id,
    action: "patient.merged",
    resource_type: "patient",
    resource_id: canonical.id,
    metadata: { kept_drm_id: canonical.drm_id, merged_drm_id: source.drm_id, merged_patient_id: source.id, tier, moved },
    ip_address: null,
    user_agent: null,
  });
  if (auditErr) throw new Error(`audit (${source.drm_id}): ${auditErr.message}`);
}

async function commitMerges(admin: SupabaseClient<Database>, plans: ClusterPlan[]): Promise<void> {
  let merged = 0;
  for (const plan of plans) {
    for (const m of plan.auto) {
      await mergeOne(admin, plan.canonical, m.row, m.tier);
      merged++;
    }
  }
  console.log(`\nCommitted ${merged} merge(s). Review pile left untouched (manual via admin UI).`);
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Re-run the existing unit tests (no regressions)**

Run: `npx vitest run scripts/patient-dedup`
Expected: PASS (normalize + cluster + plan suites).

- [ ] **Step 4: Commit**

```bash
git add scripts/patient-dedup/engine.ts
git commit -m "feat(dedup): merge commit path — reassign all 5 FK tables, fill, tombstone, audit"
```

---

### Task 6: Validation SQL (`validate.sql`)

**Files:**
- Create: `scripts/patient-dedup/validate.sql`

- [ ] **Step 1: Write the validation queries**

```sql
-- scripts/patient-dedup/validate.sql
-- Run after committing the de-dup pass (via Supabase MCP / psql against prod).

-- 1. Live vs tombstoned patient counts.
select
  count(*) filter (where merged_into_id is null) as live_patients,
  count(*) filter (where merged_into_id is not null) as tombstoned;

-- 2. High-confidence duplicate clusters remaining (expect ~0 after the pass).
with live as (
  select id,
         lower(regexp_replace(coalesce(last_name,'')||'|'||coalesce(first_name,''),'\s+','','g')) as namekey,
         birthdate,
         nullif(regexp_replace(coalesce(phone,''),'\D','','g'),'') as phonekey
  from patients where merged_into_id is null
)
select
  (select count(*) from (select namekey,birthdate from live where namekey<>'|' and birthdate is not null group by 1,2 having count(*)>1) x) as namedob_clusters_remaining,
  (select count(*) from (select namekey,phonekey from live where namekey<>'|' and phonekey is not null and length(phonekey)>=7 group by 1,2 having count(*)>1) x) as namephone_clusters_remaining;

-- 3. Audit rows written by this pass.
select count(*) as patient_merged_audit_rows
from audit_log where action = 'patient.merged' and actor_type = 'system';

-- 4. GL-silence: this pass writes no journal entries. Expect 0 new JE lines
--    referencing a merged patient's visits beyond what existed pre-pass.
--    (Re-use the backfill/enrich GL-silence assertion — the merge touches no
--    payments/test_requests status, so the 0091 guard has nothing to fire on.)
select count(*) as je_rows_total from journal_entries;  -- record before/after; expect unchanged by the merge step itself
```

- [ ] **Step 2: Commit**

```bash
git add scripts/patient-dedup/validate.sql
git commit -m "feat(dedup): post-run validation SQL"
```

---

### Task 7: Operational run (dry-run review → commit → re-attach → enrich → validate)

> **Human-in-the-loop. Not for an autonomous subagent.** This task writes to prod. Do not run `--commit` until a human has eyeballed the dry-run CSVs.

**Files:** none (operational).

- [ ] **Step 1: Dry-run and review the CSVs**

Run: `npm run dedup:patients`
Then open `tmp/patient-dedup-auto-plan-*.csv` and `tmp/patient-dedup-review-*.csv`. Spot-check 10–15 auto rows: each `tier` should make sense (matching DOB/phone/email), and no two rows that are obviously different people. **Get the user's explicit go-ahead before Step 2.**

- [ ] **Step 2: Commit the merges to prod**

Run: `npm run dedup:patients -- --commit --confirm="I-mean-it" --prod`
Expected: `Committed N merge(s).` with no thrown errors. If it throws partway, re-running is safe (idempotent) — already-tombstoned sources are skipped.

- [ ] **Step 3: Re-attach the held clinical backfill rows**

Run:
```bash
npm run backfill:clinical:consult -- --commit --confirm="I-mean-it" --prod
npm run backfill:clinical:lab     -- --commit --confirm="I-mean-it" --prod
```
Expected: the previously-held ambiguous consults/lab tests now match a single patient and attach. Note the counts attached.

- [ ] **Step 4: Re-attribute doctor/discount on the newly-attached visits**

Run: `npm run enrich:clinical -- --commit --confirm="I-mean-it" --prod`
Expected: doctor + discount-type set on the newly-attached legacy visits. GL-silent.

- [ ] **Step 5: Validate**

Run `scripts/patient-dedup/validate.sql` against prod (via the Supabase MCP `execute_sql`). Confirm: tombstoned count ≈ committed merges; high-confidence clusters remaining ≈ 0; `patient.merged` audit rows ≈ committed merges; `journal_entries` count unchanged by the merge step (GL-silent).

- [ ] **Step 6: Update the project memory**

Update `project_ops_analytics_dashboard.md`: mark the de-dup prerequisite DONE with the merge/attach counts, note the remaining review-pile size, and that Part B is now unblocked.

---

## Notes for the implementer

- **Do not** import `@/lib/supabase/admin` or `@/lib/audit/log` into any script file — both are `server-only` and will throw under `tsx`. The engine builds its own `createClient` and inserts `audit_log` rows directly (Task 5).
- **Keep `matchKey` sourced from the backfill** (`normalize.ts` re-exports it). If you ever need to change name normalization, change it in `scripts/clinical-backfill/lib/names.ts` so the backfill and this pass never diverge.
- **No new migration** — `merged_into_id` / `merged_at` already exist (migration 0025).
- The `--prod` flag (or `SEED_ALLOW_PROD=1`) is **required** for any write, because `.env.local` points at the remote project; `requireLocalOrExplicitProd` enforces it.
