# Analytics Part A — Historical Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover three fields the clinical backfill dropped — attending doctor, discount type, and new-vs-repeat customer — by re-reading `DR MED MASTERSHEET.xlsx` once and applying GL-silent, idempotent UPDATEs to the already-committed legacy `visits` / `test_requests`.

**Architecture:** A standalone TS importer (same shape as `scripts/clinical-backfill/`): tested pure-logic modules (surname→physician map, discount classifier, new/repeat parser) + a thin sheet reader + a batched commit engine that joins each committed legacy row to its source sheet row via `legacy_source_ref` and writes updates. Dry-run → review CSVs → `--commit --confirm`. One small migration adds `visits.source_new_repeat`.

**Tech Stack:** Next.js 16 + Supabase (Postgres 17), TypeScript strict, `tsx`, ExcelJS, vitest, `@supabase/supabase-js` service-role client. Reuses `scripts/clinical-backfill/lib/{xlsx,names}.ts`, `scripts/clinical-backfill/report.ts`, `scripts/lib/env-guard.ts`.

**Spec:** `docs/superpowers/specs/2026-06-05-operational-analytics-dashboards-design.md` (§3 Part A).

---

## Key facts (verified against prod + sheet, 2026-06-05)

- Committed legacy rows carry `legacy_source_ref`: consult tests = `'DOCTOR CONSULTATION r<n>'`, lab tests = `'LAB SERVICE r<n>'` (n = ExcelJS row number). Visits = `'<TAB> control=<no>'` (not needed here — we reach the visit via `test_requests.visit_id`).
- Backfill set every discounted line to `discount_kind='custom'`; un-discounted = NULL.
- All 8,081 legacy visits have `attending_physician_id = NULL`.
- **Sheet columns** (1-based):
  - `DOCTOR CONSULTATION`: col 8 = doctor surname (formula cell → `.result`); col 10 = Senior/PWD(20%); col 11 = Other discounts(20%).
  - `LAB SERVICE`: col 10 = Senior/PWD(20%); col 11 = Discount(10%); col 12 = Discount(5%); col 17 = NEW/REPEAT CUSTOMER.
- Reviewed surname→physician map is in spec §3.2 and reproduced in Task 3 below.
- `test_requests.discount_kind` CHECK ∈ {senior_pwd_20, pct_10, pct_5, other_pct_20, custom} (nullable).
- Highest migration = `0091`; next = `0092`.

---

## File structure

```
supabase/migrations/0092_visit_source_new_repeat.sql   CREATE  add visits.source_new_repeat (nullable text + CHECK)
scripts/clinical-enrich/
  lib/
    physician-map.ts        CREATE  TESTED  surname normalizer + reviewed map + resolveSurname()
    physician-map.test.ts   CREATE
    discount-type.ts        CREATE  TESTED  classifyDiscount() -> discount_kind | null
    discount-type.test.ts   CREATE
    new-repeat.ts           CREATE  TESTED  parseNewRepeat() -> 'new' | 'repeat' | null
    new-repeat.test.ts      CREATE
    read-enrichment.ts      CREATE  read both tabs -> Map<rowRef, EnrichmentRow> (reuses xlsx helpers)
  engine.ts                 CREATE  join committed rows by legacy_source_ref, build + apply batched updates
  enrich.ts                 CREATE  entrypoint + main()
  validate.sql              CREATE  coverage + GL-silence assertions
package.json                MODIFY  add "enrich:clinical" script
```

**Conventions:** TS strict (no `any` without comment). Tests use `describe/it/expect` with factory helpers. Conventional Commits. Single test file: `npx vitest run scripts/clinical-enrich/lib/physician-map.test.ts`.

---

## Dispatch 1 — Migration + pure logic (TDD)

### Task 1: Migration — `visits.source_new_repeat`

**Files:**
- Create: `supabase/migrations/0092_visit_source_new_repeat.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0092_visit_source_new_repeat.sql
-- Per-visit "new vs repeat customer" marker, recovered from the legacy master
-- sheet (LAB SERVICE col 17). Nullable: NULL = unknown / not recovered. Live
-- visits leave it NULL and the dashboard computes new-vs-repeat from visit
-- history; historical lab visits get the clinic's own hand-tracked value.
alter table public.visits
  add column source_new_repeat text
    check (source_new_repeat in ('new', 'repeat'));
```

- [ ] **Step 2: Apply locally**

Run: `npm run db:reset`
Expected: all migrations apply through `0092` with no error.

- [ ] **Step 3: Regenerate types + commit**

```bash
npm run db:types
git add supabase/migrations/0092_visit_source_new_repeat.sql src/types/database.ts
git commit -m "feat(analytics): 0092 add visits.source_new_repeat marker"
```

### Task 2: vitest include (only if not already covering scripts)

**Files:**
- Verify: `vitest.config.ts`

- [ ] **Step 1: Confirm the include glob already covers scripts**

Run: `grep -n "scripts/\*\*/\*.test.ts" vitest.config.ts`
Expected: a match (added during the clinical backfill). If MISSING, add `"scripts/**/*.test.ts"` to the `include` array, run `npm test`, and commit `chore(test): include scripts tests`. If present, do nothing.

### Task 3: Physician surname map (TDD)

**Files:**
- Create: `scripts/clinical-enrich/lib/physician-map.ts`
- Test: `scripts/clinical-enrich/lib/physician-map.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { normSurname, resolveSurname } from "./physician-map";

describe("normSurname", () => {
  it("uppercases, strips dots, collapses spaces", () => {
    expect(normSurname("  r. vicencio ")).toBe("RVICENCIO");
    expect(normSurname("A. VICENCIO")).toBe("AVICENCIO");
    expect(normSurname("Gayo")).toBe("GAYO");
  });
});

describe("resolveSurname", () => {
  it("maps clean surnames to a physician full_name", () => {
    expect(resolveSurname("GAYO")).toBe("Dr. Katherine Gayo");
    expect(resolveSurname("R.VICENCIO")).toBe("Dr. Robert Vicencio");
    expect(resolveSurname("A. VICENCIO")).toBe("Dr. Aurora Vicencio");
    expect(resolveSurname("N. MARIANO")).toBe("Dr. Nadia Mariano");
    expect(resolveSurname("F. DANTES")).toBe("Dr. Ferdinand Dantes");
    expect(resolveSurname("A. DANTES")).toBe("Dr. Angelle Dantes");
  });
  it("returns null for off-roster and ambiguous bare DANTES", () => {
    expect(resolveSurname("JOSON")).toBeNull();
    expect(resolveSurname("SEVILLEJA")).toBeNull();
    expect(resolveSurname("DANTES")).toBeNull(); // ambiguous → Other
    expect(resolveSurname("")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/clinical-enrich/lib/physician-map.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// Reviewed surname → physician full_name map (spec §3.2). Explicit, not fuzzy —
// doctor identity is high-stakes. Keys are normalized surnames (NO dots/spaces,
// uppercase). Unlisted surnames + ambiguous bare "DANTES" resolve to null ("Other").

export function normSurname(raw: string): string {
  return (raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

const MAP: Record<string, string> = {
  GAYO: "Dr. Katherine Gayo",
  RVICENCIO: "Dr. Robert Vicencio",
  AVICENCIO: "Dr. Aurora Vicencio",
  LORENZO: "Dr. Angelica Lorenzo",
  BROJAS: "Dr. Maria Cecilia Castelo-Brojas",
  ELLEAZAR: "Dr. Jaemari Elleazar",
  MANUEL: "Dr. Archangel Manuel",
  MENDOZA: "Dr. Armelle Keisha Mendoza",
  ARCEGA: "Dr. Alain Arcega",
  ANTONIO: "Dr. Dominique Antonio",
  PACIS: "Dr. Julie Ann Pacis-Caling",
  ANGLO: "Dr. Claudette Anglo",
  NMARIANO: "Dr. Nadia Mariano",
  FDANTES: "Dr. Ferdinand Dantes",
  ADANTES: "Dr. Angelle Dantes",
  LIBIRAN: "Dr. Gideon Libiran",
  BALDEVISO: "Dr. Lei Baldeviso",
  ALVAREZ: "Dr. Mary Rose Alvarez",
  // Off-roster (JOSON, SEVILLEJA, CHING, SAYSON, VILLANUEVA) and bare DANTES are
  // intentionally absent → resolveSurname returns null ("Other").
};

/** Resolve a raw sheet surname to a physician full_name, or null for "Other". */
export function resolveSurname(raw: string): string | null {
  return MAP[normSurname(raw)] ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/clinical-enrich/lib/physician-map.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/clinical-enrich/lib/physician-map.ts scripts/clinical-enrich/lib/physician-map.test.ts
git commit -m "feat(analytics): reviewed surname->physician map (tested)"
```

### Task 4: Discount-type classifier (TDD)

**Files:**
- Create: `scripts/clinical-enrich/lib/discount-type.ts`
- Test: `scripts/clinical-enrich/lib/discount-type.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { classifyDiscount } from "./discount-type";

describe("classifyDiscount (lab)", () => {
  it("senior/PWD wins, then 10%, then 5%", () => {
    expect(classifyDiscount({ senior: 60, d10: 0, d5: 0 }, false)).toBe("senior_pwd_20");
    expect(classifyDiscount({ senior: 0, d10: 30, d5: 0 }, false)).toBe("pct_10");
    expect(classifyDiscount({ senior: 0, d10: 0, d5: 15 }, false)).toBe("pct_5");
    expect(classifyDiscount({ senior: 0, d10: 0, d5: 0 }, false)).toBeNull();
  });
});

describe("classifyDiscount (consult)", () => {
  it("senior/PWD vs other(20%)", () => {
    expect(classifyDiscount({ senior: 100, other: 0 }, true)).toBe("senior_pwd_20");
    expect(classifyDiscount({ senior: 0, other: 100 }, true)).toBe("other_pct_20");
    expect(classifyDiscount({ senior: 0, other: 0 }, true)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/clinical-enrich/lib/discount-type.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// Classify a line's discount_kind from the sheet's per-type discount columns.
// Allowed: senior_pwd_20 | pct_10 | pct_5 | other_pct_20 (or null = no discount).
export type DiscountKind = "senior_pwd_20" | "pct_10" | "pct_5" | "other_pct_20";

interface LabCells { senior: number; d10: number; d5: number; }
interface ConsultCells { senior: number; other: number; }

export function classifyDiscount(
  cells: LabCells | ConsultCells, isConsult: boolean,
): DiscountKind | null {
  if ((cells.senior ?? 0) > 0) return "senior_pwd_20";
  if (isConsult) {
    return ((cells as ConsultCells).other ?? 0) > 0 ? "other_pct_20" : null;
  }
  const lab = cells as LabCells;
  if ((lab.d10 ?? 0) > 0) return "pct_10";
  if ((lab.d5 ?? 0) > 0) return "pct_5";
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/clinical-enrich/lib/discount-type.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/clinical-enrich/lib/discount-type.ts scripts/clinical-enrich/lib/discount-type.test.ts
git commit -m "feat(analytics): discount-type classifier (tested)"
```

### Task 5: New-vs-repeat parser (TDD)

**Files:**
- Create: `scripts/clinical-enrich/lib/new-repeat.ts`
- Test: `scripts/clinical-enrich/lib/new-repeat.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { parseNewRepeat } from "./new-repeat";

describe("parseNewRepeat", () => {
  it("maps new/repeat variants", () => {
    expect(parseNewRepeat("NEW")).toBe("new");
    expect(parseNewRepeat("new customer")).toBe("new");
    expect(parseNewRepeat("N")).toBe("new");
    expect(parseNewRepeat("REPEAT")).toBe("repeat");
    expect(parseNewRepeat("Repeat Customer")).toBe("repeat");
    expect(parseNewRepeat("R")).toBe("repeat");
  });
  it("returns null for blank/unknown", () => {
    expect(parseNewRepeat("")).toBeNull();
    expect(parseNewRepeat("   ")).toBeNull();
    expect(parseNewRepeat("N/A")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/clinical-enrich/lib/new-repeat.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// Parse the LAB SERVICE "NEW / REPEAT CUSTOMER" cell to a marker.
export function parseNewRepeat(raw: string): "new" | "repeat" | null {
  const s = (raw ?? "").trim().toUpperCase();
  if (!s || s === "N/A" || s === "NA") return null;
  if (s.startsWith("N")) return "new";       // NEW, N
  if (s.startsWith("R")) return "repeat";    // REPEAT, R
  return null;
}
```

> NOTE: `"N/A"` is guarded before the `startsWith("N")` branch so it is not misread as "new".

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/clinical-enrich/lib/new-repeat.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole suite + commit**

Run: `npm test`
Expected: all pure-logic tests green.

```bash
git add scripts/clinical-enrich/lib/new-repeat.ts scripts/clinical-enrich/lib/new-repeat.test.ts
git commit -m "feat(analytics): new/repeat parser (tested)"
```

### Task 6: Enrichment sheet reader

**Files:**
- Create: `scripts/clinical-enrich/lib/read-enrichment.ts`

- [ ] **Step 1: Write the reader (reuses clinical-backfill xlsx helpers)**

```ts
import ExcelJS from "exceljs";
import { cellText, fnum } from "../../clinical-backfill/lib/xlsx";

/** One source-sheet row's recoverable enrichment fields, keyed by legacy_source_ref. */
export interface EnrichmentRow {
  doctorSurname: string;          // consult only; "" for lab
  discountSenior: number;
  discountOther: number;          // consult col 11
  discount10: number;             // lab col 11
  discount5: number;              // lab col 12
  newRepeat: string;              // lab col 17; "" for consult
}

/**
 * Read both tabs and return a map: legacy_source_ref -> EnrichmentRow.
 * Keys mirror what the backfill wrote: "DOCTOR CONSULTATION r<n>" / "LAB SERVICE r<n>".
 */
export async function readEnrichment(xlsxPath: string): Promise<Map<string, EnrichmentRow>> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);
  const out = new Map<string, EnrichmentRow>();

  const consult = wb.getWorksheet("DOCTOR CONSULTATION");
  if (!consult) throw new Error("DOCTOR CONSULTATION sheet not found");
  consult.eachRow({ includeEmpty: false }, (row, rn) => {
    if (rn <= 2) return;
    if (row.getCell(1).value == null) return;
    out.set(`DOCTOR CONSULTATION r${rn}`, {
      doctorSurname: cellText(row.getCell(8).value).trim(),
      discountSenior: fnum(row.getCell(10).value),
      discountOther: fnum(row.getCell(11).value),
      discount10: 0,
      discount5: 0,
      newRepeat: "",
    });
  });

  const lab = wb.getWorksheet("LAB SERVICE");
  if (!lab) throw new Error("LAB SERVICE sheet not found");
  lab.eachRow({ includeEmpty: false }, (row, rn) => {
    if (rn <= 2) return;
    if (row.getCell(1).value == null) return;
    out.set(`LAB SERVICE r${rn}`, {
      doctorSurname: "",
      discountSenior: fnum(row.getCell(10).value),
      discountOther: 0,
      discount10: fnum(row.getCell(11).value),
      discount5: fnum(row.getCell(12).value),
      newRepeat: cellText(row.getCell(17).value).trim(),
    });
  });

  return out;
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add scripts/clinical-enrich/lib/read-enrichment.ts
git commit -m "feat(analytics): enrichment sheet reader"
```

---

## Dispatch 2 — Engine, entrypoint, validation

### Task 7: The engine (join by legacy_source_ref → batched updates)

**Files:**
- Create: `scripts/clinical-enrich/engine.ts`

- [ ] **Step 1: Write the engine**

```ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../src/types/database";
import { requireLocalOrExplicitProd } from "../lib/env-guard";
import { writeCsv } from "../clinical-backfill/report";
import { readEnrichment } from "./lib/read-enrichment";
import { resolveSurname } from "./lib/physician-map";
import { classifyDiscount } from "./lib/discount-type";
import { parseNewRepeat } from "./lib/new-repeat";

interface Args { xlsx: string; commit: boolean; confirmed: boolean; }
export function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const xlsx = argv.find((a) => a.startsWith("--xlsx="))?.substring(7)
    ?? `${process.env.HOME ?? ""}/Downloads/DR MED MASTERSHEET.xlsx`;
  return {
    xlsx,
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

// chunked "update ... where id in (...)" helper
async function applyByIds(
  admin: SupabaseClient<Database>, table: "visits" | "test_requests",
  patch: Record<string, unknown>, ids: string[],
): Promise<number> {
  let n = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const slice = ids.slice(i, i + 200);
    const { error } = await admin.from(table).update(patch as never).in("id", slice);
    if (error) throw new Error(`update ${table} ${JSON.stringify(patch)}: ${error.message}`);
    n += slice.length;
  }
  return n;
}

interface LegacyTr {
  id: string; visit_id: string; legacy_source_ref: string;
  discount_amount_php: number | null; discount_kind: string | null;
}

export async function run(): Promise<void> {
  const args = parseArgs();
  console.log(`Reading enrichment from ${args.xlsx}`);
  const sheet = await readEnrichment(args.xlsx);
  console.log(`  ${sheet.size} source rows indexed`);

  const admin = adminClient();

  // physician full_name -> id
  const physRows = await fetchAll<{ id: string; full_name: string }>(async (lo, hi) => {
    const { data, error } = await admin.from("physicians").select("id,full_name").range(lo, hi);
    if (error) throw new Error(error.message); return (data ?? []) as { id: string; full_name: string }[];
  });
  const physIdByName = new Map(physRows.map((p) => [p.full_name, p.id]));

  // committed legacy test_requests
  const trs = await fetchAll<LegacyTr>(async (lo, hi) => {
    const { data, error } = await admin.from("test_requests")
      .select("id,visit_id,legacy_source_ref,discount_amount_php,discount_kind")
      .not("legacy_source_ref", "is", null).range(lo, hi);
    if (error) throw new Error(error.message); return (data ?? []) as LegacyTr[];
  });
  console.log(`  ${trs.length} committed legacy test_requests`);

  // current attending_physician_id / source_new_repeat per visit (idempotency: only fill NULLs)
  const visitState = new Map<string, { phys: string | null; nr: string | null }>();
  const visits = await fetchAll<{ id: string; attending_physician_id: string | null; source_new_repeat: string | null }>(async (lo, hi) => {
    const { data, error } = await admin.from("visits")
      .select("id,attending_physician_id,source_new_repeat").not("legacy_import_run_id", "is", null).range(lo, hi);
    if (error) throw new Error(error.message);
    return (data ?? []) as { id: string; attending_physician_id: string | null; source_new_repeat: string | null }[];
  });
  for (const v of visits) visitState.set(v.id, { phys: v.attending_physician_id, nr: v.source_new_repeat });

  // build update buckets
  const visitPhys = new Map<string, string[]>();   // physician_id -> visit ids
  const visitNR = new Map<"new" | "repeat", string[]>();
  const trDiscount = new Map<string, string[]>();   // discount_kind -> test_request ids
  const unmatchedDocs = new Map<string, number>();  // surname -> count

  for (const tr of trs) {
    const e = sheet.get(tr.legacy_source_ref);
    if (!e) continue;
    const isConsult = tr.legacy_source_ref.startsWith("DOCTOR CONSULTATION");

    // 1. doctor (consult only) -> visit.attending_physician_id (fill-NULL-only)
    if (isConsult) {
      const fullName = resolveSurname(e.doctorSurname);
      const st = visitState.get(tr.visit_id);
      if (st && st.phys === null) {
        if (fullName) {
          const pid = physIdByName.get(fullName);
          if (!pid) throw new Error(`physician not found: ${fullName}`);
          (visitPhys.get(pid) ?? visitPhys.set(pid, []).get(pid)!).push(tr.visit_id);
          st.phys = pid; // mark so multi-line visits aren't double-bucketed
        } else if (e.doctorSurname.trim()) {
          unmatchedDocs.set(e.doctorSurname.toUpperCase(), (unmatchedDocs.get(e.doctorSurname.toUpperCase()) ?? 0) + 1);
        }
      }
    }

    // 2. discount type -> test_request.discount_kind (only reclassify the lumped 'custom')
    if ((tr.discount_amount_php ?? 0) > 0 && tr.discount_kind === "custom") {
      const kind = classifyDiscount(
        isConsult
          ? { senior: e.discountSenior, other: e.discountOther }
          : { senior: e.discountSenior, d10: e.discount10, d5: e.discount5 },
        isConsult,
      );
      if (kind) (trDiscount.get(kind) ?? trDiscount.set(kind, []).get(kind)!).push(tr.id);
    }

    // 3. new/repeat (lab only) -> visit.source_new_repeat (fill-NULL-only)
    if (!isConsult) {
      const nr = parseNewRepeat(e.newRepeat);
      const st = visitState.get(tr.visit_id);
      if (nr && st && st.nr === null) {
        (visitNR.get(nr) ?? visitNR.set(nr, []).get(nr)!).push(tr.visit_id);
        st.nr = nr;
      }
    }
  }

  // summary
  const physTotal = [...visitPhys.values()].reduce((s, a) => s + a.length, 0);
  const discTotal = [...trDiscount.values()].reduce((s, a) => s + a.length, 0);
  const nrTotal = [...visitNR.values()].reduce((s, a) => s + a.length, 0);
  console.log(`\n=== enrichment dry-run ===`);
  console.log(`  doctor attribution:   ${physTotal} visits (across ${visitPhys.size} physicians)`);
  console.log(`  unmatched doctors:    ${[...unmatchedDocs.values()].reduce((a, b) => a + b, 0)} consults (${unmatchedDocs.size} surnames)`);
  console.log(`  discount reclassify:  ${discTotal} test_requests`);
  console.log(`  new/repeat set:       ${nrTotal} visits`);

  const csv = await writeCsv(
    "enrich-unmatched-doctors", ["surname", "count"],
    [...unmatchedDocs.entries()].sort((a, b) => b[1] - a[1]).map(([s, n]) => [s, String(n)]),
  );
  console.log(`\nUnmatched-doctors CSV: ${csv}`);

  if (!args.commit) {
    console.log(`\nDry-run. To commit (dev): npm run enrich:clinical -- --commit --confirm="I-mean-it"\n`);
    return;
  }
  if (!args.confirmed) { console.error('\n--commit requires --confirm="I-mean-it".'); process.exit(3); }
  requireLocalOrExplicitProd("enrich:clinical");

  let applied = 0;
  for (const [pid, ids] of visitPhys) applied += await applyByIds(admin, "visits", { attending_physician_id: pid }, ids);
  for (const [nr, ids] of visitNR) applied += await applyByIds(admin, "visits", { source_new_repeat: nr }, ids);
  for (const [kind, ids] of trDiscount) applied += await applyByIds(admin, "test_requests", { discount_kind: kind }, ids);

  console.log(`\nCommit complete: doctor +${physTotal}, new/repeat +${nrTotal}, discount +${discTotal} (rows touched ${applied})`);
}
```

> NOTE: the `(map.get(k) ?? map.set(k, []).get(k)!)` idiom lazily creates the array. If the reviewer finds it unclear, refactor to an explicit `if (!map.has(k)) map.set(k, [])` — behavior must be identical. Buckets are keyed so each visit is updated once even when it has multiple lines (the `st.phys`/`st.nr` guard).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (`source_new_repeat` exists in the regenerated `Database` type from Task 1.)

- [ ] **Step 3: Commit**

```bash
git add scripts/clinical-enrich/engine.ts
git commit -m "feat(analytics): enrichment engine (doctor/discount/new-repeat, batched, idempotent)"
```

### Task 8: Entrypoint + npm script

**Files:**
- Create: `scripts/clinical-enrich/enrich.ts`
- Modify: `package.json`

- [ ] **Step 1: Write `enrich.ts`**

```ts
import { run } from "./engine";
run().catch((e) => { console.error("FATAL:", e); process.exit(1); });
```

- [ ] **Step 2: Add the npm script**

In `package.json` scripts, after the `backfill:clinical:*` block, add:

```json
    "enrich:clinical": "tsx --env-file=.env.local scripts/clinical-enrich/enrich.ts",
```

- [ ] **Step 3: Commit**

```bash
git add scripts/clinical-enrich/enrich.ts package.json
git commit -m "feat(analytics): enrich:clinical entrypoint + npm script"
```

### Task 9: Validation SQL

**Files:**
- Create: `scripts/clinical-enrich/validate.sql`

- [ ] **Step 1: Write the validation queries**

```sql
-- Clinical enrichment validation (read-only).
--   docker exec -i supabase_db_DRMed psql -U postgres -d postgres < scripts/clinical-enrich/validate.sql
\echo '=== 1. doctor attribution coverage (legacy consults) ==='
select
  count(*) filter (where v.attending_physician_id is not null) as attributed,
  count(*) filter (where v.attending_physician_id is null) as other_or_null,
  count(*) as total
from public.visits v
join public.test_requests t on t.visit_id = v.id and t.legacy_import_run_id is not null
join public.services s on s.id = t.service_id and s.kind = 'doctor_consultation'
where v.legacy_import_run_id is not null;

\echo '=== 2. discount_kind distribution (legacy test_requests with a discount) ==='
select coalesce(discount_kind,'(null)') as kind, count(*)
from public.test_requests where legacy_import_run_id is not null and coalesce(discount_amount_php,0) > 0
group by 1 order by 2 desc;

\echo '=== 3. new/repeat coverage (legacy lab visits) ==='
select coalesce(source_new_repeat,'(null)') as marker, count(*)
from public.visits where legacy_import_run_id is not null group by 1 order by 2 desc;

\echo '=== 4. GL-SILENCE assertion: zero JEs reference legacy clinical rows (must be 0) ==='
select count(*) as must_be_zero
from public.journal_entries je
where je.source_kind in ('payment','test_request')
  and je.source_id in (
    select id from public.payments where legacy_import_run_id is not null
    union all select id from public.test_requests where legacy_import_run_id is not null
  );

\echo '=== 5. consults per physician (top) ==='
select coalesce(p.full_name,'(Other / unattributed)') as physician, count(*) as consults
from public.visits v
join public.test_requests t on t.visit_id = v.id and t.legacy_import_run_id is not null
join public.services s on s.id = t.service_id and s.kind = 'doctor_consultation'
left join public.physicians p on p.id = v.attending_physician_id
where v.legacy_import_run_id is not null
group by 1 order by 2 desc;
```

- [ ] **Step 2: Commit**

```bash
git add scripts/clinical-enrich/validate.sql
git commit -m "feat(analytics): enrichment validation SQL"
```

---

## Dispatch 3 — Run

### Task 10: Local dry-run + commit + validate

> The local DB was reset in Task 1 (no legacy rows). To exercise the engine end-to-end locally you need legacy clinical data present. Two options: (a) re-run the clinical backfill locally first (`backfill:clinical:{lab,consult}` against a local env, per that plan's Task 18), then enrich; or (b) validate the engine against a throwaway Supabase MCP branch seeded from prod. If neither is convenient, at minimum run the **dry-run against prod read-only** (Step 1) to confirm real coverage numbers, and do the committed run as Task 11.

- [ ] **Step 1: Dry-run (read-only) to confirm coverage**

Run (prod read-only — `.env.local` points at prod; dry-run writes nothing):
`npm run enrich:clinical`
Expected: prints doctor/discount/new-repeat counts; `enrich-unmatched-doctors-*.csv` lists JOSON/SEVILLEJA/CHING/SAYSON/VILLANUEVA/DANTES. Doctor attribution should be ≈1,490 of ~1,605 consults (~93%).

- [ ] **Step 2: (If running a local commit) commit + validate + idempotency**

Run: `... --commit --confirm="I-mean-it"` against the local-seeded DB, then
`docker exec -i supabase_db_DRMed psql -U postgres -d postgres < scripts/clinical-enrich/validate.sql`
Expected: check #4 `must_be_zero = 0`; #1 attributed ≈93%; re-running the commit reports `+0` (idempotent — all buckets empty on the second pass).

- [ ] **Step 3: Commit a runbook note**

```bash
git commit --allow-empty -m "test(analytics): enrichment dry-run coverage confirmed"
```

### Task 11: Production run (operator-gated — do NOT auto-run)

> Per `feedback_remote_db_ops_ipv6`, prod migration goes via the Supabase MCP; the data UPDATEs go via the script with `--prod`. **Surface the dry-run numbers + unmatched-doctors CSV to the user for sign-off before committing to prod** (same discipline as the clinical backfill).

- [ ] **Step 1: Apply migration 0092 to prod**

Apply `0092_visit_source_new_repeat.sql` via Supabase MCP `apply_migration` (or `execute_sql` + record the `0092` row in `supabase_migrations.schema_migrations`). Verify with `list_migrations`.

- [ ] **Step 2: Prod dry-run → user review → commit**

`npm run enrich:clinical` (read-only) → review counts + CSV with the user.
Then: `SEED_ALLOW_PROD=1 npm run enrich:clinical -- --commit --confirm="I-mean-it" --prod`
Run `validate.sql` via MCP `execute_sql`; confirm GL-silence (#4 = 0) + coverage.

- [ ] **Step 3: Update docs + memory**

Add a RELEASE_NOTES note; update memory ([[project_ops_analytics_dashboard]]) with enrichment-shipped + coverage numbers.

---

## Self-review notes

- **Spec coverage:** §3.1–3.3 doctor → Tasks 3,7; §3.4 discount → Tasks 4,7; §3.5 new/repeat → Tasks 1,5,7; §3.6 flow/safety → engine (fill-NULL-only, batched, GL-silent UPDATEs) + validate #4; map §3.2 → Task 3 constant.
- **GL-silence:** the engine only UPDATEs `attending_physician_id` / `discount_kind` / `source_new_repeat` — never `status` — so `bridge_test_request_released` (UPDATE-on-status→released, + `legacy_import_run_id` guard from 0091) never posts. Asserted by validate #4.
- **Idempotency:** doctor/new-repeat fill only where the visit field is still NULL; discount reclassify only where `discount_kind='custom'`. A second pass produces empty buckets → `+0`.
- **No placeholders / type consistency:** `resolveSurname` (string|null), `classifyDiscount(cells,isConsult)`, `parseNewRepeat` (union) are used in the engine exactly as defined; `EnrichmentRow` fields match the reader and engine.
- **Deferred (not this plan):** Part B (views + dashboards) is a separate plan once this data lands.
