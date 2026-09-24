# Sheet Sync PR 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep DRMed's patients current from the reception Google Sheet "LAB SERVICES (RECEPTION)" every night (paused until an admin turns it on), and keep a reporting-only copy of the sheet's lab and consultation rows, with a reviewed admin page at `/staff/admin/sheet-sync`.

**Architecture:** A pure parsing/identity library under `src/lib/sheet-sync/` turns ONE `values.batchGet` of the sheet into typed rows and a write plan. A thin store wraps service-role-only, lease-fenced SQL RPCs (migration 0170) that apply the plan atomically in chunks. Three callers share `runSheetSync()`: the nightly cron, the admin page's *Sync now*, and a guarded CLI. Clinical rows never become visits in this PR. They are snapshot-replaced into mirror tables that nothing outside the sync and (later) Patient Sources may read.

**Tech Stack:** Next.js 16 App Router (server components + server actions), Supabase Postgres (plpgsql RPCs, RLS), supabase-js, vitest, `jose` (JWT for the Google service account), Google Sheets API v4 over `fetch`.

**Spec:** `docs/superpowers/specs/2026-09-24-sheet-sync-and-patient-sources-design.md` (v3, approved) §4–§5, §11. PRs 2–5 are out of scope.

---

## 0. Read this first — decisions that refine the spec

These were settled while planning (2026-09-24) from code and live data the spec predates. They are binding for this PR; record them in the spec's review log in Task 20.

| # | Decision | Why |
|---|---|---|
| D1 | Migration **0170** (`0170_sheet_sync_foundation.sql`; renumbered from 0159 on 2026-09-24 — open PRs took 0159–0165), P-codes **P0062** (another sync is running), **P0063** (lease lost), **P0064** (review item no longer open). | #205 took 0157 and #206 took 0158 on 2026-09-24. Re-check open branches before pushing (CLAUDE.md recipe). |
| D2 | **Channel ownership is decided by a transaction-local setting `app.referral_origin`, set only inside our security-definer RPCs** (`resolve_patient_guarded` → `patient`, sync / re-sort / alias / revert → `sheet` or the restored value). The trigger ignores any value written to `referral_source_origin` directly; any `referral_source` change without the setting becomes `staff`. | The spec's "decide by caller role" rule cannot work. 0158's `resolve_patient_guarded` writes `referral_source` from the public forms as the function owner, and a same-value origin write is invisible to a BEFORE trigger, so the sync re-writing a value it already owns would flip it to `staff`. PostgREST cannot call `set_config` (it lives in `pg_catalog`, which is not an exposed schema), so only our functions can set it. The repo already uses this pattern: `app.skip_bridge_historical` (0036), `app.allow_template_param_delete` (0121). |
| D3 | Every patient-changing admin action (re-sort approval, map-answer-to-channel, revert) runs as its own `sheet_sync_runs` row (`trigger` = `resort` / `alias` / `revert`) under the same lease. So each is fenced, listed in run history, and itself revertable. | One mechanism for before-images and reverts instead of three. |
| D4 | Review kind `possible_existing_patient` is added to the kind list. | The spec uses it in §5.3 but left it out of §4.2's list. |
| D5 | Sheet-created patients carry a `legacy_import_runs` row (one per sync run, `source = 'sheet_sync:CUSTOMER LIST2'`) in `patients.legacy_import_run_id`. | `patients_birthdate_required_for_walkins` (0054) requires `legacy_import_run_id is not null or birthdate is not null`; ~25% of Customers rows have no DOB. |
| D6 | Names are parsed with the May importer's own `parseName` (`src/lib/legacy-import/name-parser.ts`), phones with its `normalizePhone`, sex / release medium / Senior-PWD with `vocabulary-mapper.ts`. `name_norm` = `normalizeName(last) + "|" + normalizeName(first + " " + middle)`. | A re-read Customers row then produces exactly the name of the patient it created in May, so full-name equality finds it. |
| D7 | 87 distinct "How did you know" spellings exist today (spec said 72). The committed fixture excludes the one-offs that contain a person's name (the repo is public). | Live read 2026-09-24. |
| D8 | Re-sort never proposes moving a specific channel to `other`. It only proposes a different specific channel, or NULL for a blank answer. | The old mapper sent answers like "SON OF DOC …" to `doctor_referral`; the new mapper sends them to `other`. That would be a downgrade. |
| D9 | The public forms (`/schedule`, `/register`) gain the new channels as options, because `PUBLIC_REFERRAL_OPTIONS` is built from every id. `customer_referral`'s public wording changes to "Another DRMed patient told me" and `family_friends` takes "A friend or family member". | The type requires a public label per id, and two options must not read the same. Called out to the owner in the PR body. |
| D10 | The heartbeat actions are `sheet_sync.completed` + `sheet_sync.skipped`. `partial` / `failed` are audited but are NOT heartbeats, so a sync that keeps failing goes STALE on the watchdog. | Same as `sync-accounting`: only a healthy or deliberately skipped run proves the cron is working. |
| D11 | Database proofs live in a hand-run, local-only script `scripts/sheet-sync-db-proof.ts` (`npm run sheet-sync:db-proof`), following `scripts/perf/rls-*.ts`. `npm test` stays pure. | No vitest test in this repo touches Postgres. |

## 1. Sheet facts the parsers rely on (live read 2026-09-24)

`values.batchGet` with `valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER` (1.7 s for the three big tabs). Column numbers are **0-based**.

**`CUSTOMER LIST2`** — header row 0, data from row 1:
`0 Last Name · 1 First Name · 2 M.I. · 3 # · 4 Full Name ("Last, First Middle") · 5 Gender · 6 Date of Birth (serial 4,596 / text 37 / blank 1,236) · 7 Age · 8 Address (#, Street Name)␠ · 9 Address (Barangay)␠ · 10 Address (City)␠ · 11 Contact Number (string or NUMBER — leading 0 lost) · 12 Email address · 13 Senior / PWD ID · 14 Senior / PWD ID Number · 15 Doctor · 16 How did you know about DR Med? · 17 Referred By:␠ · 18 Preferred Medium of Result Release · 19 New / Repeat · 20 Timestamp (int serial 1,971 / fractional serial 1,933 / blank 1,933 / ~30 text) · 21 Column 21`

**`LAB SERVICE`** — header rows 0–1, data from row 2:
`0 date (serial) · 1 CONTROL NO · 2 TEST NO · 3 PATIENT NAME · 4 HMO YES/NO · 5 PROVIDER · 6 APPROVAL DATE · 7 SERVICE · 8 BASE PRICE · 9 SENIOR/PWD · 10 DISCOUNT 10% · 11 DISCOUNT 5% · 12 ACTUAL DISCOUNT · 13 FINAL PRICE (LESS DISCOUNTS) · 14 PAYMENT METHOD / PAID · 15 REF · 16 RESULT RELEASE / PREFERRED MEDIUM · 17 DATE RELEASED (serial, text dates, or junk like "MAX", "Viber") · 18 REMARKS · 19 DATE (PLACE HOLDER)`

**`DOCTOR CONSULTATION`** — header rows 0–1, data from row 2 (row 2 is often empty):
`0 DATE · 1 CONTROL NO · 2 TEST NO. · 3 PATIENT NAME · 4 HMO YES/NO · 5 PROVIDER · 6 APPROVAL DATE · 7 DOCTOR CONSULTANT · 8 BASE PRICE · 9 SENIOR/PWD · 10 OTHER DISCOUNTS · 11 FINAL PRICE (doctor's whole fee) · 12 CLINIC FEE (app basis) · 13 PAID (method) · 14 REFERENCE · 15 REMARKS`

A header check (Task 4) refuses a tab whose key headers moved, so an inserted column cannot silently shift every field.

## 2. File map

**Create — library (`src/lib/sheet-sync/`, no `server-only`, relative imports only so the CLI can load it):**
| File | Responsibility |
|---|---|
| `names.ts` | name keys (`nameNormOf`, `looseKeyOf`, `linkKeyOf`, `tokensOf`, `isTokenSuperset`), `phone10`, `sha1Hex`, `sourceKeyOf` |
| `dates.ts` | serial → ISO by integer arithmetic; per-cell text date parsing; range checks |
| `referral-mapper.ts` | `normalizeAnswer`, `mapAnswer` (aliases → rules → blank → other) |
| `types.ts` | shared row / plan / store types |
| `tabs/headers.ts` | header assertions per tab |
| `tabs/customers.ts` | `parseCustomersTab` |
| `tabs/encounters.ts` | `parseLabTab`, `parseConsultTab` |
| `patient-index.ts` | in-memory lookup of live patients (full name, loose key, phone, DOB, survivor) |
| `customer-plan.ts` | §5.3 identity rules → ops, mirror rows and review items |
| `encounter-identity.ts` | §5.2 identity keys for mirror lines |
| `snapshot.ts` | shrink-by->5% check |
| `resort.ts` | re-sort proposal groups (pure) |
| `reader.ts` | one `values.batchGet`, response validation |
| `store.ts` | `SheetSyncStore` interface + supabase implementation over the RPCs |
| `run.ts` | `runSheetSync()` orchestration + `withAdminLease()` |
| `config.ts` | env → `readSheet` function (sheet id + service account) |
| `__fixtures__/answers.ts`, `__fixtures__/date-cells.ts` | non-PII value fixtures |
| `*.test.ts` beside each | vitest |
| `mirror-readers.test.ts` | repo guard: only allowed files read the mirror tables |

**Create — other:**
- `src/lib/google/service-account-token.ts` (+ test) — JWT → access token, per-scope cache (moved out of `google-sheets.ts`)
- `src/lib/legacy-import/normalize-name.ts` — `normalizeName` moved from `scripts/clinical-backfill/lib/names.ts`
- `supabase/migrations/0170_sheet_sync_foundation.sql`
- `src/app/api/cron/sheet-sync/route.ts`
- `src/app/(staff)/staff/(dashboard)/admin/sheet-sync/{page.tsx,actions.ts,sync-controls.tsx,review-queue.tsx,resort-panel.tsx,run-history.tsx,format.ts}`
- `scripts/sheet-sync.ts` (CLI), `scripts/sheet-sync-db-proof.ts` (local DB proofs)

**Modify:**
- `src/lib/accounting/google-sheets.ts` (use shared token helper)
- `scripts/clinical-backfill/lib/names.ts` (re-export `normalizeName`)
- `src/lib/patients/referral-sources.ts` + `.test.ts` (18 ids, D9)
- `src/lib/accounting/pg-errors.ts` (P0062–P0064)
- `supabase/seed.sql` (tail: re-revokes for the new tables)
- `src/app/api/cron/data-retention/route.ts` (purge old resolved review items + orphan staging)
- `vercel.json`, `src/lib/ops/cron-heartbeats.ts`, `.github/workflows/cron-watchdog.yml` (three-place cron rule)
- `src/lib/staff/route-names.ts`, `src/components/staff/staff-nav-config.ts` (+ nav test)
- `src/types/database.ts` (regenerated)
- `package.json` (`sheet:sync`, `sheet-sync:db-proof`)
- `.env.example`, `docs/drmed-user-guide.html`, `CLAUDE.md`, `.claude/skills/drmed-migrations/SKILL.md`, `.claude/skills/drmed-staff-ui/SKILL.md`, the spec's review log

## 3. Conventions every task follows

- Run from the worktree `~/Claude/DRMed/.worktrees/sheet-sync`. Single test: `npx vitest run <file>`. The full gate is `npm test && npm run typecheck && npm run lint`.
- **No personal data in committed files.** The repo is public. Fixtures hold answer spellings and date shapes only. Test names use invented people (`Dela Cruz, Juan Santos`).
- Dates: never `new Date()` → `toISOString().slice(0,10)`, never `getUTC*` off a Manila instant. `manila-usage.test.ts` enforces this. Use `todayManilaISODate()` / `shiftISODate()` from `src/lib/dates/manila.ts` and the integer math in `dates.ts`.
- Every runtime `raise exception` in SQL carries an errcode (`P005x` or a standard SQLSTATE such as `22023`); `pg-error-coverage.test.ts` enforces it.
- Commits: Conventional Commits, each ending with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. **Never push** until Task 21 — the branch is local-only and the repo is public.
- Next.js 16: before writing a route handler, server action or page, read the matching guide under `node_modules/next/dist/docs/` (AGENTS.md) and copy the structure of the named sibling file.

---

# Phase A — pure library (no database)

### Task 1: Name, phone and key helpers

**Files:**
- Create: `src/lib/legacy-import/normalize-name.ts`
- Modify: `scripts/clinical-backfill/lib/names.ts` (replace its `normalizeName` body with a re-export)
- Create: `src/lib/sheet-sync/names.ts`, `src/lib/sheet-sync/names.test.ts`

- [ ] **Step 1: Move `normalizeName`.** Create `src/lib/legacy-import/normalize-name.ts` with the function copied **verbatim** from `scripts/clinical-backfill/lib/names.ts` (lines 3–13, including the comment). In `scripts/clinical-backfill/lib/names.ts`, delete that function and add at the top:

```ts
import { normalizeName } from "../../../src/lib/legacy-import/normalize-name";
export { normalizeName };
```

Run `npx vitest run scripts/clinical-backfill` → PASS (behaviour unchanged).

- [ ] **Step 2: Write the failing tests** — `src/lib/sheet-sync/names.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  isTokenSuperset, linkKeyOf, looseKeyOf, nameNormOf, phone10, sha1Hex, sourceKeyOf, tokensOf,
} from "./names";

describe("name keys", () => {
  const juan = { first: "Juan", middle: "Santos", last: "Dela Cruz" };
  it("nameNorm is surname | given names, normalised", () => {
    expect(nameNormOf(juan)).toBe("dela cruz|juan santos");
    expect(nameNormOf({ first: "JUAN", middle: null, last: "de la Cruz" })).toBe("de la cruz|juan");
    expect(nameNormOf({ first: "José", middle: null, last: "O'Brien" })).toBe("obrien|jose");
  });
  it("looseKey is surname | first given token", () => {
    expect(looseKeyOf(juan)).toBe("dela cruz|juan");
    expect(looseKeyOf({ first: "Ma. Luisa", middle: null, last: "Reyes" })).toBe("reyes|ma");
  });
  it("linkKey joins nameNorm and dob with #", () => {
    expect(linkKeyOf("dela cruz|juan santos", "1990-02-03")).toBe("dela cruz|juan santos#1990-02-03");
    expect(linkKeyOf("dela cruz|juan santos", null)).toBe("dela cruz|juan santos#");
  });
  it("token superset: a patient with a middle name covers a line typed without it", () => {
    expect(isTokenSuperset(tokensOf(juan), tokensOf({ first: "Juan", middle: null, last: "Dela Cruz" }))).toBe(true);
    expect(isTokenSuperset(tokensOf({ first: "Juan", middle: null, last: "Dela Cruz" }), tokensOf(juan))).toBe(false);
  });
});

describe("phone10", () => {
  it("keeps the last 10 digits, like patients.phone_normalized (0105)", () => {
    expect(phone10("0909 553 4228")).toBe("9095534228");
    expect(phone10(9095534228)).toBe("9095534228");
    expect(phone10("+63 909 553 4228")).toBe("9095534228");
    expect(phone10("12345")).toBeNull();
    expect(phone10("")).toBeNull();
    expect(phone10(undefined)).toBeNull();
  });
});

describe("hashes", () => {
  it("sha1Hex is stable hex", () => {
    expect(sha1Hex("abc")).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
  });
  it("sourceKey changes when any identity part changes", () => {
    const a = sourceKeyOf("dela cruz|juan", "9095534228", "1990-02-03", "2025-01-02");
    expect(sourceKeyOf("dela cruz|juan", "9095534228", "1990-02-03", "2025-01-02")).toBe(a);
    expect(sourceKeyOf("dela cruz|juan", null, "1990-02-03", "2025-01-02")).not.toBe(a);
  });
});
```

- [ ] **Step 3: Run** `npx vitest run src/lib/sheet-sync/names.test.ts` → FAIL (module not found).

- [ ] **Step 4: Implement** `src/lib/sheet-sync/names.ts`:

```ts
/**
 * Identity keys for Sheet Sync (spec §5.2–§5.3, plan D6).
 *
 * nameNorm  = normalised surname + "|" + normalised given names (first + middle).
 *             Full-name equality compares these strings.
 * looseKey  = surname + "|" + FIRST given token — consults are typed without
 *             middle names, so this collapses "Dela Cruz, Juan" and
 *             "Dela Cruz, Juan Santos". Used to find suggestions and for
 *             unlinked mirror identities, never to auto-link a Customers row.
 * linkKey   = nameNorm + "#" + dob — the key of a durable identity decision
 *             (sheet_patient_links). Phone and registration date are excluded
 *             so correcting a phone number does not orphan a decision.
 *
 * Pure and not server-only: the CLI imports it.
 */
import { createHash } from "node:crypto";
import { normalizeName } from "../legacy-import/normalize-name";

export interface NameParts {
  first: string | null;
  middle: string | null;
  last: string | null;
}

export function nameNormOf(p: NameParts): string {
  const last = normalizeName(p.last ?? "");
  const given = normalizeName(`${p.first ?? ""} ${p.middle ?? ""}`);
  return `${last}|${given}`;
}

export function looseKeyOf(p: NameParts): string {
  const last = normalizeName(p.last ?? "");
  const first = normalizeName(p.first ?? "").split(" ")[0] ?? "";
  return `${last}|${first}`;
}

export function linkKeyOf(nameNorm: string, dob: string | null): string {
  return `${nameNorm}#${dob ?? ""}`;
}

/** Every normalised token of the name (surname tokens included). */
export function tokensOf(p: NameParts): string[] {
  return normalizeName(`${p.last ?? ""} ${p.first ?? ""} ${p.middle ?? ""}`)
    .split(" ")
    .filter(Boolean);
}

/** True when every token of `line` appears in `patient` (multiset-insensitive). */
export function isTokenSuperset(patient: readonly string[], line: readonly string[]): boolean {
  const have = new Set(patient);
  return line.every((t) => have.has(t));
}

/** Last 10 digits, matching `patients.phone_normalized` (0105). Null below 10 digits. */
export function phone10(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const digits = String(raw).replace(/[^0-9]/g, "");
  return digits.length >= 10 ? digits.slice(-10) : null;
}

export function sha1Hex(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

/** Customers row identity (spec §5.3): exact duplicates share it. */
export function sourceKeyOf(
  nameNorm: string,
  phone: string | null,
  dob: string | null,
  registeredOn: string | null,
): string {
  return sha1Hex([nameNorm, phone ?? "", dob ?? "", registeredOn ?? ""].join("␟"));
}
```

- [ ] **Step 5: Run** `npx vitest run src/lib/sheet-sync/names.test.ts scripts/clinical-backfill` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/legacy-import/normalize-name.ts scripts/clinical-backfill/lib/names.ts src/lib/sheet-sync/names.ts src/lib/sheet-sync/names.test.ts
git commit -m "feat(sheet-sync): name, phone and identity-key helpers"
```

---

### Task 2: Per-cell date parsing

**Files:**
- Create: `src/lib/sheet-sync/dates.ts`, `src/lib/sheet-sync/dates.test.ts`, `src/lib/sheet-sync/__fixtures__/date-cells.ts`

Spec §5.1. A date cell is a **serial number** (a real date in the sheet), text, or blank. Serials are converted by integer arithmetic. Text is parsed per cell by shape. Every result is range-checked.

- [ ] **Step 1: Write the fixture** `src/lib/sheet-sync/__fixtures__/date-cells.ts`. It covers every text shape seen in the live Customers "Timestamp", "Date of Birth", and lab "DATE RELEASED" columns on 2026-09-24. There are no names; `#N/A` VLOOKUP errors are represented generically.

```ts
/** Date-cell shapes seen in the live sheet (2026-09-24). Values only — no names. */
export const EVENT_DATE_CASES: ReadonlyArray<[cell: unknown, expected: string | null]> = [
  [45627, "2024-12-01"],            // integer serial (manual date)
  [45627.4375, "2024-12-01"],       // fractional serial (form timestamp) — time ignored
  [45261, "2023-12-01"],            // first day of the window
  ["", null],
  [undefined, null],
  ["3/4/2025", "2025-03-04"],       // slash WITHOUT time → M/D
  ["13/4/2025 10:22:01", "2025-04-13"], // slash WITH time → D/M
  ["4/13/2025", "2025-04-13"],
  ["SEPT 9,2025", "2025-09-09"],
  ["SEPTMEBER 12,2025", "2025-09-12"],
  ["JULY 15,2025", "2025-07-15"],
  ["APRIL 3,2025\\", "2025-04-03"],  // trailing junk character
  ["Sept 12,2025", "2025-09-12"],
  ["DEC 01,2024", "2024-12-01"],
  ["Dec 1, 2024", "2024-12-01"],
  ["March 16,2024", "2024-03-16"],
  ["APRIL 23,20-25", null],         // junk year
  ["Feb 10,20255", null],
  ["June 28", null],                // no year
  ["AUH 5,2025", null],             // not a month
  ["GCASH", null],
  ["`", null],
  ["#N/A (Did not find value in VLOOKUP evaluation.)", null],
  ["12345678901", null],
  [3034 * 365, null],               // far-future serial (the "3034" consult rows)
  ["MAX", null],
  ["Viber", null],
];

export const DOB_CASES: ReadonlyArray<[cell: unknown, expected: string | null]> = [
  [32874, "1990-01-01"],
  ["SEPT 12,1990", "1990-09-12"],
  ["SEPT. 12, 1990", "1990-09-12"],
  ["FEBUARY 26,2019", "2019-02-26"],
  ["08-15-1948", "1948-08-15"],
  ["12/25/1980", "1980-12-25"],
  ["15-Jul-1966", "1966-07-15"],
  ["SEPT 9", null],
  ["SEPT 9,19900", null],
  ["-", null],
  ["labian", null],
  ["", null],
];
```

- [ ] **Step 2: Write the failing tests** `src/lib/sheet-sync/dates.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DOB_CASES, EVENT_DATE_CASES } from "./__fixtures__/date-cells";
import { parseDobCell, parseEventDateCell, serialToISODate } from "./dates";

const TODAY = "2026-09-24";

describe("serialToISODate", () => {
  it("converts by integer arithmetic (25569 = 1970-01-01)", () => {
    expect(serialToISODate(25569)).toBe("1970-01-01");
    expect(serialToISODate(25569 + 59)).toBe("1970-03-01");
    expect(serialToISODate(45350)).toBe("2024-02-29");  // leap day
    expect(serialToISODate(45627.99)).toBe("2024-12-01");
    expect(serialToISODate(Number.NaN)).toBeNull();
  });
});

describe("parseEventDateCell", () => {
  it.each(EVENT_DATE_CASES)("%j → %s", (cell, expected) => {
    expect(parseEventDateCell(cell, TODAY).iso).toBe(expected);
  });
  it("flags junk as an issue but treats blank as undated, not an issue", () => {
    expect(parseEventDateCell("", TODAY).issue).toBeNull();
    expect(parseEventDateCell("GCASH", TODAY).issue).toBe("unparseable");
    expect(parseEventDateCell(46000, TODAY)).toEqual({ iso: "2025-12-09", issue: null });
  });
  it("rejects dates after today (Manila) and before 2023-12-01", () => {
    expect(parseEventDateCell("9/25/2026", TODAY).issue).toBe("out_of_range");
    expect(parseEventDateCell("11/30/2023", TODAY).issue).toBe("out_of_range");
    expect(parseEventDateCell("9/24/2026", TODAY).iso).toBe("2026-09-24");
  });
  it("rejects impossible calendar dates", () => {
    expect(parseEventDateCell("2/30/2025", TODAY).iso).toBeNull();
  });
});

describe("parseDobCell", () => {
  it.each(DOB_CASES)("%j → %s", (cell, expected) => {
    expect(parseDobCell(cell, TODAY).iso).toBe(expected);
  });
});
```

- [ ] **Step 3: Run** `npx vitest run src/lib/sheet-sync/dates.test.ts` → FAIL.

- [ ] **Step 4: Implement** `src/lib/sheet-sync/dates.ts`:

```ts
/**
 * Sheet date cells (spec §5.1). Read with dateTimeRenderOption=SERIAL_NUMBER,
 * so a real date cell arrives as a serial (days since 1899-12-30; 25569 =
 * 1970-01-01) and anything typed as text arrives as its text. Each cell is
 * parsed on its own — never by block — and range-checked.
 *
 * No Date objects: the serial is converted with Howard Hinnant's
 * civil-from-days integer algorithm, so there is no timezone in the path
 * (manila-usage.test.ts bans the Date shortcuts).
 */
import { daysInMonth } from "../dates/manila";

export const WINDOW_FLOOR = "2023-12-01";
const DOB_FLOOR = "1900-01-01";
const EPOCH_SERIAL = 25569;

export type DateIssue = "unparseable" | "out_of_range" | null;
export interface DateParse {
  iso: string | null;
  issue: DateIssue;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

function civilFromDays(z0: number): string {
  const z = z0 + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

export function serialToISODate(serial: number): string | null {
  if (!Number.isFinite(serial)) return null;
  const days = Math.floor(serial) - EPOCH_SERIAL;
  if (days < -80000 || days > 80000) return null; // outside 1750..2189 — junk
  return civilFromDays(days);
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function ymd(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || y < 1000 || y > 9999) return null;
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > daysInMonth(y, m)) return null;
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

function parseText(raw: string): string | null {
  const s = raw.trim().replace(/[^A-Za-z0-9]+$/, "");
  if (!s) return null;
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(\s+\d{1,2}:\d{2}(:\d{2})?)?$/.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = Number(m[3]);
    // With a time it is a form timestamp typed D/M; without, the sheet's M/D.
    return m[4] ? ymd(y, b, a) : ymd(y, a, b);
  }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return ymd(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s);
  if (m) return ymd(Number(m[3]), Number(m[1]), Number(m[2]));
  m = /^(\d{1,2})-([A-Za-z]{3,})-(\d{4})$/.exec(s);
  if (m) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    return mo ? ymd(Number(m[3]), mo, Number(m[1])) : null;
  }
  m = /^([A-Za-z]{3,})\.?\s*(\d{1,2})\s*,?\s*(\d{4})$/.exec(s);
  if (m) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    return mo ? ymd(Number(m[3]), mo, Number(m[2])) : null;
  }
  return null;
}

function parseCell(cell: unknown, floor: string, today: string): DateParse {
  if (cell === null || cell === undefined) return { iso: null, issue: null };
  if (typeof cell === "string" && cell.trim() === "") return { iso: null, issue: null };
  let iso: string | null = null;
  if (typeof cell === "number") iso = serialToISODate(cell);
  else if (typeof cell === "string") iso = parseText(cell);
  if (!iso) return { iso: null, issue: "unparseable" };
  if (iso < floor || iso > today) return { iso: null, issue: "out_of_range" };
  return { iso, issue: null };
}

/** Registration / service / release dates: 2023-12-01 ≤ d ≤ today (Manila). */
export function parseEventDateCell(cell: unknown, todayManila: string): DateParse {
  return parseCell(cell, WINDOW_FLOOR, todayManila);
}

/** Dates of birth: 1900-01-01 ≤ d ≤ today. */
export function parseDobCell(cell: unknown, todayManila: string): DateParse {
  return parseCell(cell, DOB_FLOOR, todayManila);
}
```

Check `daysInMonth`'s signature in `src/lib/dates/manila.ts` (`daysInMonth(year, month)` with 1-based month per the export list). If it is 0-based, adapt the call and add a test for February 2024.

- [ ] **Step 5: Run** `npx vitest run src/lib/sheet-sync/dates.test.ts src/lib/dates` → PASS (includes `manila-usage.test.ts`, which must stay green).

- [ ] **Step 6: Commit** — `git add src/lib/sheet-sync/dates.ts src/lib/sheet-sync/dates.test.ts src/lib/sheet-sync/__fixtures__/date-cells.ts && git commit -m "feat(sheet-sync): per-cell sheet date parsing with range checks"`

---

### Task 3: Referral answer mapper

**Files:**
- Create: `src/lib/sheet-sync/referral-mapper.ts`, `src/lib/sheet-sync/referral-mapper.test.ts`, `src/lib/sheet-sync/__fixtures__/answers.ts`

This task only needs the **ids as strings**. The six new ids join `REFERRAL_SOURCE_IDS` in Task 8, so type the mapper's result as `string` here and tighten it to `ReferralSourceId` in Task 8.

- [ ] **Step 1: Write the fixture** `src/lib/sheet-sync/__fixtures__/answers.ts`. It holds every live spelling on 2026-09-24 **except** those naming a person (excluded: "SON OF DOC …", "SIR. …"; D7). `null` = Not recorded.

```ts
/** Live "How did you know about DR Med?" spellings (2026-09-24) → expected channel. No personal names. */
export const ANSWER_CASES: ReadonlyArray<[answer: string, expected: string | null]> = [
  ["", null], ["  ", null],
  ["Walk-In", "walk_in"], ["WALK IN", "walk_in"], ["walk in", "walk_in"], ["WALK IN ", "walk_in"],
  ["WALKIN ", "walk_in"], ["WALK IN - APPOINTMENT", "walk_in"], ["WALK IN- THE OTHER DAY", "walk_in"],
  ["WALK IN - NAILS GLOW", "walk_in"],
  ["Walk-in (Saw Poster / Signage)", "walk_in_signage"],
  ["Facebook (Online)", "online_facebook"], ["FACEBOOK", "online_facebook"], ["Facebook", "online_facebook"],
  ["FACEBOK", "online_facebook"],
  ["Google (Online)", "online_google"], ["GOOGLE", "online_google"],
  ["Website (Online)", "online_website"], ["WEBSITE", "online_website"],
  ["Doctor Referral", "doctor_referral"], ["DOCTOR'S REFFERAL", "doctor_referral"],
  ["DOCTOR'S REFERRAL", "doctor_referral"], ["DOCTOR'REFFERAL", "doctor_referral"],
  ["DOCTO'S REFFERAL", "doctor_referral"], ["DOCTOR' REFFERAL", "doctor_referral"],
  ["DOCTOR'S REFFERAL ", "doctor_referral"],
  ["Customer Referral", "customer_referral"], ["CUSTOMER REFFERAL", "customer_referral"],
  ["CUSTOMER REFERRAL", "customer_referral"], ["CUSTOMER'S REFFERAL", "customer_referral"],
  ["CUSTOMER' REFFERAL", "customer_referral"], ["customer referral", "customer_referral"],
  ["Family / Friends", "family_friends"], ["FAMILY/FRIENDS", "family_friends"], ["FAMILY/ FRIENDS", "family_friends"],
  ["Family/Friends", "family_friends"], ["FRIENDS/FAMILY", "family_friends"], ["FAMIL/FRIENDS", "family_friends"],
  ["FAMILY/ FRIENDS ", "family_friends"], ["FAMILY/FRIENS", "family_friends"], ["FAMILY FRIENDS", "family_friends"],
  ["family/friends", "family_friends"], ["FAMILY/FIRIENDS", "family_friends"], ["family/ friends", "family_friends"],
  ["FAMIL.FRIENDS", "family_friends"], ["FAMILY REFERRAL", "family_friends"], ["FAMILY/FRINEDS", "family_friends"],
  ["DAMILY/ FRIENDS", "family_friends"], ["FAMILY/FRIEND", "family_friends"], ["FAMLIY/FRIENDS", "family_friends"],
  ["Family and Friends", "family_friends"], ["FAMILY / FRIENDS", "family_friends"],
  ["PHONE CALL", "phone_text_viber"], ["Phone Call", "phone_text_viber"], ["phone call", "phone_text_viber"],
  ["VIBER", "phone_text_viber"], ["CALL/TEXT", "phone_text_viber"], ["PHONE", "phone_text_viber"],
  ["PHONE TEXT", "phone_text_viber"], ["TEXT", "phone_text_viber"], ["PHONECALL", "phone_text_viber"],
  ["CALL", "phone_text_viber"], [" CALL", "phone_text_viber"],
  ["Prefer Not To Say", "prefer_not_to_say"],
  ["Flyers", "flyers"],
  ["WOMEN'S", "partner_corporate"], ["WOMENS", "partner_corporate"], ["WOMEN'S ULTASOUND", "partner_corporate"],
  ["WALK IN/ WOMEN'S UTZ", "partner_corporate"], ["LIKHAAN", "partner_corporate"], ["SAFEMOMS", "partner_corporate"],
  ["NORTHRIDGE ", "tenant_employee_northridge"], ["NORTHRIDGE TENANT", "tenant_employee_northridge"],
  ["NORTHRIDGE", "tenant_employee_northridge"], ["ADMIN - NORTHRIDGE", "tenant_employee_northridge"],
  ["RETURNING PX", "returning_patient"], ["OLD PATIENT", "returning_patient"], ["OLD PX", "returning_patient"],
  ["OLD PATIENT/WALK IN", "returning_patient"], ["REGULAR PX", "returning_patient"],
  ["REPEAT PATIENT", "returning_patient"],
  ["GIFT CODE", "gift_code"],
  // Deliberately unmapped → "other" + an unmapped_source review item.
  ["CUSTOMER LIST", "other"], ["PHYSICAL COPY", "other"], ["alam", "other"], ["METAL ", "other"], ["MAX'S", "other"],
];

/** Answers that must stay "other" (the admin maps them via an alias). */
export const KNOWN_UNMAPPED = new Set(["CUSTOMER LIST", "PHYSICAL COPY", "ALAM", "METAL", "MAXS"]);
```

- [ ] **Step 2: Write the failing tests** `src/lib/sheet-sync/referral-mapper.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ANSWER_CASES, KNOWN_UNMAPPED } from "./__fixtures__/answers";
import { mapAnswer, normalizeAnswer } from "./referral-mapper";

describe("normalizeAnswer", () => {
  it("uppercases, strips punctuation, folds typos", () => {
    expect(normalizeAnswer("DOCTOR'S REFFERAL ")).toBe("DOCTOR REFERRAL");
    expect(normalizeAnswer("Family / Friends")).toBe("FAMILY FRIENDS");
    expect(normalizeAnswer("RETURNING PX")).toBe("RETURNING PATIENT");
    expect(normalizeAnswer("WALKIN ")).toBe("WALK IN");
    expect(normalizeAnswer("   ")).toBe("");
  });
});

describe("mapAnswer over every live spelling", () => {
  it.each(ANSWER_CASES)("%j → %s", (answer, expected) => {
    expect(mapAnswer(answer, new Map()).id).toBe(expected);
  });
  it("no known spelling lands in 'other' unless it is on the deliberate list", () => {
    for (const [answer] of ANSWER_CASES) {
      const r = mapAnswer(answer, new Map());
      if (r.id === "other") expect(KNOWN_UNMAPPED.has(r.norm)).toBe(true);
    }
  });
  it("marks 'other' results as unmapped so a review item is raised", () => {
    expect(mapAnswer("CUSTOMER LIST", new Map()).unmapped).toBe(true);
    expect(mapAnswer("FACEBOOK", new Map()).unmapped).toBe(false);
    expect(mapAnswer("", new Map()).unmapped).toBe(false);
  });
  it("an admin alias wins over the rules", () => {
    const aliases = new Map([["CUSTOMER LIST", "returning_patient"]]);
    expect(mapAnswer("customer list", aliases)).toEqual({ id: "returning_patient", norm: "CUSTOMER LIST", unmapped: false });
  });
});
```

- [ ] **Step 3: Run** → FAIL.

- [ ] **Step 4: Implement** `src/lib/sheet-sync/referral-mapper.ts`:

```ts
/**
 * "How did you know about DR Med?" → referral_sources id (spec §4.1).
 * Order: (1) admin alias on the normalised answer, (2) ordered rules,
 * (3) blank → null ("Not recorded"), (4) anything else → "other" + unmapped
 * (the sync raises an unmapped_source review item). Rule order matters:
 * the more specific channel is listed before the one its words also match
 * ("WALK IN/ WOMEN'S UTZ" is a partner, "OLD PATIENT/WALK IN" is returning).
 */

const TOKEN_FOLDS: ReadonlyArray<[RegExp, string]> = [
  [/^REF+ER+AL$/, "REFERRAL"],
  [/^(FAMIL|FAMILY|FAMLIY|DAMILY)$/, "FAMILY"],
  [/^(FRIENDS?|FRIENS|FIRIENDS|FRINEDS)$/, "FRIENDS"],
  [/^FACEBO+K$|^FACEBOK$/, "FACEBOOK"],
  [/^(DOCTO|DOCTORS|DOCTOR)$/, "DOCTOR"],
  [/^CUSTOMERS?$/, "CUSTOMER"],
  [/^PX$/, "PATIENT"],
  [/^WOMENS?$/, "WOMEN"],
  [/^FLYER$/, "FLYERS"],
];

export function normalizeAnswer(raw: unknown): string {
  const text = String(raw ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/WALKIN/g, "WALK IN")
    .replace(/PHONECALL/g, "PHONE CALL")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
  if (!text) return "";
  return text
    .split(" ")
    .filter((t) => t !== "S")
    .map((t) => {
      for (const [re, to] of TOKEN_FOLDS) if (re.test(t)) return to;
      return t;
    })
    .join(" ");
}

const RULES: ReadonlyArray<[id: string, test: RegExp]> = [
  ["prefer_not_to_say", /\bPREFER NOT\b/],
  ["walk_in_signage", /\bWALK IN\b.*\b(POSTER|SIGNAGE|SIGN)\b/],
  ["returning_patient", /\b(RETURNING|OLD|REGULAR|REPEAT) PATIENT\b/],
  ["tenant_employee_northridge", /\bNORTHRIDGE\b/],
  ["partner_corporate", /\b(WOMEN|LIKHAAN|SAFEMOMS|GICA)\b/],
  ["family_friends", /\b(FAMILY|FRIENDS)\b/],
  ["customer_referral", /\bCUSTOMER REFERRAL\b/],
  ["doctor_referral", /\bDOCTOR REFERRAL\b/],
  ["online_facebook", /\b(FACEBOOK|FB|MESSENGER)\b/],
  ["online_google", /\bGOOGLE\b/],
  ["online_website", /\bWEBSITE\b/],
  ["online_instagram", /\b(INSTAGRAM|IG)\b/],
  ["online_tiktok", /\bTIK ?TOK\b/],
  ["phone_text_viber", /\b(PHONE|CALL|TEXT|VIBER|SMS)\b/],
  ["flyers", /\bFLYERS\b/],
  ["gift_code", /\b(GIFT CODE|VOUCHER)\b/],
  ["walk_in", /\bWALK IN\b/],
];

export interface MappedAnswer {
  id: string | null;
  norm: string;
  unmapped: boolean;
}

export function mapAnswer(raw: unknown, aliases: ReadonlyMap<string, string>): MappedAnswer {
  const norm = normalizeAnswer(raw);
  if (!norm) return { id: null, norm, unmapped: false };
  const alias = aliases.get(norm);
  if (alias) return { id: alias, norm, unmapped: false };
  for (const [id, re] of RULES) if (re.test(norm)) return { id, norm, unmapped: false };
  return { id: "other", norm, unmapped: true };
}
```

- [ ] **Step 5: Run** `npx vitest run src/lib/sheet-sync/referral-mapper.test.ts` → PASS. If one spelling fails, fix the fold or rule, **not** the fixture. The fixture is the owner-facing contract.

- [ ] **Step 6: Commit** — `git commit -m "feat(sheet-sync): referral answer mapper covering every live spelling"` (add the three files).

---

### Task 4: Shared types and tab parsers

**Files:**
- Create: `src/lib/sheet-sync/types.ts`, `src/lib/sheet-sync/tabs/headers.ts`, `src/lib/sheet-sync/tabs/customers.ts`, `src/lib/sheet-sync/tabs/encounters.ts`, `src/lib/sheet-sync/tabs/tabs.test.ts`

- [ ] **Step 1: Write `types.ts`** (no test — types only):

```ts
export type TabKey = "customers" | "lab" | "consult";

export const SHEET_TAB_NAMES: Record<TabKey, string> = {
  customers: "CUSTOMER LIST2",
  lab: "LAB SERVICE",
  consult: "DOCTOR CONSULTATION",
};

export type Cell = string | number | boolean | null | undefined;
export type RawTabs = Record<TabKey, Cell[][]>;

export type ReviewKind =
  | "ambiguous_patient" | "identity_conflict" | "possible_existing_patient"
  | "unmapped_source" | "unparseable_date" | "invalid_row" | "suspect_snapshot";

export interface ReviewItemInput {
  kind: ReviewKind;
  item_key: string;
  payload: Record<string, unknown>;
}

export interface CustomerRow {
  sheetRow: number;              // 1-based row number as the sheet shows it
  fullNameRaw: string;
  first: string | null;
  middle: string | null;
  last: string | null;
  nameNorm: string;
  looseKey: string;
  linkKey: string;
  tokens: string[];
  phoneE164: string | null;
  phone10: string | null;
  email: string | null;
  dob: string | null;
  sex: "male" | "female" | null;
  address: string | null;
  referredByDoctor: string | null;   // "Doctor" column — same field the May import filled
  referredByRaw: string | null;      // "Referred By:" column — mirror only (PR 2)
  releaseMedium: string | null;
  releaseMediumRaw: string | null;
  seniorKind: "senior" | "pwd" | null;
  seniorNumber: string | null;
  registeredOn: string | null;
  sourceRaw: string;
  sourceNorm: string;
  referralSourceId: string | null;
  unmappedSource: boolean;
  newRepeat: "new" | "repeat" | null;
  raw: Record<string, string>;       // header → cell text, same shape as legacy_intake.raw
  rowHash: string;
  sourceKey: string;
  dupCount: number;
}

export interface EncounterLine {
  tab: "lab" | "consult";
  sheetRow: number;
  serviceDate: string;
  nameRaw: string;
  first: string | null;
  middle: string | null;
  last: string | null;
  nameNorm: string;
  looseKey: string;
  tokens: string[];
  serviceRaw: string | null;
  doctorRaw: string | null;
  hmoRaw: string | null;
  basePhp: number | null;
  finalPhp: number | null;
  clinicFeePhp: number | null;
  revenuePhp: number | null;
  paymentMethodRaw: string | null;
  paymentDetailRaw: string | null;
  releaseMediumRaw: string | null;
  releasedOn: string | null;
  controlNo: string | null;
  testNo: string | null;
  raw: Cell[];
  rowHash: string;
}

export interface TabParse<T> {
  rows: T[];
  rowsRead: number;          // named rows in the whole tab (snapshot check basis)
  lastDate: string | null;   // "sheet last updated" shown on the admin page
  undated: number;
  issues: ReviewItemInput[];
}
```

- [ ] **Step 2: Write the shared header fixture** `src/lib/sheet-sync/__fixtures__/tab-headers.ts` — the real header rows from §1, exported as `CUST_HEADER`, `LAB_H0`, `LAB_H1`, `CONS_H0`, `CONS_H1` (move the five constants below into it verbatim, each `export const … : unknown[] = [...]`). Tests in Tasks 4, 5 and 11 import them.

- [ ] **Step 2b: Write the failing tests** `src/lib/sheet-sync/tabs/tabs.test.ts`, with invented people. The `_CUST_HEADER_REFERENCE`, `LAB_H0`, `LAB_H1`, `CONS_H0`, `CONS_H1` declarations shown inline below are the CONTENT of the fixture file (`_CUST_HEADER_REFERENCE` is `CUST_HEADER`). Put them there and **delete them from the test file**, which only imports them:

```ts
import { describe, expect, it } from "vitest";
import { CONS_H0, CONS_H1, CUST_HEADER, LAB_H0, LAB_H1 } from "../__fixtures__/tab-headers";
import { parseCustomersTab } from "./customers";
import { parseConsultTab, parseLabTab } from "./encounters";

const TODAY = "2026-09-24";
// Header constants (moved to __fixtures__/tab-headers.ts in Step 2):
const _CUST_HEADER_REFERENCE = ["Last Name","First Name","M.I.","#","Full Name","Gender","Date of Birth","Age",
  "Address (#, Street Name) ","Address (Barangay) ","Address (City) ","Contact Number","Email address",
  "Senior / PWD ID","Senior / PWD ID Number","Doctor","How did you know about DR Med?","Referred By: ",
  "Preferred Medium of Result Release","New / Repeat","Timestamp","Column 21"];
const cust = (over: Record<number, unknown>) => {
  const r: unknown[] = new Array(22).fill("");
  r[4] = "Dela Cruz, Juan Santos"; r[5] = "Male"; r[6] = 32874; r[11] = 9171234567;
  r[16] = "FACEBOOK"; r[19] = "NEW"; r[20] = 46000.5;
  for (const [k, v] of Object.entries(over)) r[Number(k)] = v;
  return r;
};

describe("parseCustomersTab", () => {
  it("parses a row with the May importer's name/phone/sex rules", () => {
    const p = parseCustomersTab([CUST_HEADER, cust({})], { today: TODAY, aliases: new Map() });
    expect(p.rows).toHaveLength(1);
    const r = p.rows[0];
    expect(r).toMatchObject({
      sheetRow: 2, first: "Juan", middle: "Santos", last: "Dela Cruz",
      nameNorm: "dela cruz|juan santos", dob: "1990-01-01", phoneE164: "+639171234567",
      phone10: "9171234567", sex: "male", referralSourceId: "online_facebook", newRepeat: "new",
      registeredOn: "2025-12-09", dupCount: 1,
    });
    expect(r.raw["How did you know about DR Med?"]).toBe("FACEBOOK");
  });
  it("collapses exact duplicates into one row with a count", () => {
    const p = parseCustomersTab([CUST_HEADER, cust({}), cust({})], { today: TODAY, aliases: new Map() });
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0].dupCount).toBe(2);
    expect(p.rowsRead).toBe(2);
  });
  it("raises unparseable_date for junk timestamps and keeps the row undated", () => {
    const p = parseCustomersTab([CUST_HEADER, cust({ 20: "GCASH" })], { today: TODAY, aliases: new Map() });
    expect(p.rows[0].registeredOn).toBeNull();
    expect(p.issues.map((i) => i.kind)).toEqual(["unparseable_date"]);
  });
  it("raises invalid_row when first or last name is missing", () => {
    const p = parseCustomersTab([CUST_HEADER, cust({ 4: "Madonna" })], { today: TODAY, aliases: new Map() });
    expect(p.rows).toHaveLength(0);
    expect(p.issues[0].kind).toBe("invalid_row");
  });
  it("refuses a tab whose headers moved", () => {
    const moved = [...CUST_HEADER]; moved.splice(4, 0, "New column");
    expect(() => parseCustomersTab([moved], { today: TODAY, aliases: new Map() })).toThrow(/header/i);
  });
});

const LAB_H0 = [" ","CONTROL NO","TEST NO","PATIENT NAME","HMO","","","SERVICE","BASE PRICE","SENIOR/\nPWD (20%)",
  "DISCOUNT (10%)","DISCOUNT (5%)","ACTUAL DISCOUNT","FINAL PRICE (LESS DISCOUNTS)","PAYMENT METHOD","",
  "RESULT RELEASE","","REMARKS","DATE (PLACE HOLDER)"];
const LAB_H1 = ["","","","","YES / NO","PROVIDER","APPROVAL DATE","","","","","","","","PAID","REF",
  "PREFERRED MEDIUM","DATE RELEASED"];
const CONS_H0 = ["DATE","CONTROL NO","TEST NO.","PATIENT NAME","HMO","","","DOCTOR CONSULTANT","BASE PRICE\n(VARIABLE)",
  "SENIOR/PWD\n(20%)","OTHER DISCOUNTS \n(20%)","FINAL PRICE (LESS DISCOUNTS)","CLINIC \nFEE","  ","","REMARKS"];
const CONS_H1 = ["","","","","YES / NO","PROVIDER","APPROVAL DATE","","","","","","","PAID","REFERENCE"];

describe("parseLabTab / parseConsultTab", () => {
  const WIN = "2026-05-26";
  it("keeps only rows inside [window start, today] and uses FINAL PRICE as revenue", () => {
    const rows = [LAB_H0, LAB_H1,
      [46168, 1, 10, "Dela Cruz, Juan", "N/A", "", "", "CBC", 350, "", "", "", "", 300, "CASH", "", "Viber", 46169],
      [45261, 2, 11, "Reyes, Ana", "N/A", "", "", "CBC", 350, "", "", "", "", 350, "CASH", "", "", ""]];
    const p = parseLabTab(rows, { today: TODAY, windowStart: WIN });
    expect(p.rowsRead).toBe(2);
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]).toMatchObject({ serviceDate: "2026-05-26", finalPhp: 300, revenuePhp: 300,
      paymentMethodRaw: "CASH", releaseMediumRaw: "Viber", releasedOn: "2026-05-27", testNo: "10", controlNo: "1" });
    expect(p.lastDate).toBe("2026-05-26");
  });
  it("uses the CLINIC FEE as the consult revenue basis", () => {
    const rows = [CONS_H0, CONS_H1, [],
      [46168, "", "", "Dela Cruz, Juan", "N/A", "", "", "DR. A", 1000, "", "", 1000, 300, "CASH", "", ""]];
    const p = parseConsultTab(rows, { today: TODAY, windowStart: WIN });
    expect(p.rows[0]).toMatchObject({ finalPhp: 1000, clinicFeePhp: 300, revenuePhp: 300, doctorRaw: "DR. A",
      paymentMethodRaw: "CASH" });
  });
  it("reports junk dates as review items instead of dropping them silently", () => {
    const rows = [CONS_H0, CONS_H1, [3034 * 365, "", "", "Dela Cruz, Juan", "", "", "", "DR. A", 1, "", "", 1, 1, "CASH"]];
    const p = parseConsultTab(rows, { today: TODAY, windowStart: WIN });
    expect(p.rows).toHaveLength(0);
    expect(p.issues[0].kind).toBe("unparseable_date");
  });
});
```

- [ ] **Step 3: Run** `npx vitest run src/lib/sheet-sync/tabs` → FAIL.

- [ ] **Step 4: Implement `tabs/headers.ts`:**

```ts
import type { Cell } from "../types";

export class HeaderMismatchError extends Error {
  constructor(tab: string, detail: string) {
    super(`${tab}: header changed (${detail}) — the sync refuses to guess column positions`);
    this.name = "HeaderMismatchError";
  }
}

const norm = (c: Cell) => String(c ?? "").replace(/\s+/g, " ").trim().toUpperCase();

/** Each expectation: [row, column, required prefix]. */
export function assertHeaders(tab: string, rows: Cell[][], expect: ReadonlyArray<[number, number, string]>): void {
  for (const [r, c, prefix] of expect) {
    const got = norm(rows[r]?.[c]);
    if (!got.startsWith(prefix.toUpperCase())) {
      throw new HeaderMismatchError(tab, `row ${r + 1} col ${c + 1}: expected "${prefix}…", got "${got}"`);
    }
  }
}

export const CUSTOMER_HEADERS: ReadonlyArray<[number, number, string]> = [
  [0, 4, "Full Name"], [0, 5, "Gender"], [0, 6, "Date of Birth"], [0, 11, "Contact Number"],
  [0, 12, "Email"], [0, 15, "Doctor"], [0, 16, "How did you know"], [0, 17, "Referred By"],
  [0, 18, "Preferred Medium"], [0, 19, "New / Repeat"], [0, 20, "Timestamp"],
];
export const LAB_HEADERS: ReadonlyArray<[number, number, string]> = [
  [0, 1, "CONTROL NO"], [0, 2, "TEST NO"], [0, 3, "PATIENT NAME"], [0, 7, "SERVICE"], [0, 8, "BASE PRICE"],
  [0, 13, "FINAL PRICE"], [0, 14, "PAYMENT METHOD"], [0, 16, "RESULT RELEASE"], [1, 15, "REF"], [1, 17, "DATE RELEASED"],
];
export const CONSULT_HEADERS: ReadonlyArray<[number, number, string]> = [
  [0, 0, "DATE"], [0, 1, "CONTROL NO"], [0, 3, "PATIENT NAME"], [0, 7, "DOCTOR CONSULTANT"],
  [0, 8, "BASE PRICE"], [0, 11, "FINAL PRICE"], [0, 12, "CLINIC"], [1, 13, "PAID"], [1, 14, "REFERENCE"],
];
```

- [ ] **Step 5: Implement `tabs/customers.ts`:**

```ts
import { parseName } from "../../legacy-import/name-parser";
import { normalizePhone } from "../../legacy-import/phone-normalizer";
import { mapReleaseMedium, mapSeniorPwdKind, mapSex } from "../../legacy-import/vocabulary-mapper";
import { parseDobCell, parseEventDateCell } from "../dates";
import { linkKeyOf, looseKeyOf, nameNormOf, phone10, sha1Hex, sourceKeyOf, tokensOf } from "../names";
import { mapAnswer } from "../referral-mapper";
import type { Cell, CustomerRow, ReviewItemInput, TabParse } from "../types";
import { assertHeaders, CUSTOMER_HEADERS } from "./headers";

const text = (c: Cell): string => (c === null || c === undefined ? "" : String(c)).trim();
const orNull = (s: string) => (s ? s : null);

function newRepeatOf(c: Cell): "new" | "repeat" | null {
  const t = text(c).toUpperCase();
  if (t === "NEW") return "new";
  if (t === "REPEAT" || t === "OLD") return "repeat";
  return null;
}

export function parseCustomersTab(
  rows: Cell[][],
  opts: { today: string; aliases: ReadonlyMap<string, string> },
): TabParse<CustomerRow> {
  assertHeaders("CUSTOMER LIST2", rows, CUSTOMER_HEADERS);
  const header = (rows[0] ?? []).map((h) => String(h ?? ""));
  const byKey = new Map<string, CustomerRow>();
  const issues: ReviewItemInput[] = [];
  let rowsRead = 0;
  let undated = 0;
  let lastDate: string | null = null;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] ?? [];
    const fullName = text(r[4]);
    if (!fullName && !text(r[0]) && !text(r[1])) continue;
    rowsRead++;
    const sheetRow = i + 1;
    const rowHash = sha1Hex(JSON.stringify(r));
    const name = parseName(fullName, text(r[0]), text(r[1]), text(r[2]));
    if (name.unparseable || !name.first_name || !name.last_name) {
      issues.push({ kind: "invalid_row", item_key: `customers:${rowHash}`,
        payload: { tab: "customers", sheet_row: sheetRow, reason: "name needs a surname and a first name", name_raw: fullName } });
      continue;
    }
    const parts = { first: name.first_name, middle: name.middle_name, last: name.last_name };
    const dobP = parseDobCell(r[6], opts.today);
    const regP = parseEventDateCell(r[20], opts.today);
    const phone = normalizePhone(text(r[11]));
    const answer = mapAnswer(r[16], opts.aliases);
    const release = mapReleaseMedium(text(r[18]));
    const nameNorm = nameNormOf(parts);
    const p10 = phone10(r[11]);
    const sourceKey = sourceKeyOf(nameNorm, p10, dobP.iso, regP.iso);

    const existing = byKey.get(sourceKey);
    if (existing) {
      existing.dupCount++;
      continue;
    }
    if (regP.issue) issues.push({ kind: "unparseable_date", item_key: `customers:${sourceKey}:registered_on`,
      payload: { tab: "customers", sheet_row: sheetRow, column: "Timestamp", value: text(r[20]), name_raw: fullName } });
    if (dobP.issue) issues.push({ kind: "unparseable_date", item_key: `customers:${sourceKey}:dob`,
      payload: { tab: "customers", sheet_row: sheetRow, column: "Date of Birth", value: text(r[6]), name_raw: fullName } });
    if (regP.iso === null) undated++;
    if (regP.iso && (!lastDate || regP.iso > lastDate)) lastDate = regP.iso;

    const kind = mapSeniorPwdKind(text(r[13]));
    const seniorNumber = orNull(text(r[14]));
    const address = [text(r[8]), text(r[9]), text(r[10])].filter(Boolean).join(", ").replace(/\s+/g, " ");
    const raw: Record<string, string> = {};
    header.forEach((h, c) => { if (h) raw[h] = text(r[c]); });

    byKey.set(sourceKey, {
      sheetRow, fullNameRaw: fullName, ...parts, nameNorm, looseKey: looseKeyOf(parts),
      linkKey: linkKeyOf(nameNorm, dobP.iso), tokens: tokensOf(parts),
      phoneE164: phone.e164, phone10: p10, email: orNull(text(r[12]).toLowerCase()), dob: dobP.iso,
      sex: mapSex(text(r[5])), address: orNull(address),
      referredByDoctor: orNull(text(r[15])), referredByRaw: orNull(text(r[17])),
      releaseMedium: release.id, releaseMediumRaw: orNull(text(r[18])),
      seniorKind: kind && seniorNumber ? kind : null, seniorNumber: kind && seniorNumber ? seniorNumber : null,
      registeredOn: regP.iso, sourceRaw: text(r[16]), sourceNorm: answer.norm, referralSourceId: answer.id,
      unmappedSource: answer.unmapped, newRepeat: newRepeatOf(r[19]), raw, rowHash, sourceKey, dupCount: 1,
    });
  }
  return { rows: [...byKey.values()], rowsRead, lastDate, undated, issues };
}
```

Note: `unmapped_source` items are raised by the plan (Task 5), aggregated per answer, not per row.

- [ ] **Step 6: Implement `tabs/encounters.ts`:**

```ts
import { parseName } from "../../legacy-import/name-parser";
import { parseEventDateCell } from "../dates";
import { looseKeyOf, nameNormOf, sha1Hex, tokensOf } from "../names";
import type { Cell, EncounterLine, ReviewItemInput, TabParse } from "../types";
import { assertHeaders, CONSULT_HEADERS, LAB_HEADERS } from "./headers";

const text = (c: Cell): string => (c === null || c === undefined ? "" : String(c)).trim();
const orNull = (s: string) => (s ? s : null);

/** Numbers arrive as numbers; typed amounts as "1,970" / "₱350" / "N/A". */
export function money(c: Cell): number | null {
  if (typeof c === "number") return Number.isFinite(c) ? Math.round(c * 100) / 100 : null;
  const t = text(c).replace(/[₱,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Math.round(Number(t) * 100) / 100;
}

interface Layout {
  tab: "lab" | "consult";
  sheetName: string;
  headers: ReadonlyArray<[number, number, string]>;
  firstDataRow: number;
  map: (r: Cell[], today: string) => Omit<EncounterLine,
    "tab" | "sheetRow" | "serviceDate" | "nameRaw" | "first" | "middle" | "last" | "nameNorm" | "looseKey" | "tokens" | "raw" | "rowHash">;
}

const LAB: Layout = {
  tab: "lab", sheetName: "LAB SERVICE", headers: LAB_HEADERS, firstDataRow: 2,
  map: (r, today) => ({
    controlNo: orNull(text(r[1])), testNo: orNull(text(r[2])),
    hmoRaw: orNull([text(r[4]), text(r[5])].filter(Boolean).join(" | ")),
    serviceRaw: orNull(text(r[7])), doctorRaw: null,
    basePhp: money(r[8]), finalPhp: money(r[13]), clinicFeePhp: null, revenuePhp: money(r[13]),
    paymentMethodRaw: orNull(text(r[14])), paymentDetailRaw: orNull(text(r[15])),
    releaseMediumRaw: orNull(text(r[16])), releasedOn: parseEventDateCell(r[17], today).iso,
  }),
};

const CONSULT: Layout = {
  tab: "consult", sheetName: "DOCTOR CONSULTATION", headers: CONSULT_HEADERS, firstDataRow: 2,
  map: (r) => ({
    controlNo: orNull(text(r[1])), testNo: orNull(text(r[2])),
    hmoRaw: orNull([text(r[4]), text(r[5])].filter(Boolean).join(" | ")),
    serviceRaw: null, doctorRaw: orNull(text(r[7])),
    basePhp: money(r[8]), finalPhp: money(r[11]), clinicFeePhp: money(r[12]), revenuePhp: money(r[12]),
    paymentMethodRaw: orNull(text(r[13])), paymentDetailRaw: orNull(text(r[14])),
    releaseMediumRaw: null, releasedOn: null,
  }),
};

function parseEncounterTab(layout: Layout, rows: Cell[][], opts: { today: string; windowStart: string }): TabParse<EncounterLine> {
  assertHeaders(layout.sheetName, rows, layout.headers);
  const out: EncounterLine[] = [];
  const issues: ReviewItemInput[] = [];
  let rowsRead = 0;
  let undated = 0;
  let lastDate: string | null = null;
  for (let i = layout.firstDataRow; i < rows.length; i++) {
    const r = rows[i] ?? [];
    const nameRaw = text(r[3]);
    if (!nameRaw) continue;
    rowsRead++;
    const rowHash = sha1Hex(JSON.stringify(r));
    const d = parseEventDateCell(r[0], opts.today);
    if (d.issue) {
      issues.push({ kind: "unparseable_date", item_key: `${layout.tab}:${rowHash}`,
        payload: { tab: layout.tab, sheet_row: i + 1, column: "DATE", value: text(r[0]), name_raw: nameRaw } });
      continue;
    }
    if (!d.iso) { undated++; continue; }
    if (!lastDate || d.iso > lastDate) lastDate = d.iso;
    if (d.iso < opts.windowStart) continue;
    const name = parseName(nameRaw, null, null, null);
    const parts = { first: name.first_name, middle: name.middle_name, last: name.last_name };
    out.push({
      tab: layout.tab, sheetRow: i + 1, serviceDate: d.iso, nameRaw, ...parts,
      nameNorm: nameNormOf(parts), looseKey: looseKeyOf(parts), tokens: tokensOf(parts),
      ...layout.map(r, opts.today), raw: r, rowHash,
    });
  }
  return { rows: out, rowsRead, lastDate, undated, issues };
}

export const parseLabTab = (rows: Cell[][], opts: { today: string; windowStart: string }) => parseEncounterTab(LAB, rows, opts);
export const parseConsultTab = (rows: Cell[][], opts: { today: string; windowStart: string }) => parseEncounterTab(CONSULT, rows, opts);
```

- [ ] **Step 7: Run** `npx vitest run src/lib/sheet-sync` → PASS. Also run `npx vitest run src/lib/dates` (the Manila guards scan new files).

- [ ] **Step 8: Commit** — `git commit -m "feat(sheet-sync): Customers / lab / consult tab parsers with header guards"`

---

### Task 5: Patient index and the Customers identity plan (§5.3)

**Files:**
- Create: `src/lib/sheet-sync/patient-index.ts`, `src/lib/sheet-sync/customer-plan.ts`, `src/lib/sheet-sync/customer-plan.test.ts`
- Modify: `src/lib/sheet-sync/types.ts` (append the plan types below)

- [ ] **Step 1: Append to `types.ts`:**

```ts
export interface PatientRecord {
  id: string;
  drm_id: string;
  first_name: string | null;
  middle_name: string | null;
  last_name: string | null;
  birthdate: string | null;
  phone: string | null;
  phone_normalized: string | null;
  email: string | null;
  sex: string | null;
  address: string | null;
  referred_by_doctor: string | null;
  preferred_release_medium: string | null;
  senior_pwd_id_kind: string | null;
  senior_pwd_id_number: string | null;
  referral_source: string | null;
  referral_source_origin: "staff" | "patient" | "sheet" | null;
  merged_into_id: string | null;
}

export interface LinkRecord {
  link_key: string;
  patient_id: string | null;
  decision: "link" | "create";
  method: "auto_exact" | "auto_loose" | "admin";
}

export interface FactsRecord {
  patient_id: string;
  registered_on: string | null;
  sheet_new_repeat: "new" | "repeat" | null;
  source_ref: string | null;
}

export interface PrevCustomerRow {
  source_key: string;
  patient_id: string | null;
  phone_norm: string | null;
  dob: string | null;
  link_state: string;
}

export type FillFields = Partial<Record<
  | "phone" | "email" | "birthdate" | "sex" | "address" | "referred_by_doctor"
  | "preferred_release_medium" | "senior_pwd_id_kind" | "senior_pwd_id_number" | "referral_source",
  string | null>>;

export type CustomerOp =
  | { op: "create"; create_key: string; method: "auto_exact" | "admin"; link_keys: string[];
      fields: FillFields & { first_name: string; last_name: string; middle_name: string | null };
      legacy_intake: Record<string, unknown>;
      facts: { registered_on: string | null; new_repeat: "new" | "repeat" | null; source_ref: string } }
  | { op: "link"; link_key: string; patient_id: string; method: "auto_exact" | "auto_loose" }
  | { op: "fill"; patient_id: string; fields: FillFields }
  | { op: "facts"; patient_id: string; registered_on: string | null; new_repeat: "new" | "repeat" | null; source_ref: string };

export type LinkState = "linked" | "ambiguous" | "conflict" | "possible_existing" | "unlinked";

export interface CustomerMirrorRow {
  sheet_row: number; source_key: string; dup_count: number; full_name_raw: string; name_norm: string;
  loose_key: string; link_key: string; phone_norm: string | null; dob: string | null; registered_on: string | null;
  source_raw: string; source_norm: string; referral_source_id: string | null; referred_by_raw: string | null;
  new_repeat: "new" | "repeat" | null; release_medium_raw: string | null;
  patient_id: string | null;          // filled after ops for "create:<key>" rows
  pending_create_key: string | null;  // runner swaps it for the created id; never sent to the DB
  link_state: LinkState; row_hash: string;
}

export interface CustomerPlan {
  ops: CustomerOp[];
  mirror: CustomerMirrorRow[];
  review: ReviewItemInput[];
  counts: { rows: number; linked_existing: number; link_new: number; create: number; fill: number;
            facts: number; review: Record<string, number> };
}
```

- [ ] **Step 2: Implement `patient-index.ts`** (tested through the plan tests):

```ts
import { looseKeyOf, nameNormOf, phone10, tokensOf } from "./names";
import type { PatientRecord } from "./types";

export interface PatientIndex {
  byId: Map<string, PatientRecord>;
  /** live patient ids by full nameNorm */
  byFullName: Map<string, string[]>;
  byLoose: Map<string, string[]>;
  byPhone: Map<string, string[]>;
  byDob: Map<string, string[]>;
  tokens: Map<string, string[]>;
  survivor(id: string): string | null;
  isLive(id: string): boolean;
}

const push = (m: Map<string, string[]>, k: string | null, v: string) => {
  if (!k) return;
  const a = m.get(k);
  if (a) a.push(v); else m.set(k, [v]);
};

export function buildPatientIndex(patients: readonly PatientRecord[]): PatientIndex {
  const byId = new Map(patients.map((p) => [p.id, p]));
  const byFullName = new Map<string, string[]>();
  const byLoose = new Map<string, string[]>();
  const byPhone = new Map<string, string[]>();
  const byDob = new Map<string, string[]>();
  const tokens = new Map<string, string[]>();
  for (const p of patients) {
    if (p.merged_into_id) continue;
    const parts = { first: p.first_name, middle: p.middle_name, last: p.last_name };
    push(byFullName, nameNormOf(parts), p.id);
    push(byLoose, looseKeyOf(parts), p.id);
    push(byPhone, p.phone_normalized ?? phone10(p.phone), p.id);
    push(byDob, p.birthdate, p.id);
    tokens.set(p.id, tokensOf(parts));
  }
  const survivor = (id: string): string | null => {
    let cur = byId.get(id);
    for (let hop = 0; cur && cur.merged_into_id && hop < 10; hop++) cur = byId.get(cur.merged_into_id);
    return cur && !cur.merged_into_id ? cur.id : null;
  };
  return { byId, byFullName, byLoose, byPhone, byDob, tokens, survivor,
    isLive: (id) => !!byId.get(id) && !byId.get(id)!.merged_into_id };
}
```

- [ ] **Step 3: Write the failing tests** `src/lib/sheet-sync/customer-plan.test.ts`. Use a local factory for `CustomerRow` (build it through `parseCustomersTab` with the header from Task 4 to avoid hand-building keys) and for `PatientRecord`. Each fixture named in spec §5.3 gets a test:

```ts
import { describe, expect, it } from "vitest";
import { planCustomers } from "./customer-plan";
import { buildPatientIndex } from "./patient-index";
import { parseCustomersTab } from "./tabs/customers";
import type { PatientRecord } from "./types";

const TODAY = "2026-09-24";
import { CUST_HEADER as HEADER } from "./__fixtures__/tab-headers";
function rowsOf(...specs: Array<{ name: string; dob?: number | string; phone?: string | number; ts?: number; src?: string; nr?: string }>) {
  const table = [HEADER, ...specs.map((s) => {
    const r: unknown[] = new Array(22).fill("");
    r[4] = s.name; r[6] = s.dob ?? ""; r[11] = s.phone ?? ""; r[16] = s.src ?? ""; r[19] = s.nr ?? ""; r[20] = s.ts ?? 46000;
    return r;
  })];
  return parseCustomersTab(table as never, { today: TODAY, aliases: new Map() }).rows;
}
let n = 0;
function patient(over: Partial<PatientRecord>): PatientRecord {
  n++;
  return { id: `p${n}`, drm_id: `DRM-${n}`, first_name: "Juan", middle_name: "Santos", last_name: "Dela Cruz",
    birthdate: "1990-01-01", phone: null, phone_normalized: null, email: null, sex: null, address: null,
    referred_by_doctor: null, preferred_release_medium: null, senior_pwd_id_kind: null, senior_pwd_id_number: null,
    referral_source: null, referral_source_origin: null, merged_into_id: null, ...over };
}
const plan = (rows: ReturnType<typeof rowsOf>, patients: PatientRecord[], extra: Partial<Parameters<typeof planCustomers>[0]> = {}) =>
  planCustomers({ rows, index: buildPatientIndex(patients), links: new Map(), facts: new Map(), prevRows: [], ...extra });

describe("planCustomers — §5.3 identity rules", () => {
  it("auto-links exactly one full-name candidate with no conflict", () => {
    const p = patient({});
    const out = plan(rowsOf({ name: "Dela Cruz, Juan Santos", dob: 32874 }), [p]);
    expect(out.ops).toContainEqual({ op: "link", link_key: "dela cruz|juan santos#1990-01-01", patient_id: p.id, method: "auto_exact" });
    expect(out.mirror[0]).toMatchObject({ patient_id: p.id, link_state: "linked" });
  });
  it("hard DOB conflict → identity_conflict review, no link", () => {
    const out = plan(rowsOf({ name: "Dela Cruz, Juan Santos", dob: 33000 }), [patient({})]);
    expect(out.ops.filter((o) => o.op === "link")).toHaveLength(0);
    expect(out.review[0].kind).toBe("identity_conflict");
  });
  it("different phones are allowed only when the DOB matches", () => {
    const p = patient({ phone_normalized: "9170000000" });
    expect(plan(rowsOf({ name: "Dela Cruz, Juan Santos", dob: 32874, phone: "09171112222" }), [p]).review).toHaveLength(0);
    const q = patient({ birthdate: null, phone_normalized: "9170000000" });
    expect(plan(rowsOf({ name: "Dela Cruz, Juan Santos", phone: "09171112222" }), [q]).review[0].kind).toBe("identity_conflict");
  });
  it("several full-name candidates → ambiguous_patient listing them", () => {
    const a = patient({}); const b = patient({ birthdate: null });
    const out = plan(rowsOf({ name: "Dela Cruz, Juan Santos" }), [a, b]);
    expect(out.review[0].kind).toBe("ambiguous_patient");
    expect((out.review[0].payload.candidates as unknown[]).length).toBe(2);
  });
  it("middle name added in the sheet: no full-name match, loose match → review, never a link or a create", () => {
    const p = patient({ middle_name: null });
    const out = plan(rowsOf({ name: "Dela Cruz, Juan Santos", dob: 32874 }), [p]);
    expect(out.ops.filter((o) => o.op !== "facts")).toHaveLength(0);
    expect(out.review[0].kind).toBe("ambiguous_patient");
  });
  it("surname corrected (no name match) but same phone → possible_existing_patient, not a create", () => {
    const p = patient({ last_name: "Dela Cruzz", phone_normalized: "9171112222" });
    const out = plan(rowsOf({ name: "Dela Cruz, Juan Santos", phone: "09171112222" }), [p]);
    expect(out.ops.some((o) => o.op === "create")).toBe(false);
    expect(out.review[0].kind).toBe("possible_existing_patient");
  });
  it("row linked last run vanished and a new row shares its DOB → possible_existing_patient", () => {
    const p = patient({ last_name: "Somebody Else", first_name: "Other" });
    const out = plan(rowsOf({ name: "Dela Cruz, Juan Santos", dob: 32874 }), [p], {
      prevRows: [{ source_key: "gone", patient_id: p.id, phone_norm: null, dob: "1990-01-01", link_state: "linked" }] });
    expect(out.review[0].kind).toBe("possible_existing_patient");
  });
  it("creates a patient only with zero full, zero loose and no corroboration", () => {
    const out = plan(rowsOf({ name: "Reyes, Ana Cruz", dob: 32874, src: "FACEBOOK", nr: "NEW" }), []);
    const create = out.ops.find((o) => o.op === "create");
    expect(create).toMatchObject({ op: "create", link_keys: ["reyes|ana cruz#1990-01-01"],
      fields: { first_name: "Ana", last_name: "Reyes", middle_name: "Cruz", birthdate: "1990-01-01", referral_source: "online_facebook" },
      facts: { new_repeat: "new" } });
  });
  it("two sheet rows for the same new person create ONE patient", () => {
    const out = plan(rowsOf({ name: "Reyes, Ana Cruz", dob: 32874, ts: 46000 }, { name: "Reyes, Ana Cruz", ts: 46100 }), []);
    const creates = out.ops.filter((o) => o.op === "create");
    expect(creates).toHaveLength(1);
    expect((creates[0] as { link_keys: string[] }).link_keys.sort()).toEqual(["reyes|ana cruz#", "reyes|ana cruz#1990-01-01"]);
  });
  it("a merged patient's link resolves to its survivor", () => {
    const keep = patient({}); const gone = patient({ merged_into_id: keep.id });
    const links = new Map([["dela cruz|juan santos#1990-01-01", { link_key: "dela cruz|juan santos#1990-01-01", patient_id: gone.id, decision: "link" as const, method: "admin" as const }]]);
    const out = plan(rowsOf({ name: "Dela Cruz, Juan Santos", dob: 32874 }), [keep, gone], { links });
    expect(out.mirror[0].patient_id).toBe(keep.id);
  });
  it("an admin 'create new' decision creates even when a candidate exists", () => {
    const p = patient({});
    const links = new Map([["dela cruz|juan santos#1990-01-01", { link_key: "dela cruz|juan santos#1990-01-01", patient_id: null, decision: "create" as const, method: "admin" as const }]]);
    const out = plan(rowsOf({ name: "Dela Cruz, Juan Santos", dob: 32874 }), [p], { links });
    expect(out.ops.find((o) => o.op === "create")).toMatchObject({ method: "admin" });
  });
  it("fills only blank fields and never touches a staff-owned channel", () => {
    const p = patient({ phone: null, email: "x@example.com", referral_source: "walk_in", referral_source_origin: "staff" });
    const out = plan(rowsOf({ name: "Dela Cruz, Juan Santos", dob: 32874, phone: "09171112222", src: "FACEBOOK" }), [p]);
    const fill = out.ops.find((o) => o.op === "fill");
    expect(fill).toEqual({ op: "fill", patient_id: p.id, fields: { phone: "+639171112222" } });
  });
  it("a sheet-owned channel follows the sheet, including back to blank", () => {
    const p = patient({ referral_source: "online_facebook", referral_source_origin: "sheet" });
    const out = plan(rowsOf({ name: "Dela Cruz, Juan Santos", dob: 32874, src: "" }), [p]);
    expect(out.ops.find((o) => o.op === "fill")).toEqual({ op: "fill", patient_id: p.id, fields: { referral_source: null } });
  });
  it("the earliest dated row supplies a patient's channel and facts", () => {
    const p = patient({});
    const out = plan(rowsOf(
      { name: "Dela Cruz, Juan Santos", dob: 32874, ts: 46100, src: "GOOGLE", nr: "REPEAT" },
      { name: "Dela Cruz, Juan Santos", dob: 32874, ts: 46000, src: "FACEBOOK", nr: "NEW" }), [p]);
    expect(out.ops.find((o) => o.op === "fill")).toMatchObject({ fields: { referral_source: "online_facebook" } });
    expect(out.ops.find((o) => o.op === "facts")).toMatchObject({ registered_on: "2025-12-09", new_repeat: "new" });
  });
  it("sends no op when nothing changed (nightly runs stay small)", () => {
    const p = patient({ referral_source: "online_facebook", referral_source_origin: "sheet", phone: "+639171112222", phone_normalized: "9171112222" });
    const links = new Map([["dela cruz|juan santos#1990-01-01", { link_key: "dela cruz|juan santos#1990-01-01", patient_id: p.id, decision: "link" as const, method: "auto_exact" as const }]]);
    const facts = new Map([[p.id, { patient_id: p.id, registered_on: "2025-12-09", sheet_new_repeat: null, source_ref: "CUSTOMER LIST2 r2" }]]);
    const out = plan(rowsOf({ name: "Dela Cruz, Juan Santos", dob: 32874, phone: "09171112222", src: "FACEBOOK" }), [p], { links, facts });
    expect(out.ops).toEqual([]);
  });
  it("raises one unmapped_source item per answer, with its count", () => {
    const out = plan(rowsOf({ name: "Reyes, Ana", src: "CUSTOMER LIST" }, { name: "Cruz, Ben", src: "customer list" }), []);
    expect(out.review.filter((r) => r.kind === "unmapped_source")).toEqual([
      { kind: "unmapped_source", item_key: "CUSTOMER LIST", payload: { answer: "CUSTOMER LIST", rows: 2 } }]);
  });
});
```

- [ ] **Step 4: Run** → FAIL.

- [ ] **Step 5: Implement `customer-plan.ts`.** The algorithm follows. Implement it exactly; each branch maps to a test above.

```ts
import type { PatientIndex } from "./patient-index";
import type {
  CustomerMirrorRow, CustomerOp, CustomerPlan, CustomerRow, FactsRecord, FillFields, LinkRecord,
  LinkState, PatientRecord, PrevCustomerRow, ReviewItemInput,
} from "./types";

interface Input {
  rows: readonly CustomerRow[];
  index: PatientIndex;
  links: ReadonlyMap<string, LinkRecord>;
  facts: ReadonlyMap<string, FactsRecord>;
  prevRows: readonly PrevCustomerRow[];
  importedAtIso?: string;       // legacy_intake.imported_at; runner passes the run start
}

type Resolution =
  | { kind: "linked"; patientId: string; newLink: null | "auto_exact" }
  | { kind: "create"; method: "auto_exact" | "admin" }
  | { kind: "review"; state: LinkState; item: ReviewItemInput };

const FILL_COLUMNS = [
  "phone", "email", "birthdate", "sex", "address", "referred_by_doctor",
  "preferred_release_medium", "senior_pwd_id_kind", "senior_pwd_id_number",
] as const;

/** Oldest registration first; undated rows last; then sheet order. */
function byEarliest(a: CustomerRow, b: CustomerRow): number {
  if (a.registeredOn !== b.registeredOn) {
    if (a.registeredOn === null) return 1;
    if (b.registeredOn === null) return -1;
    return a.registeredOn < b.registeredOn ? -1 : 1;
  }
  return a.sheetRow - b.sheetRow;
}

function candidatePayload(index: PatientIndex, ids: readonly string[]) {
  return ids.map((id) => {
    const p = index.byId.get(id)!;
    return { patient_id: p.id, drm_id: p.drm_id, name: [p.last_name, [p.first_name, p.middle_name].filter(Boolean).join(" ")].join(", "), birthdate: p.birthdate };
  });
}

function rowPayload(r: CustomerRow) {
  return { sheet_row: r.sheetRow, name_raw: r.fullNameRaw, dob: r.dob, registered_on: r.registeredOn,
    phone_last4: r.phone10 ? r.phone10.slice(-4) : null, link_key: r.linkKey };
}

function fieldsOf(r: CustomerRow): Required<FillFields> {
  return {
    phone: r.phoneE164, email: r.email, birthdate: r.dob, sex: r.sex, address: r.address,
    referred_by_doctor: r.referredByDoctor, preferred_release_medium: r.releaseMedium,
    senior_pwd_id_kind: r.seniorKind, senior_pwd_id_number: r.seniorNumber, referral_source: r.referralSourceId,
  };
}

/** First non-null value per field across a patient's rows, earliest row first. */
function aggregate(rows: CustomerRow[]): Required<FillFields> {
  const sorted = [...rows].sort(byEarliest);
  const out = fieldsOf(sorted[0]);
  for (const r of sorted.slice(1)) {
    const f = fieldsOf(r);
    for (const k of Object.keys(out) as Array<keyof typeof out>) if (out[k] === null) out[k] = f[k];
  }
  // Channel = the earliest row that ANSWERED (a blank answer is not an answer).
  out.referral_source = sorted.find((r) => r.sourceNorm !== "")?.referralSourceId ?? null;
  return out;
}

/** What the conditional fill would change — mirrors sheet_sync_apply_customer_ops (0170). */
function fillDiff(p: PatientRecord, want: Required<FillFields>): FillFields {
  const diff: FillFields = {};
  for (const c of FILL_COLUMNS) {
    if (c === "senior_pwd_id_kind" || c === "senior_pwd_id_number") continue;
    if (p[c] === null && want[c] !== null) diff[c] = want[c];
  }
  if (p.senior_pwd_id_kind === null && p.senior_pwd_id_number === null && want.senior_pwd_id_kind && want.senior_pwd_id_number) {
    diff.senior_pwd_id_kind = want.senior_pwd_id_kind;
    diff.senior_pwd_id_number = want.senior_pwd_id_number;
  }
  const sheetMayOwn = p.referral_source === null || p.referral_source_origin === "sheet";
  if (sheetMayOwn && p.referral_source !== want.referral_source) diff.referral_source = want.referral_source;
  return diff;
}

export function planCustomers(input: Input): CustomerPlan {
  const { index, links } = input;
  const review: ReviewItemInput[] = [];
  const ops: CustomerOp[] = [];
  const resolutions = new Map<string, Resolution>(); // by sourceKey

  // Corroboration sources: rows linked last run that vanished from this snapshot.
  const currentKeys = new Set(input.rows.map((r) => r.sourceKey));
  const vanished = input.prevRows.filter((p) => p.patient_id && !currentKeys.has(p.source_key));

  const live = (ids: readonly string[] | undefined) => (ids ?? []).filter((id) => index.isLive(id));

  for (const r of input.rows) {
    const link = links.get(r.linkKey);
    if (link?.decision === "create") { resolutions.set(r.sourceKey, { kind: "create", method: "admin" }); continue; }
    if (link?.decision === "link" && link.patient_id) {
      const s = index.survivor(link.patient_id);
      if (s) { resolutions.set(r.sourceKey, { kind: "linked", patientId: s, newLink: null }); continue; }
    }
    const full = live(index.byFullName.get(r.nameNorm));
    if (full.length === 1) {
      const p = index.byId.get(full[0])!;
      const dobConflict = !!(r.dob && p.birthdate && r.dob !== p.birthdate);
      const pPhone = p.phone_normalized;
      const phoneDiffers = !!(r.phone10 && pPhone && r.phone10 !== pPhone);
      const dobMatches = !!(r.dob && p.birthdate && r.dob === p.birthdate);
      if (dobConflict || (phoneDiffers && !dobMatches)) {
        resolutions.set(r.sourceKey, { kind: "review", state: "conflict", item: { kind: "identity_conflict", item_key: r.linkKey,
          payload: { link_keys: [r.linkKey], rows: [rowPayload(r)], candidates: candidatePayload(index, full),
            reason: dobConflict ? "date of birth differs" : "phone differs and date of birth cannot confirm" } } });
      } else {
        resolutions.set(r.sourceKey, { kind: "linked", patientId: p.id, newLink: "auto_exact" });
      }
      continue;
    }
    if (full.length > 1) {
      resolutions.set(r.sourceKey, { kind: "review", state: "ambiguous", item: { kind: "ambiguous_patient", item_key: r.linkKey,
        payload: { link_keys: [r.linkKey], rows: [rowPayload(r)], candidates: candidatePayload(index, full), reason: "several patients share this full name" } } });
      continue;
    }
    const loose = live(index.byLoose.get(r.looseKey));
    if (loose.length > 0) {
      resolutions.set(r.sourceKey, { kind: "review", state: "ambiguous", item: { kind: "ambiguous_patient", item_key: r.linkKey,
        payload: { link_keys: [r.linkKey], rows: [rowPayload(r)], candidates: candidatePayload(index, loose), reason: "similar name (surname + first name) — not linked automatically" } } });
      continue;
    }
    const surname = r.nameNorm.split("|")[0];
    const firstTok = r.looseKey.split("|")[1];
    const hits = new Set<string>(live(r.phone10 ? index.byPhone.get(r.phone10) : []));
    for (const id of live(r.dob ? index.byDob.get(r.dob) : [])) {
      const p = index.byId.get(id)!;
      const toks = index.tokens.get(id) ?? [];
      if (toks.includes(firstTok) || (p.last_name && surname.split(" ").every((t) => toks.includes(t)))) hits.add(id);
    }
    for (const v of vanished) {
      if ((r.phone10 && v.phone_norm === r.phone10) || (r.dob && v.dob === r.dob)) {
        const s = index.survivor(v.patient_id!);
        if (s) hits.add(s);
      }
    }
    if (hits.size > 0) {
      resolutions.set(r.sourceKey, { kind: "review", state: "possible_existing", item: { kind: "possible_existing_patient", item_key: r.linkKey,
        payload: { link_keys: [r.linkKey], rows: [rowPayload(r)], candidates: candidatePayload(index, [...hits]), reason: "same phone or date of birth as an existing patient" } } });
      continue;
    }
    resolutions.set(r.sourceKey, { kind: "create", method: "auto_exact" });
  }

  // Merge review items that share a link key (one item per identity, rows listed).
  const reviewByKey = new Map<string, ReviewItemInput>();
  for (const res of resolutions.values()) {
    if (res.kind !== "review") continue;
    const prev = reviewByKey.get(res.item.item_key);
    if (prev) (prev.payload.rows as unknown[]).push(...(res.item.payload.rows as unknown[]));
    else reviewByKey.set(res.item.item_key, structuredClone(res.item));
  }

  // Creates: group by nameNorm; one patient per distinct DOB; undated rows join the
  // single dated group, or go to review when the name has several DOBs.
  const createRows = input.rows.filter((r) => resolutions.get(r.sourceKey)?.kind === "create");
  const createGroups = new Map<string, CustomerRow[]>(); // createKey → rows
  const byName = new Map<string, CustomerRow[]>();
  for (const r of createRows) byName.set(r.nameNorm, [...(byName.get(r.nameNorm) ?? []), r]);
  for (const [nameNorm, rows] of byName) {
    const dobs = [...new Set(rows.map((r) => r.dob).filter((d): d is string => !!d))];
    if (dobs.length <= 1) { createGroups.set(`${nameNorm}#${dobs[0] ?? ""}`, rows); continue; }
    for (const d of dobs) createGroups.set(`${nameNorm}#${d}`, rows.filter((r) => r.dob === d));
    const undated = rows.filter((r) => !r.dob);
    if (undated.length) {
      const key = `${nameNorm}#`;
      for (const r of undated) resolutions.set(r.sourceKey, { kind: "review", state: "ambiguous", item: { kind: "ambiguous_patient", item_key: key, payload: {} } });
      reviewByKey.set(key, { kind: "ambiguous_patient", item_key: key, payload: { link_keys: [key], rows: undated.map(rowPayload), candidates: [],
        reason: "several new patients share this name with different dates of birth; this row has none" } });
    }
  }
  const createKeyBySource = new Map<string, string>();
  for (const [createKey, rows] of createGroups) {
    const agg = aggregate(rows);
    const first = [...rows].sort(byEarliest)[0];
    const methods = rows.map((r) => (resolutions.get(r.sourceKey) as { method: "auto_exact" | "admin" }).method);
    ops.push({
      op: "create", create_key: createKey, method: methods.includes("admin") ? "admin" : "auto_exact",
      link_keys: [...new Set(rows.map((r) => r.linkKey))],
      fields: { first_name: first.first!, last_name: first.last!, middle_name: first.middle, ...agg },
      legacy_intake: { source: "sheet_sync:CUSTOMER LIST2", imported_at: input.importedAtIso ?? null,
        original_row_index: first.sheetRow, raw: first.raw, import_warnings: [] },
      facts: { registered_on: first.registeredOn, new_repeat: rows.slice().sort(byEarliest).find((r) => r.newRepeat)?.newRepeat ?? null,
        source_ref: `CUSTOMER LIST2 r${first.sheetRow}` },
    });
    for (const r of rows) createKeyBySource.set(r.sourceKey, createKey);
  }

  // Linked: new link ops, then per-patient fill + facts diffs.
  const rowsByPatient = new Map<string, CustomerRow[]>();
  for (const r of input.rows) {
    const res = resolutions.get(r.sourceKey);
    if (res?.kind !== "linked") continue;
    rowsByPatient.set(res.patientId, [...(rowsByPatient.get(res.patientId) ?? []), r]);
    const existing = links.get(r.linkKey);
    if (res.newLink && (!existing || existing.patient_id !== res.patientId)) {
      ops.push({ op: "link", link_key: r.linkKey, patient_id: res.patientId, method: res.newLink });
    }
  }
  let fills = 0;
  let factsOps = 0;
  for (const [pid, rows] of rowsByPatient) {
    const p = index.byId.get(pid)!;
    const diff = fillDiff(p, aggregate(rows));
    if (Object.keys(diff).length) { ops.push({ op: "fill", patient_id: pid, fields: diff }); fills++; }
    const sorted = [...rows].sort(byEarliest);
    const want = { registered_on: sorted[0].registeredOn, new_repeat: sorted.find((r) => r.newRepeat)?.newRepeat ?? null,
      source_ref: `CUSTOMER LIST2 r${sorted[0].sheetRow}` };
    const have = input.facts.get(pid);
    if (!have || have.registered_on !== want.registered_on || have.sheet_new_repeat !== want.new_repeat || have.source_ref !== want.source_ref) {
      ops.push({ op: "facts", patient_id: pid, ...want }); factsOps++;
    }
  }
  // Dedupe link ops (several rows can share a link key).
  const seenLink = new Set<string>();
  const dedupedOps = ops.filter((o) => (o.op !== "link" ? true : !seenLink.has(o.link_key) && !!seenLink.add(o.link_key)));

  // Unmapped answers: one item per normalised answer.
  const unmapped = new Map<string, { answer: string; rows: number }>();
  for (const r of input.rows) {
    if (!r.unmappedSource) continue;
    const u = unmapped.get(r.sourceNorm);
    if (u) u.rows += r.dupCount; else unmapped.set(r.sourceNorm, { answer: r.sourceNorm, rows: r.dupCount });
  }
  for (const [norm, u] of unmapped) reviewByKey.set(`unmapped:${norm}`, { kind: "unmapped_source", item_key: norm, payload: u });

  const mirror: CustomerMirrorRow[] = input.rows.map((r) => {
    const res = resolutions.get(r.sourceKey)!;
    const createKey = createKeyBySource.get(r.sourceKey) ?? null;
    return {
      sheet_row: r.sheetRow, source_key: r.sourceKey, dup_count: r.dupCount, full_name_raw: r.fullNameRaw,
      name_norm: r.nameNorm, loose_key: r.looseKey, link_key: r.linkKey, phone_norm: r.phone10, dob: r.dob,
      registered_on: r.registeredOn, source_raw: r.sourceRaw, source_norm: r.sourceNorm,
      referral_source_id: r.referralSourceId, referred_by_raw: r.referredByRaw, new_repeat: r.newRepeat,
      release_medium_raw: r.releaseMediumRaw,
      patient_id: res.kind === "linked" ? res.patientId : null,
      pending_create_key: createKey,
      link_state: res.kind === "linked" || createKey ? "linked" : res.kind === "review" ? res.state : "unlinked",
      row_hash: r.rowHash,
    };
  });

  const reviewList = [...reviewByKey.values()];
  const reviewCounts: Record<string, number> = {};
  for (const i of reviewList) reviewCounts[i.kind] = (reviewCounts[i.kind] ?? 0) + 1;
  const linkedExisting = [...resolutions.values()].filter((x) => x.kind === "linked").length;
  return {
    ops: dedupedOps, mirror, review: reviewList,
    counts: { rows: input.rows.length, linked_existing: linkedExisting,
      link_new: dedupedOps.filter((o) => o.op === "link").length, create: createGroups.size,
      fill: fills, facts: factsOps, review: reviewCounts },
  };
}
```

Two corrections the implementer must make while getting tests green:
1. The `unmapped_source` test expects `item_key` = the normalised answer (`"CUSTOMER LIST"`). The code stores it in `reviewByKey` under `unmapped:<norm>` to avoid clashing with link keys; the emitted `item_key` must be the bare norm, as written.
2. The "sends no op when nothing changed" test needs the existing link to suppress the `link` op and matching facts to suppress `facts`. If it fails, compare the `source_ref` string format first.

- [ ] **Step 6: Run** `npx vitest run src/lib/sheet-sync/customer-plan.test.ts` → PASS.

- [ ] **Step 7: Commit** — `git commit -m "feat(sheet-sync): Customers identity plan (full-name link, loose suggestions, corroboration guard)"`

---

### Task 6: Mirror identity keys (§5.2) and the snapshot check

**Files:**
- Create: `src/lib/sheet-sync/encounter-identity.ts`, `src/lib/sheet-sync/snapshot.ts`, tests beside each

- [ ] **Step 1: Failing tests** `encounter-identity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { assignIdentities } from "./encounter-identity";
import { buildPatientIndex } from "./patient-index";
import type { EncounterLine, PatientRecord } from "./types";

const p = (id: string, over: Partial<PatientRecord> = {}): PatientRecord => ({ id, drm_id: id, first_name: "Juan", middle_name: "Santos",
  last_name: "Dela Cruz", birthdate: null, phone: null, phone_normalized: null, email: null, sex: null, address: null,
  referred_by_doctor: null, preferred_release_medium: null, senior_pwd_id_kind: null, senior_pwd_id_number: null,
  referral_source: null, referral_source_origin: null, merged_into_id: null, ...over });
const line = (first: string, middle: string | null, last = "Dela Cruz"): EncounterLine => ({
  tab: "consult", sheetRow: 3, serviceDate: "2026-06-01", nameRaw: `${last}, ${first}`, first, middle, last,
  nameNorm: `${last.toLowerCase()}|${[first, middle].filter(Boolean).join(" ").toLowerCase()}`,
  looseKey: `${last.toLowerCase()}|${first.toLowerCase()}`,
  tokens: [...last.toLowerCase().split(" "), first.toLowerCase(), ...(middle ? [middle.toLowerCase()] : [])],
  serviceRaw: null, doctorRaw: null, hmoRaw: null, basePhp: 1, finalPhp: 1, clinicFeePhp: 1, revenuePhp: 1,
  paymentMethodRaw: null, paymentDetailRaw: null, releaseMediumRaw: null, releasedOn: null, controlNo: null,
  testNo: null, raw: [], rowHash: "h" });

describe("assignIdentities", () => {
  it("exact full name → patient", () => {
    const [a] = assignIdentities([line("Juan", "Santos")], buildPatientIndex([p("A")]), new Map());
    expect(a).toMatchObject({ patientId: "A", identityKey: "patient:A" });
  });
  it("loose fallback: consult typed without the middle name → the one superset patient", () => {
    const [a] = assignIdentities([line("Juan", null)], buildPatientIndex([p("A")]), new Map());
    expect(a.identityKey).toBe("patient:A");
  });
  it("loose fallback refuses when two patients share the loose key", () => {
    const [a] = assignIdentities([line("Juan", null)], buildPatientIndex([p("A"), p("B", { middle_name: "Reyes" })]), new Map());
    expect(a).toMatchObject({ patientId: null, identityKey: "name:dela cruz|juan" });
  });
  it("a link decision for the name wins when all its links agree", () => {
    const links = new Map([["dela cruz|juan#1990-01-01", { link_key: "dela cruz|juan#1990-01-01", patient_id: "B", decision: "link" as const, method: "admin" as const }]]);
    const [a] = assignIdentities([line("Juan", null)], buildPatientIndex([p("A"), p("B", { middle_name: null })]), links);
    expect(a.patientId).toBe("B");
  });
  it("unlinked lab and consult spellings of one person share one name identity", () => {
    const [a, b] = assignIdentities([line("Ana", "Cruz", "Reyes"), line("Ana", null, "Reyes")], buildPatientIndex([]), new Map());
    expect(a.identityKey).toBe(b.identityKey);
  });
});
```

`snapshot.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { checkSnapshot } from "./snapshot";

describe("checkSnapshot", () => {
  it("passes without history and on growth", () => {
    expect(checkSnapshot(100, undefined).suspect).toBe(false);
    expect(checkSnapshot(120, 100).suspect).toBe(false);
  });
  it("allows a shrink of exactly 5% and flags anything more", () => {
    expect(checkSnapshot(95, 100).suspect).toBe(false);
    expect(checkSnapshot(94, 100)).toEqual({ suspect: true, previous: 100, current: 94, shrinkPct: 6 });
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** `encounter-identity.ts`:

```ts
import { isTokenSuperset } from "./names";
import type { PatientIndex } from "./patient-index";
import type { EncounterLine, LinkRecord } from "./types";

export interface IdentifiedLine extends EncounterLine {
  patientId: string | null;
  identityKey: string;
}

/**
 * Spec §5.2, in order: (1) a sheet_patient_links decision for this nameNorm
 * (lab/consult rows carry no DOB, so every decision whose key starts with the
 * name counts, and it applies only when they all resolve to ONE patient);
 * (2) exact full name → exactly one live patient; (3) loose key with exactly one
 * live patient whose tokens are a superset of the line's; (4) name:<looseKey>.
 * The mirror never creates patients.
 */
export function assignIdentities(
  lines: readonly EncounterLine[],
  index: PatientIndex,
  links: ReadonlyMap<string, LinkRecord>,
): IdentifiedLine[] {
  const linkTargetsByName = new Map<string, Set<string>>();
  for (const l of links.values()) {
    if (l.decision !== "link" || !l.patient_id) continue;
    const name = l.link_key.slice(0, l.link_key.lastIndexOf("#"));
    const s = index.survivor(l.patient_id);
    if (!s) continue;
    const set = linkTargetsByName.get(name) ?? new Set<string>();
    set.add(s);
    linkTargetsByName.set(name, set);
  }
  return lines.map((line) => {
    const viaLink = linkTargetsByName.get(line.nameNorm);
    if (viaLink && viaLink.size === 1) {
      const id = [...viaLink][0];
      return { ...line, patientId: id, identityKey: `patient:${id}` };
    }
    const full = (index.byFullName.get(line.nameNorm) ?? []).filter((id) => index.isLive(id));
    if (full.length === 1) return { ...line, patientId: full[0], identityKey: `patient:${full[0]}` };
    if (full.length === 0) {
      const loose = (index.byLoose.get(line.looseKey) ?? [])
        .filter((id) => index.isLive(id) && isTokenSuperset(index.tokens.get(id) ?? [], line.tokens));
      if (loose.length === 1) return { ...line, patientId: loose[0], identityKey: `patient:${loose[0]}` };
    }
    return { ...line, patientId: null, identityKey: `name:${line.looseKey}` };
  });
}
```

`snapshot.ts`:

```ts
/** Spec §3: a tab that shrank by more than 5% since the last good run is not trusted (sort/filter/truncation mid-edit). */
export function checkSnapshot(current: number, previous: number | undefined) {
  if (previous === undefined || previous <= 0 || current >= previous * 0.95) return { suspect: false as const };
  return { suspect: true as const, previous, current, shrinkPct: Math.round(((previous - current) / previous) * 100) };
}
```

- [ ] **Step 4: Run** → PASS. **Commit** — `git commit -m "feat(sheet-sync): mirror identity keys and snapshot shrink check"`

---

### Task 7: Re-sort proposal groups (pure)

**Files:**
- Create: `src/lib/sheet-sync/resort.ts`, `src/lib/sheet-sync/resort.test.ts`

Spec §4.1 "Re-sort of existing patients", with D8. Input: May-imported live patients (`legacy_intake->>'source' = 'google_sheet_CUSTOMER_LIST2'`, `merged_into_id is null`) with their current `referral_source`, `referral_source_origin`, and the raw answer `legacy_intake->'raw'->>'How did you know about DR Med?'`.

- [ ] **Step 1: Failing test** `resort.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { computeResortGroups } from "./resort";

const pt = (id: string, answer: string, current: string | null, origin: "staff" | "sheet" | "patient" | null = current ? "staff" : null) =>
  ({ id, answer, referral_source: current, referral_source_origin: origin });

describe("computeResortGroups", () => {
  it("groups patients whose value still equals the old mapper's output", () => {
    const g = computeResortGroups([
      pt("a", "Family / Friends", "customer_referral"),
      pt("b", "FAMILY/FRIENDS", "customer_referral"),
      pt("c", "Family / Friends", "walk_in"),            // staff changed it → excluded
    ], new Map());
    expect(g.groups).toEqual([{ answerNorm: "FAMILY FRIENDS", sampleAnswer: "Family / Friends", from: "customer_referral",
      to: "family_friends", patientIds: ["a", "b"] }]);
    expect(g.keptByStaff).toBe(1);
  });
  it("blank answers now map to Not recorded (null)", () => {
    const g = computeResortGroups([pt("a", "", "other")], new Map());
    expect(g.groups[0]).toMatchObject({ from: "other", to: null });
  });
  it("never proposes a downgrade to 'other' (D8)", () => {
    const g = computeResortGroups([pt("a", "CUSTOMER LIST", "customer_referral")], new Map());
    expect(g.groups).toEqual([]);
  });
  it("skips values already right and patient-owned values", () => {
    const g = computeResortGroups([pt("a", "FACEBOOK", "online_facebook"), pt("b", "WALK IN", "walk_in", "patient")], new Map());
    expect(g.groups).toEqual([]);
  });
});
```

- [ ] **Step 2: Implement** `resort.ts`:

```ts
import { mapReferralSource } from "../legacy-import/vocabulary-mapper";
import { mapAnswer } from "./referral-mapper";

export interface ResortInput {
  id: string;
  answer: string;
  referral_source: string | null;
  referral_source_origin: "staff" | "patient" | "sheet" | null;
}
export interface ResortGroup {
  answerNorm: string;
  sampleAnswer: string;
  from: string | null;
  to: string | null;
  patientIds: string[];
}

/**
 * Proposal only (spec §4.1): patients whose CURRENT value still equals what the
 * 2026-05 mapper produced from their original answer, re-mapped with the new
 * rules. A value that differs from the old mapper's output was changed by staff
 * and is left alone (counted as keptByStaff). Groups are keyed by
 * (normalised answer, from, to) and sorted by size.
 */
export function computeResortGroups(patients: readonly ResortInput[], aliases: ReadonlyMap<string, string>) {
  const groups = new Map<string, ResortGroup>();
  let keptByStaff = 0;
  for (const p of patients) {
    if (p.referral_source_origin === "patient") continue;
    const old = mapReferralSource(p.answer).id;
    if (p.referral_source !== old) { keptByStaff++; continue; }
    const next = mapAnswer(p.answer, aliases);
    if (next.id === p.referral_source) continue;
    if (next.id === "other") continue; // D8: never downgrade to "other"
    const key = `${next.norm}\u0000${p.referral_source}\u0000${next.id}`;
    const g = groups.get(key) ?? { answerNorm: next.norm, sampleAnswer: p.answer.trim(), from: p.referral_source, to: next.id, patientIds: [] };
    g.patientIds.push(p.id);
    groups.set(key, g);
  }
  return {
    groups: [...groups.values()].sort((a, b) => b.patientIds.length - a.patientIds.length || a.answerNorm.localeCompare(b.answerNorm)),
    keptByStaff,
  };
}
```

- [ ] **Step 3: Run** → PASS. **Commit** — `git commit -m "feat(sheet-sync): re-sort proposal groups (never downgrade to other)"`

---

# Phase B — database

### Task 8: Migration 0170 — channels, ownership, control + mirror tables, RPCs

**Files:**
- Create: `supabase/migrations/0170_sheet_sync_foundation.sql`
- Modify: `supabase/seed.sql` (tail), `src/lib/accounting/pg-errors.ts`, `src/lib/patients/referral-sources.ts`, `src/lib/patients/referral-sources.test.ts`, `src/lib/sheet-sync/referral-mapper.ts` (type the id as `ReferralSourceId`), `src/types/database.ts` (regenerated)

- [ ] **Step 0: Re-check the number.** `git fetch -q origin` then run the CLAUDE.md loop over `git branch -r` **and** local branches. If anything claims 0170 or P0062–P0064, take the next free ones and rename them everywhere in this plan's code.

- [ ] **Step 1: Write the migration** exactly as below. It is one file, in the order shown.

```sql
-- =============================================================================
-- 0170_sheet_sync_foundation.sql
-- =============================================================================
-- Sheet Sync PR 1 — spec docs/superpowers/specs/2026-09-24-sheet-sync-and-
-- patient-sources-design.md §4–§5, plan docs/superpowers/plans/2026-09-24-
-- sheet-sync-pr1.md (decisions D1–D5).
--
--  1. referral_sources: channel_group + six channels (family_friends,
--     walk_in_signage, phone_text_viber, partner_corporate, flyers,
--     prefer_not_to_say).
--  2. patients.referral_source_origin ('staff'|'patient'|'sheet') and
--     patients.row_version. Every existing non-NULL source starts 'staff'
--     (unproven provenance ⇒ staff-owned). A BEFORE trigger owns both columns:
--     row_version increments on every UPDATE; the origin can only be set
--     through the transaction-local setting app.referral_origin, which only
--     the security-definer functions below set (PostgREST cannot call
--     set_config). Any other change to referral_source is a staff change.
--  3. resolve_patient_guarded (0158) re-created to stamp 'patient'.
--  4. Control tables (settings seeded PAUSED, runs with a lease, review
--     items, before-images, identity decisions, acquisition facts, aliases)
--     and reporting-only mirror tables + a staging table.
--  5. Lease-fenced RPCs, all SECURITY DEFINER, search_path '', service_role
--     only. P0062 = another sync holds the lease; P0063 = this worker's lease
--     was taken over; P0064 = review item no longer open.
-- Nothing here creates visits, payments or journal entries.
-- =============================================================================

-- 1. Channels ---------------------------------------------------------------
alter table public.referral_sources
  add column channel_group text not null default 'other'
    constraint referral_sources_channel_group_check
    check (channel_group in ('online','walk_in','referral','direct_contact','partner','returning','other'));

insert into public.referral_sources (id, label, sort_order) values
  ('family_friends',     'Family / friends',              25),
  ('walk_in_signage',    'Walk-in (saw poster/signage)',  85),
  ('phone_text_viber',   'Phone call / text / Viber',     95),
  ('partner_corporate',  'Partner / corporate',          105),
  ('flyers',             'Flyers',                       112),
  ('prefer_not_to_say',  'Prefer not to say',            115)
on conflict (id) do nothing;

update public.referral_sources set channel_group = case id
  when 'online_facebook' then 'online'   when 'online_google' then 'online'
  when 'online_website' then 'online'    when 'online_instagram' then 'online'
  when 'online_tiktok' then 'online'
  when 'walk_in' then 'walk_in'          when 'walk_in_signage' then 'walk_in'
  when 'doctor_referral' then 'referral' when 'customer_referral' then 'referral'
  when 'family_friends' then 'referral'
  when 'phone_text_viber' then 'direct_contact'
  when 'partner_corporate' then 'partner' when 'tenant_employee_northridge' then 'partner'
  when 'returning_patient' then 'returning'
  else 'other' end
where true;

-- 2. Ownership + row_version -------------------------------------------------
alter table public.patients
  add column referral_source_origin text,
  add column row_version bigint not null default 0;

-- Backfill without touching updated_at (it feeds "recently updated" surfaces).
alter table public.patients disable trigger trg_patients_updated_at;
update public.patients set referral_source_origin = 'staff' where referral_source is not null;
alter table public.patients enable trigger trg_patients_updated_at;

alter table public.patients
  add constraint patients_referral_source_origin_check
    check (referral_source_origin in ('staff','patient','sheet')),
  add constraint patients_referral_source_origin_pairs
    check ((referral_source is null) = (referral_source_origin is null));

create or replace function public.patients_referral_origin_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_writer text := nullif(current_setting('app.referral_origin', true), '');
begin
  if tg_op = 'UPDATE' then
    new.row_version := old.row_version + 1;
    if new.referral_source is distinct from old.referral_source then
      new.referral_source_origin := case when new.referral_source is null then null
                                         else coalesce(v_writer, 'staff') end;
    else
      new.referral_source_origin := old.referral_source_origin;
    end if;
  else
    new.row_version := 0;
    new.referral_source_origin := case when new.referral_source is null then null
                                       else coalesce(v_writer, 'staff') end;
  end if;
  return new;
end;
$$;

create trigger trg_patients_referral_origin
  before insert or update on public.patients
  for each row execute function public.patients_referral_origin_guard();

revoke all on function public.patients_referral_origin_guard() from public;
revoke execute on function public.patients_referral_origin_guard() from anon, authenticated;

-- 3. resolve_patient_guarded (0158) — same body, stamps origin 'patient' -----
create or replace function public.resolve_patient_guarded(
  p_email text, p_last_name text, p_birthdate date, p_fields jsonb
)
returns table (id uuid, drm_id text, reused boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v record;
begin
  perform pg_advisory_xact_lock(
    hashtext('patient_resolve:' || lower(p_email) || ':' || lower(p_last_name) || ':' || p_birthdate::text)
  );
  select p.id, p.drm_id into v
    from public.patients p
   where p.email = lower(p_email) and p.last_name = p_last_name and p.birthdate = p_birthdate
   limit 1;
  if found then
    return query select v.id, v.drm_id, true;
    return;
  end if;
  perform set_config('app.referral_origin', 'patient', true);
  return query
  insert into public.patients (
    first_name, last_name, middle_name, birthdate, sex, phone, email, address, pre_registered,
    referral_source
  ) values (
    p_fields->>'first_name', p_fields->>'last_name', nullif(p_fields->>'middle_name',''),
    (p_fields->>'birthdate')::date,
    nullif(p_fields->>'sex',''),
    nullif(p_fields->>'phone',''), lower(p_email), nullif(p_fields->>'address',''),
    true,
    (select rs.id from public.referral_sources rs where rs.id = nullif(p_fields->>'referral_source',''))
  ) returning patients.id, patients.drm_id, false;
  perform set_config('app.referral_origin', '', true);
end;
$$;

revoke all on function public.resolve_patient_guarded(text, text, date, jsonb) from public;
revoke execute on function public.resolve_patient_guarded(text, text, date, jsonb) from anon, authenticated;
grant execute on function public.resolve_patient_guarded(text, text, date, jsonb) to service_role;

-- 4. Tables ------------------------------------------------------------------
create table public.sheet_sync_settings (
  id                  boolean primary key default true,
  paused              boolean not null default true,
  paused_at           timestamptz,
  paused_by           uuid references auth.users(id),
  pause_reason        text,
  mirror_window_start date not null default date '2026-05-26',
  final_synced_at     timestamptz,
  converted_at        timestamptz,
  updated_at          timestamptz not null default now(),
  constraint sheet_sync_settings_singleton check (id = true),
  constraint sheet_sync_settings_reason_len check (pause_reason is null or char_length(pause_reason) <= 400)
);
insert into public.sheet_sync_settings (id, paused, paused_at) values (true, true, now())
on conflict (id) do nothing;

create table public.sheet_sync_runs (
  id                    uuid primary key default gen_random_uuid(),
  trigger               text not null check (trigger in ('cron','manual','cli','resort','alias','revert')),
  actor_id              uuid references auth.users(id),
  dry_run               boolean not null default false,
  status                text not null check (status in ('running','succeeded','partial','failed','skipped_paused')),
  lease_token           uuid unique,
  heartbeat_at          timestamptz,
  started_at            timestamptz not null default now(),
  ended_at              timestamptz,
  per_tab               jsonb not null default '{}'::jsonb,
  summary               jsonb not null default '{}'::jsonb,
  error                 text,
  legacy_import_run_id  uuid references public.legacy_import_runs(id),
  reverted_by_run_id    uuid references public.sheet_sync_runs(id)
);
create unique index sheet_sync_runs_one_running on public.sheet_sync_runs ((status)) where status = 'running';
create index sheet_sync_runs_started on public.sheet_sync_runs (started_at desc, id);

create table public.sheet_sync_review_items (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid references public.sheet_sync_runs(id) on delete set null,
  tab            text not null check (tab in ('customers','lab','consult')),
  item_key       text not null,
  kind           text not null check (kind in ('ambiguous_patient','identity_conflict','possible_existing_patient',
                                               'unmapped_source','unparseable_date','invalid_row','suspect_snapshot')),
  payload        jsonb not null default '{}'::jsonb,
  status         text not null default 'open' check (status in ('open','resolved','dismissed')),
  resolution     jsonb,
  resolved_by    uuid references auth.users(id),
  resolved_at    timestamptz,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now()
);
create unique index sheet_sync_review_items_open_key on public.sheet_sync_review_items (kind, item_key) where status = 'open';
create index sheet_sync_review_items_list on public.sheet_sync_review_items (status, kind, last_seen_at desc, id);

-- Before-images. No FK to patients: the history must outlive a reverted create.
create table public.sheet_sync_changes (
  id                 bigint generated always as identity primary key,
  run_id             uuid not null references public.sheet_sync_runs(id),
  patient_id         uuid not null,
  change_kind        text not null check (change_kind in ('update','create')),
  column_name        text,
  old_value          text,
  new_value          text,
  row_version_after  bigint not null,
  changed_at         timestamptz not null default now(),
  reverted_at        timestamptz,
  constraint sheet_sync_changes_update_has_column check ((change_kind = 'create') = (column_name is null))
);
create index sheet_sync_changes_run on public.sheet_sync_changes (run_id, patient_id);

create table public.sheet_patient_links (
  link_key    text primary key,
  patient_id  uuid references public.patients(id) on delete cascade,
  decision    text not null default 'link' check (decision in ('link','create')),
  method      text not null check (method in ('auto_exact','auto_loose','admin')),
  decided_by  uuid references auth.users(id),
  decided_at  timestamptz not null default now(),
  constraint sheet_patient_links_target check ((decision = 'link') = (patient_id is not null))
);
create index sheet_patient_links_patient on public.sheet_patient_links (patient_id);

create table public.patient_acquisition_facts (
  patient_id        uuid primary key references public.patients(id) on delete cascade,
  registered_on     date,
  sheet_new_repeat  text check (sheet_new_repeat in ('new','repeat')),
  source_ref        text,
  updated_at        timestamptz not null default now()
);

create table public.referral_source_aliases (
  raw_normalized      text primary key,
  referral_source_id  text not null references public.referral_sources(id),
  created_by          uuid references auth.users(id),
  created_at          timestamptz not null default now()
);

create table public.sheet_customer_rows (
  id                  bigint generated always as identity primary key,
  sheet_row           int not null,
  source_key          text not null unique,
  dup_count           int not null default 1,
  full_name_raw       text not null,
  name_norm           text not null,
  loose_key           text not null,
  link_key            text not null,
  phone_norm          text,
  dob                 date,
  registered_on       date,
  source_raw          text not null default '',
  source_norm         text not null default '',
  referral_source_id  text references public.referral_sources(id),
  referred_by_raw     text,
  new_repeat          text check (new_repeat in ('new','repeat')),
  release_medium_raw  text,
  patient_id          uuid references public.patients(id) on delete set null,
  link_state          text not null check (link_state in ('linked','ambiguous','conflict','possible_existing','unlinked')),
  row_hash            text not null,
  run_id              uuid not null references public.sheet_sync_runs(id)
);
create index sheet_customer_rows_patient on public.sheet_customer_rows (patient_id);
create index sheet_customer_rows_loose on public.sheet_customer_rows (loose_key);
create index sheet_customer_rows_source_norm on public.sheet_customer_rows (source_norm);

create table public.sheet_encounter_lines (
  id                  bigint generated always as identity primary key,
  tab                 text not null check (tab in ('lab','consult','procedure_hmo','home_service')),
  sheet_row           int not null,
  service_date        date not null,
  name_raw            text not null,
  name_norm           text not null,
  loose_key           text not null,
  patient_id          uuid references public.patients(id) on delete set null,
  identity_key        text not null,
  service_raw         text,
  doctor_raw          text,
  hmo_raw             text,
  base_php            numeric(12,2),
  final_php           numeric(12,2),
  clinic_fee_php      numeric(12,2),
  revenue_php         numeric(12,2),
  payment_method_raw  text,
  payment_detail_raw  text,
  release_medium_raw  text,
  released_on         date,
  control_no          text,
  test_no             text,
  raw                 jsonb not null,
  row_hash            text not null,
  run_id              uuid not null references public.sheet_sync_runs(id)
);
create index sheet_encounter_lines_date on public.sheet_encounter_lines (service_date, tab);
create index sheet_encounter_lines_identity on public.sheet_encounter_lines (identity_key, service_date);
create index sheet_encounter_lines_patient on public.sheet_encounter_lines (patient_id);

create table public.sheet_mirror_staging (
  seq     bigint generated always as identity primary key,
  run_id  uuid not null references public.sheet_sync_runs(id) on delete cascade,
  tab     text not null check (tab in ('customers','lab','consult')),
  row     jsonb not null,
  staged_at timestamptz not null default now()
);
create index sheet_mirror_staging_run on public.sheet_mirror_staging (run_id, tab, seq);

-- RLS: admin read on everything an admin page shows; no write policies
-- (all writes go through the service-role RPCs below). Staging: no policy.
do $$
declare t text;
begin
  foreach t in array array['sheet_sync_settings','sheet_sync_runs','sheet_sync_review_items','sheet_sync_changes',
    'sheet_patient_links','patient_acquisition_facts','referral_source_aliases','sheet_customer_rows',
    'sheet_encounter_lines','sheet_mirror_staging'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke all on public.%I from authenticated', t);
  end loop;
  foreach t in array array['sheet_sync_settings','sheet_sync_runs','sheet_sync_review_items','sheet_sync_changes',
    'sheet_patient_links','patient_acquisition_facts','referral_source_aliases','sheet_customer_rows',
    'sheet_encounter_lines'] loop
    execute format('grant select on public.%I to authenticated', t);
    execute format('create policy %I on public.%I for select to authenticated using ((select public.has_role(array[''admin''])))',
                   t || ': admin read', t);
  end loop;
end $$;
```

**`seed-grant-parity.test.ts` reads `revoke … on public.<name> from …` by regex.** Revokes built with `format()` inside a `do` block are invisible to it, which leaves the seed tail unchecked. So after the `do` block, **also write the twenty revokes and nine grants literally** (they are idempotent). Example for one table; repeat for all ten:

```sql
revoke all on public.sheet_sync_runs from anon;
revoke all on public.sheet_sync_runs from authenticated;
grant select on public.sheet_sync_runs to authenticated;
```

(`sheet_mirror_staging` gets the two revokes and no grant.) Then continue:

```sql
-- 5. RPCs --------------------------------------------------------------------
create or replace function public._sheet_sync_fence(p_lease_token uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  select r.id into v_id from public.sheet_sync_runs r
   where r.lease_token = p_lease_token and r.status = 'running'
   for update;
  if v_id is null then
    raise exception 'This sheet sync lost its turn to another run.' using errcode = 'P0063';
  end if;
  update public.sheet_sync_runs set heartbeat_at = now() where id = v_id;
  return v_id;
end $$;

-- Records one before-image row per changed column (allow-listed).
create or replace function public._sheet_sync_record_changes(p_run uuid, p_old jsonb, p_new jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_n integer;
begin
  insert into public.sheet_sync_changes (run_id, patient_id, change_kind, column_name, old_value, new_value, row_version_after)
  select p_run, (p_new->>'id')::uuid, 'update', c, p_old->>c, p_new->>c, (p_new->>'row_version')::bigint
    from unnest(array['phone','email','birthdate','sex','address','referred_by_doctor','preferred_release_medium',
                      'senior_pwd_id_kind','senior_pwd_id_number','referral_source','referral_source_origin']) c
   where (p_old->c) is distinct from (p_new->c);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

create or replace function public.sheet_sync_acquire(p_trigger text, p_actor uuid, p_dry_run boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_paused boolean;
  v_run public.sheet_sync_runs%rowtype;
  v_id uuid;
  v_token uuid := gen_random_uuid();
begin
  if p_trigger is null or p_trigger not in ('cron','manual','cli','resort','alias','revert') then
    raise exception 'Unknown sheet sync trigger.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('sheet_sync_lease'));
  select s.paused into v_paused from public.sheet_sync_settings s where s.id;
  if coalesce(v_paused, true) and p_trigger in ('cron','manual','cli') and not coalesce(p_dry_run, false) then
    insert into public.sheet_sync_runs (trigger, actor_id, dry_run, status, ended_at)
    values (p_trigger, p_actor, false, 'skipped_paused', now())
    returning id into v_id;
    return jsonb_build_object('status', 'skipped_paused', 'run_id', v_id);
  end if;
  select * into v_run from public.sheet_sync_runs r where r.status = 'running' for update;
  if found then
    if v_run.heartbeat_at > now() - interval '10 minutes' then
      raise exception 'Another sheet sync is running.' using errcode = 'P0062';
    end if;
    update public.sheet_sync_runs set status = 'failed', ended_at = now(), error = 'lease expired (no heartbeat for 10 minutes)'
     where id = v_run.id;
  end if;
  insert into public.sheet_sync_runs (trigger, actor_id, dry_run, status, lease_token, heartbeat_at)
  values (p_trigger, p_actor, coalesce(p_dry_run, false), 'running', v_token, now())
  returning id into v_id;
  return jsonb_build_object('status', 'running', 'run_id', v_id, 'lease_token', v_token);
end $$;

create or replace function public.sheet_sync_heartbeat(p_lease_token uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public._sheet_sync_fence(p_lease_token);
end $$;

create or replace function public.sheet_sync_finish(
  p_lease_token uuid, p_status text, p_per_tab jsonb, p_summary jsonb, p_error text
) returns void language plpgsql security definer set search_path = '' as $$
declare v_id uuid := public._sheet_sync_fence(p_lease_token);
begin
  if p_status not in ('succeeded','partial','failed') then
    raise exception 'Unknown sheet sync status.' using errcode = '22023';
  end if;
  update public.sheet_sync_runs
     set status = p_status, ended_at = now(), per_tab = coalesce(p_per_tab, '{}'::jsonb),
         summary = coalesce(p_summary, '{}'::jsonb), error = p_error
   where id = v_id;
  delete from public.sheet_mirror_staging where run_id = v_id;
end $$;

create or replace function public.sheet_mirror_stage(p_lease_token uuid, p_tab text, p_rows jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_id uuid := public._sheet_sync_fence(p_lease_token); v_n integer;
begin
  if p_tab not in ('customers','lab','consult') or jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'Bad staging chunk.' using errcode = '22023';
  end if;
  insert into public.sheet_mirror_staging (run_id, tab, row)
  select v_id, p_tab, e from jsonb_array_elements(p_rows) e;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

create or replace function public.sheet_mirror_commit(p_lease_token uuid, p_tab text)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_id uuid := public._sheet_sync_fence(p_lease_token); v_n integer;
begin
  if p_tab = 'customers' then
    delete from public.sheet_customer_rows where true;
    insert into public.sheet_customer_rows (sheet_row, source_key, dup_count, full_name_raw, name_norm, loose_key,
      link_key, phone_norm, dob, registered_on, source_raw, source_norm, referral_source_id, referred_by_raw,
      new_repeat, release_medium_raw, patient_id, link_state, row_hash, run_id)
    select r.sheet_row, r.source_key, r.dup_count, r.full_name_raw, r.name_norm, r.loose_key, r.link_key,
           r.phone_norm, r.dob, r.registered_on, r.source_raw, r.source_norm, r.referral_source_id, r.referred_by_raw,
           r.new_repeat, r.release_medium_raw, r.patient_id, r.link_state, r.row_hash, v_id
      from public.sheet_mirror_staging s
     cross join lateral jsonb_populate_record(null::public.sheet_customer_rows, s.row) r
     where s.run_id = v_id and s.tab = 'customers'
     order by s.seq;
  elsif p_tab in ('lab','consult') then
    delete from public.sheet_encounter_lines where tab = p_tab;
    insert into public.sheet_encounter_lines (tab, sheet_row, service_date, name_raw, name_norm, loose_key, patient_id,
      identity_key, service_raw, doctor_raw, hmo_raw, base_php, final_php, clinic_fee_php, revenue_php,
      payment_method_raw, payment_detail_raw, release_medium_raw, released_on, control_no, test_no, raw, row_hash, run_id)
    select p_tab, r.sheet_row, r.service_date, r.name_raw, r.name_norm, r.loose_key, r.patient_id, r.identity_key,
           r.service_raw, r.doctor_raw, r.hmo_raw, r.base_php, r.final_php, r.clinic_fee_php, r.revenue_php,
           r.payment_method_raw, r.payment_detail_raw, r.release_medium_raw, r.released_on, r.control_no, r.test_no,
           r.raw, r.row_hash, v_id
      from public.sheet_mirror_staging s
     cross join lateral jsonb_populate_record(null::public.sheet_encounter_lines, s.row) r
     where s.run_id = v_id and s.tab = p_tab
     order by s.seq;
  else
    raise exception 'Unknown mirror tab.' using errcode = '22023';
  end if;
  get diagnostics v_n = row_count;
  delete from public.sheet_mirror_staging where run_id = v_id and tab = p_tab;
  return v_n;
end $$;

create or replace function public.sheet_sync_apply_customer_ops(p_lease_token uuid, p_ops jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_run uuid := public._sheet_sync_fence(p_lease_token);
  v_actor uuid;
  v_import uuid;
  v_op jsonb;
  v_f jsonb;
  v_old public.patients%rowtype;
  v_new public.patients%rowtype;
  v_pid uuid;
  v_key text;
  v_src text;
  v_created jsonb := '{}'::jsonb;
  n_created int := 0; n_linked int := 0; n_filled int := 0; n_facts int := 0; n_skipped int := 0;
begin
  if jsonb_typeof(p_ops) is distinct from 'array' then
    raise exception 'Bad ops batch.' using errcode = '22023';
  end if;
  select r.actor_id, r.legacy_import_run_id into v_actor, v_import from public.sheet_sync_runs r where r.id = v_run;

  for v_op in select e from jsonb_array_elements(p_ops) e loop
    if v_op->>'op' = 'create' then
      if v_import is null then
        insert into public.legacy_import_runs (source, dry_run, run_by, notes)
        values ('sheet_sync:CUSTOMER LIST2', false, v_actor, 'sheet_sync_runs ' || v_run)
        returning id into v_import;
        update public.sheet_sync_runs set legacy_import_run_id = v_import where id = v_run;
      end if;
      v_f := v_op->'fields';
      v_src := (select rs.id from public.referral_sources rs where rs.id = nullif(v_f->>'referral_source', ''));
      perform set_config('app.referral_origin', 'sheet', true);
      insert into public.patients (first_name, last_name, middle_name, birthdate, sex, phone, email, address,
        referral_source, referred_by_doctor, preferred_release_medium, senior_pwd_id_kind, senior_pwd_id_number,
        legacy_intake, legacy_import_run_id, birthdate_confirmed)
      values (v_f->>'first_name', v_f->>'last_name', nullif(v_f->>'middle_name', ''),
        nullif(v_f->>'birthdate', '')::date, nullif(v_f->>'sex', ''), nullif(v_f->>'phone', ''),
        nullif(v_f->>'email', ''), nullif(v_f->>'address', ''), v_src, nullif(v_f->>'referred_by_doctor', ''),
        nullif(v_f->>'preferred_release_medium', ''), nullif(v_f->>'senior_pwd_id_kind', ''),
        nullif(v_f->>'senior_pwd_id_number', ''), v_op->'legacy_intake', v_import, false)
      returning id into v_pid;
      perform set_config('app.referral_origin', '', true);
      insert into public.sheet_sync_changes (run_id, patient_id, change_kind, row_version_after)
      values (v_run, v_pid, 'create', 0);
      for v_key in select jsonb_array_elements_text(v_op->'link_keys') loop
        insert into public.sheet_patient_links (link_key, patient_id, decision, method)
        values (v_key, v_pid, 'link', case when v_op->>'method' = 'admin' then 'admin' else 'auto_exact' end)
        on conflict (link_key) do update
          set patient_id = excluded.patient_id, decision = 'link', decided_at = now()
          where public.sheet_patient_links.method <> 'admin' or public.sheet_patient_links.decision = 'create';
      end loop;
      insert into public.patient_acquisition_facts (patient_id, registered_on, sheet_new_repeat, source_ref)
      values (v_pid, nullif(v_op->'facts'->>'registered_on', '')::date,
              nullif(v_op->'facts'->>'new_repeat', ''), v_op->'facts'->>'source_ref');
      v_created := v_created || jsonb_build_object(v_op->>'create_key', v_pid);
      n_created := n_created + 1;

    elsif v_op->>'op' = 'link' then
      insert into public.sheet_patient_links (link_key, patient_id, decision, method)
      values (v_op->>'link_key', (v_op->>'patient_id')::uuid, 'link', v_op->>'method')
      on conflict (link_key) do update
        set patient_id = excluded.patient_id, method = excluded.method, decision = 'link', decided_at = now()
        where public.sheet_patient_links.method <> 'admin';
      n_linked := n_linked + 1;

    elsif v_op->>'op' = 'fill' then
      v_f := v_op->'fields';
      select * into v_old from public.patients p
       where p.id = (v_op->>'patient_id')::uuid and p.merged_into_id is null
       for update;
      if not found then n_skipped := n_skipped + 1; continue; end if;
      v_src := case
        when not (v_f ? 'referral_source') then v_old.referral_source
        when v_old.referral_source is null or v_old.referral_source_origin = 'sheet'
          then (select rs.id from public.referral_sources rs where rs.id = nullif(v_f->>'referral_source', ''))
        else v_old.referral_source end;
      perform set_config('app.referral_origin', 'sheet', true);
      update public.patients p set
        phone = coalesce(p.phone, nullif(v_f->>'phone', '')),
        email = coalesce(p.email, nullif(v_f->>'email', '')),
        birthdate = coalesce(p.birthdate, nullif(v_f->>'birthdate', '')::date),
        sex = coalesce(p.sex, nullif(v_f->>'sex', '')),
        address = coalesce(p.address, nullif(v_f->>'address', '')),
        referred_by_doctor = coalesce(p.referred_by_doctor, nullif(v_f->>'referred_by_doctor', '')),
        preferred_release_medium = coalesce(p.preferred_release_medium, nullif(v_f->>'preferred_release_medium', '')),
        senior_pwd_id_kind = case when p.senior_pwd_id_kind is null and p.senior_pwd_id_number is null
                                  then nullif(v_f->>'senior_pwd_id_kind', '') else p.senior_pwd_id_kind end,
        senior_pwd_id_number = case when p.senior_pwd_id_kind is null and p.senior_pwd_id_number is null
                                    then nullif(v_f->>'senior_pwd_id_number', '') else p.senior_pwd_id_number end,
        referral_source = v_src
      where p.id = v_old.id
        and ( (p.phone is null and nullif(v_f->>'phone', '') is not null)
           or (p.email is null and nullif(v_f->>'email', '') is not null)
           or (p.birthdate is null and nullif(v_f->>'birthdate', '') is not null)
           or (p.sex is null and nullif(v_f->>'sex', '') is not null)
           or (p.address is null and nullif(v_f->>'address', '') is not null)
           or (p.referred_by_doctor is null and nullif(v_f->>'referred_by_doctor', '') is not null)
           or (p.preferred_release_medium is null and nullif(v_f->>'preferred_release_medium', '') is not null)
           or (p.senior_pwd_id_kind is null and p.senior_pwd_id_number is null
               and nullif(v_f->>'senior_pwd_id_kind', '') is not null)
           or (p.referral_source is distinct from v_src) )
      returning * into v_new;
      perform set_config('app.referral_origin', '', true);
      if found then
        perform public._sheet_sync_record_changes(v_run, to_jsonb(v_old), to_jsonb(v_new));
        n_filled := n_filled + 1;
      else
        n_skipped := n_skipped + 1;
      end if;

    elsif v_op->>'op' = 'facts' then
      insert into public.patient_acquisition_facts (patient_id, registered_on, sheet_new_repeat, source_ref)
      values ((v_op->>'patient_id')::uuid, nullif(v_op->>'registered_on', '')::date,
              nullif(v_op->>'new_repeat', ''), v_op->>'source_ref')
      on conflict (patient_id) do update
        set registered_on = excluded.registered_on, sheet_new_repeat = excluded.sheet_new_repeat,
            source_ref = excluded.source_ref, updated_at = now();
      n_facts := n_facts + 1;

    else
      raise exception 'Unknown customer op.' using errcode = '22023';
    end if;
  end loop;

  return jsonb_build_object('created', v_created, 'counts', jsonb_build_object(
    'created', n_created, 'linked', n_linked, 'filled', n_filled, 'facts', n_facts, 'skipped', n_skipped));
end $$;

create or replace function public.sheet_sync_upsert_review(
  p_lease_token uuid, p_tab text, p_items jsonb, p_clear_absent boolean
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_run uuid := public._sheet_sync_fence(p_lease_token);
  v_item jsonb;
  n_opened int := 0; n_updated int := 0; n_cleared int := 0;
begin
  if p_tab not in ('customers','lab','consult') or jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'Bad review batch.' using errcode = '22023';
  end if;
  for v_item in select e from jsonb_array_elements(p_items) e loop
    if exists (select 1 from public.sheet_sync_review_items i
                where i.kind = v_item->>'kind' and i.item_key = v_item->>'item_key' and i.status = 'dismissed') then
      continue;
    end if;
    update public.sheet_sync_review_items i
       set payload = v_item->'payload', run_id = v_run, last_seen_at = now()
     where i.kind = v_item->>'kind' and i.item_key = v_item->>'item_key' and i.status = 'open';
    if found then
      n_updated := n_updated + 1;
    else
      insert into public.sheet_sync_review_items (run_id, tab, item_key, kind, payload)
      values (v_run, p_tab, v_item->>'item_key', v_item->>'kind', coalesce(v_item->'payload', '{}'::jsonb));
      n_opened := n_opened + 1;
    end if;
  end loop;
  if p_clear_absent then
    update public.sheet_sync_review_items i
       set status = 'resolved', resolution = jsonb_build_object('auto', 'no longer reported by the sheet'), resolved_at = now()
     where i.tab = p_tab and i.status = 'open'
       and not exists (select 1 from jsonb_array_elements(p_items) e
                        where e->>'kind' = i.kind and e->>'item_key' = i.item_key);
    get diagnostics n_cleared = row_count;
  end if;
  return jsonb_build_object('opened', n_opened, 'updated', n_updated, 'cleared', n_cleared);
end $$;

create or replace function public.sheet_resort_apply(
  p_lease_token uuid, p_patient_ids uuid[], p_expected_old text, p_new text
) returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_run uuid := public._sheet_sync_fence(p_lease_token);
  v_old public.patients%rowtype;
  v_new public.patients%rowtype;
  v_id uuid;
  v_n int := 0;
begin
  if p_new is not null and not exists (select 1 from public.referral_sources rs where rs.id = p_new) then
    raise exception 'Unknown channel.' using errcode = '22023';
  end if;
  if p_new is not distinct from p_expected_old then return 0; end if;
  foreach v_id in array coalesce(p_patient_ids, '{}'::uuid[]) loop
    select * into v_old from public.patients p
     where p.id = v_id and p.merged_into_id is null
       and p.referral_source is not distinct from p_expected_old
       and p.referral_source_origin is distinct from 'patient'
     for update;
    if not found then continue; end if;
    perform set_config('app.referral_origin', 'sheet', true);
    update public.patients set referral_source = p_new where id = v_id returning * into v_new;
    perform set_config('app.referral_origin', '', true);
    perform public._sheet_sync_record_changes(v_run, to_jsonb(v_old), to_jsonb(v_new));
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

create or replace function public.sheet_alias_apply(
  p_lease_token uuid, p_raw_normalized text, p_source_id text, p_actor uuid
) returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_run uuid := public._sheet_sync_fence(p_lease_token);
  v_old public.patients%rowtype;
  v_new public.patients%rowtype;
  v_id uuid;
  v_n int := 0;
begin
  if coalesce(p_raw_normalized, '') = '' or not exists (select 1 from public.referral_sources rs where rs.id = p_source_id) then
    raise exception 'Unknown channel.' using errcode = '22023';
  end if;
  insert into public.referral_source_aliases (raw_normalized, referral_source_id, created_by)
  values (p_raw_normalized, p_source_id, p_actor)
  on conflict (raw_normalized) do update
    set referral_source_id = excluded.referral_source_id, created_by = excluded.created_by, created_at = now();
  update public.sheet_customer_rows set referral_source_id = p_source_id where source_norm = p_raw_normalized;
  for v_id in select distinct c.patient_id from public.sheet_customer_rows c
               where c.source_norm = p_raw_normalized and c.patient_id is not null loop
    select * into v_old from public.patients p
     where p.id = v_id and p.merged_into_id is null
       and (p.referral_source is null or p.referral_source_origin = 'sheet')
     for update;
    if not found or v_old.referral_source is not distinct from p_source_id then continue; end if;
    perform set_config('app.referral_origin', 'sheet', true);
    update public.patients set referral_source = p_source_id where id = v_id returning * into v_new;
    perform set_config('app.referral_origin', '', true);
    perform public._sheet_sync_record_changes(v_run, to_jsonb(v_old), to_jsonb(v_new));
    v_n := v_n + 1;
  end loop;
  update public.sheet_sync_review_items
     set status = 'resolved', resolved_by = p_actor, resolved_at = now(),
         resolution = jsonb_build_object('action', 'alias', 'referral_source_id', p_source_id)
   where kind = 'unmapped_source' and item_key = p_raw_normalized and status = 'open';
  return v_n;
end $$;

create or replace function public.sheet_sync_revert_run(p_lease_token uuid, p_target_run uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_run uuid := public._sheet_sync_fence(p_lease_token);
  v_pid uuid;
  v_ver bigint;
  v_map jsonb;
  v_cur public.patients%rowtype;
  v_new public.patients%rowtype;
  n_restored int := 0; n_blocked int := 0; n_deleted int := 0; n_kept int := 0;
begin
  if exists (select 1 from public.sheet_sync_runs r where r.id = p_target_run and r.reverted_by_run_id is not null) then
    raise exception 'This run has already been undone.' using errcode = '22023';
  end if;

  for v_pid, v_ver, v_map in
    select c.patient_id, max(c.row_version_after), jsonb_object_agg(c.column_name, c.old_value)
      from public.sheet_sync_changes c
     where c.run_id = p_target_run and c.change_kind = 'update' and c.reverted_at is null
     group by c.patient_id
  loop
    select * into v_cur from public.patients p where p.id = v_pid for update;
    if not found or v_cur.row_version <> v_ver then n_blocked := n_blocked + 1; continue; end if;
    perform set_config('app.referral_origin', coalesce(v_map->>'referral_source_origin', 'staff'), true);
    update public.patients p set
      phone = case when v_map ? 'phone' then v_map->>'phone' else p.phone end,
      email = case when v_map ? 'email' then v_map->>'email' else p.email end,
      birthdate = case when v_map ? 'birthdate' then (v_map->>'birthdate')::date else p.birthdate end,
      sex = case when v_map ? 'sex' then v_map->>'sex' else p.sex end,
      address = case when v_map ? 'address' then v_map->>'address' else p.address end,
      referred_by_doctor = case when v_map ? 'referred_by_doctor' then v_map->>'referred_by_doctor' else p.referred_by_doctor end,
      preferred_release_medium = case when v_map ? 'preferred_release_medium' then v_map->>'preferred_release_medium' else p.preferred_release_medium end,
      senior_pwd_id_kind = case when v_map ? 'senior_pwd_id_kind' then v_map->>'senior_pwd_id_kind' else p.senior_pwd_id_kind end,
      senior_pwd_id_number = case when v_map ? 'senior_pwd_id_number' then v_map->>'senior_pwd_id_number' else p.senior_pwd_id_number end,
      referral_source = case when v_map ? 'referral_source' then v_map->>'referral_source' else p.referral_source end
    where p.id = v_pid
    returning * into v_new;
    perform set_config('app.referral_origin', '', true);
    perform public._sheet_sync_record_changes(v_run, to_jsonb(v_cur), to_jsonb(v_new));
    update public.sheet_sync_changes set reverted_at = now()
     where run_id = p_target_run and patient_id = v_pid and change_kind = 'update';
    n_restored := n_restored + 1;
  end loop;

  for v_pid in select c.patient_id from public.sheet_sync_changes c
                where c.run_id = p_target_run and c.change_kind = 'create' and c.reverted_at is null loop
    select p.row_version into v_ver from public.patients p where p.id = v_pid for update;
    if not found then continue; end if;
    if v_ver <> 0 then n_kept := n_kept + 1; continue; end if;
    begin
      delete from public.sheet_patient_links where patient_id = v_pid;
      delete from public.patient_acquisition_facts where patient_id = v_pid;
      update public.sheet_customer_rows set patient_id = null, link_state = 'unlinked' where patient_id = v_pid;
      update public.sheet_encounter_lines set patient_id = null where patient_id = v_pid;
      delete from public.patients where id = v_pid;
      update public.sheet_sync_changes set reverted_at = now()
       where run_id = p_target_run and patient_id = v_pid and change_kind = 'create';
      n_deleted := n_deleted + 1;
    exception when foreign_key_violation then
      n_kept := n_kept + 1;
    end;
  end loop;

  update public.sheet_sync_runs set reverted_by_run_id = v_run where id = p_target_run;
  return jsonb_build_object('restored', n_restored, 'blocked', n_blocked, 'deleted', n_deleted, 'kept', n_kept);
end $$;

-- Re-sort candidates: May-imported live patients and their original answer
-- (the key holds spaces and a "?", which a PostgREST select path cannot address).
create or replace function public.sheet_resort_candidates()
returns table (id uuid, answer text, referral_source text, referral_source_origin text)
language sql stable security definer set search_path = '' as $$
  select p.id, coalesce(p.legacy_intake->'raw'->>'How did you know about DR Med?', ''),
         p.referral_source, p.referral_source_origin
    from public.patients p
   where p.merged_into_id is null
     and p.legacy_intake->>'source' = 'google_sheet_CUSTOMER_LIST2'
   order by p.id;
$$;

create or replace function public.sheet_review_resolve(
  p_item_id uuid, p_actor uuid, p_action text, p_patient_id uuid
) returns void language plpgsql security definer set search_path = '' as $$
declare v_item public.sheet_sync_review_items%rowtype;
begin
  select * into v_item from public.sheet_sync_review_items i where i.id = p_item_id and i.status = 'open' for update;
  if not found then
    raise exception 'This review item was already handled.' using errcode = 'P0064';
  end if;
  if p_action = 'dismiss' then
    update public.sheet_sync_review_items
       set status = 'dismissed', resolved_by = p_actor, resolved_at = now(), resolution = jsonb_build_object('action', 'dismiss')
     where id = p_item_id;
    return;
  end if;
  if p_action not in ('link','create')
     or v_item.kind not in ('ambiguous_patient','identity_conflict','possible_existing_patient') then
    raise exception 'That action does not fit this item.' using errcode = '22023';
  end if;
  if p_action = 'link' and not exists (select 1 from public.patients p where p.id = p_patient_id and p.merged_into_id is null) then
    raise exception 'Pick a current (not merged) patient.' using errcode = '22023';
  end if;
  insert into public.sheet_patient_links (link_key, patient_id, decision, method, decided_by)
  select k, case when p_action = 'link' then p_patient_id end, p_action, 'admin', p_actor
    from jsonb_array_elements_text(coalesce(v_item.payload->'link_keys', '[]'::jsonb)) k
  on conflict (link_key) do update
    set patient_id = excluded.patient_id, decision = excluded.decision, method = 'admin',
        decided_by = excluded.decided_by, decided_at = now();
  update public.sheet_sync_review_items
     set status = 'resolved', resolved_by = p_actor, resolved_at = now(),
         resolution = jsonb_build_object('action', p_action, 'patient_id', p_patient_id)
   where id = p_item_id;
end $$;

-- ACLs: born closed since 0119, restated by name (hosted Supabase keeps direct
-- anon/authenticated grants that `from public` alone does not remove).
do $$
declare f text;
begin
  foreach f in array array[
    'public._sheet_sync_fence(uuid)',
    'public._sheet_sync_record_changes(uuid, jsonb, jsonb)',
    'public.sheet_sync_acquire(text, uuid, boolean)',
    'public.sheet_sync_heartbeat(uuid)',
    'public.sheet_sync_finish(uuid, text, jsonb, jsonb, text)',
    'public.sheet_mirror_stage(uuid, text, jsonb)',
    'public.sheet_mirror_commit(uuid, text)',
    'public.sheet_sync_apply_customer_ops(uuid, jsonb)',
    'public.sheet_sync_upsert_review(uuid, text, jsonb, boolean)',
    'public.sheet_resort_apply(uuid, uuid[], text, text)',
    'public.sheet_alias_apply(uuid, text, text, uuid)',
    'public.sheet_sync_revert_run(uuid, uuid)',
    'public.sheet_review_resolve(uuid, uuid, text, uuid)',
    'public.sheet_resort_candidates()'] loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke execute on function %s from anon, authenticated', f);
  end loop;
end $$;
revoke execute on function public._sheet_sync_fence(uuid) from service_role;
revoke execute on function public._sheet_sync_record_changes(uuid, jsonb, jsonb) from service_role;
grant execute on function public.sheet_sync_acquire(text, uuid, boolean) to service_role;
grant execute on function public.sheet_sync_heartbeat(uuid) to service_role;
grant execute on function public.sheet_sync_finish(uuid, text, jsonb, jsonb, text) to service_role;
grant execute on function public.sheet_mirror_stage(uuid, text, jsonb) to service_role;
grant execute on function public.sheet_mirror_commit(uuid, text) to service_role;
grant execute on function public.sheet_sync_apply_customer_ops(uuid, jsonb) to service_role;
grant execute on function public.sheet_sync_upsert_review(uuid, text, jsonb, boolean) to service_role;
grant execute on function public.sheet_resort_apply(uuid, uuid[], text, text) to service_role;
grant execute on function public.sheet_alias_apply(uuid, text, text, uuid) to service_role;
grant execute on function public.sheet_sync_revert_run(uuid, uuid) to service_role;
grant execute on function public.sheet_review_resolve(uuid, uuid, text, uuid) to service_role;
grant execute on function public.sheet_resort_candidates() to service_role;

-- 6. Post-conditions (abort the deploy, never a user) ------------------------
do $$
begin
  if (select count(*) from public.referral_sources) <> 18 then
    raise exception '0170: expected 18 referral sources';
  end if;
  if exists (select 1 from public.patients where referral_source is not null and referral_source_origin is distinct from 'staff') then
    raise exception '0170: an existing referral_source was not marked staff-owned';
  end if;
  if not (select paused from public.sheet_sync_settings where id) then
    raise exception '0170: sheet sync must ship paused';
  end if;
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
                and c.relname in ('sheet_sync_settings','sheet_sync_runs','sheet_sync_review_items','sheet_sync_changes',
                  'sheet_patient_links','patient_acquisition_facts','referral_source_aliases','sheet_customer_rows',
                  'sheet_encounter_lines','sheet_mirror_staging')) then
    raise exception '0170: RLS missing on a sheet sync table';
  end if;
  if has_function_privilege('authenticated', 'public.sheet_sync_apply_customer_ops(uuid, jsonb)', 'execute')
     or has_function_privilege('anon', 'public.sheet_sync_acquire(text, uuid, boolean)', 'execute') then
    raise exception '0170: sheet sync RPCs must be service_role only';
  end if;
end $$;
```

Notes the implementer must verify while writing:
- `referral-sources.test.ts` parses `insert into public.referral_sources (…) values (…);` by regex. The `on conflict … do nothing` tail sits inside the captured group and does not break the tuple regex, but run the test (Step 4) to prove it.
- `jsonb_populate_record(null::public.sheet_customer_rows, …)` also carries `id` / `run_id` keys, which the select list ignores. The runner never sends `pending_create_key` (Task 11 strips it).
- A post-condition `raise` inside `do $$` is exempt from `pg-error-coverage.test.ts`; runtime raises carry codes.

- [ ] **Step 2: Seed tail.** Append to `supabase/seed.sql`:

```sql
-- 0170: Sheet Sync tables are admin-read (RLS) and never reachable by anon;
-- writes only through service-role RPCs. Staging is service-role only.
revoke all on public.sheet_sync_settings from anon;
revoke all on public.sheet_sync_settings from authenticated;
grant select on public.sheet_sync_settings to authenticated;
-- … the same three lines for sheet_sync_runs, sheet_sync_review_items, sheet_sync_changes,
-- sheet_patient_links, patient_acquisition_facts, referral_source_aliases, sheet_customer_rows,
-- sheet_encounter_lines (write them all out) …
revoke all on public.sheet_mirror_staging from anon;
revoke all on public.sheet_mirror_staging from authenticated;
```

- [ ] **Step 3: P-codes.** In `src/lib/accounting/pg-errors.ts`, before `default:` add:

```ts
    case "P0062":
      return "Another sheet sync is running. Try again in a few minutes.";
    case "P0063":
      return "This sheet sync stopped because a newer run took over. Check the run history.";
    case "P0064":
      return "Someone already handled this review item. Refresh the page.";
```

- [ ] **Step 4: Channels in TypeScript (D9).** In `src/lib/patients/referral-sources.ts`, make `REFERRAL_SOURCE_IDS` the 18 ids in sort order:
`doctor_referral, customer_referral, family_friends, online_facebook, online_website, online_google, online_instagram, online_tiktok, walk_in, walk_in_signage, returning_patient, phone_text_viber, tenant_employee_northridge, partner_corporate, gift_code, flyers, prefer_not_to_say, other`.
Staff labels = the migration labels. Public labels:
`family_friends: "A friend or family member"`, `customer_referral: "Another DRMed patient told me"` (changed), `walk_in_signage: "I saw your sign or poster"`, `phone_text_viber: "A call, text or Viber message"`, `partner_corporate: "My company or organisation"`, `flyers: "A flyer"`, `prefer_not_to_say: "I'd rather not say"`.
In `referral-sources.test.ts`, change the expected row count from 12 to 18. Then run `grep -rn "A friend or family member\|customer_referral" src --include=*.test.ts*` and update any test that pinned the old public wording. Change `mapAnswer`'s `id` type to `ReferralSourceId | null` and `RULES` to `ReadonlyArray<[ReferralSourceId, RegExp]>`.

- [ ] **Step 5: Replay on a fresh local stack.** Check first that the local stack is not in use by another worktree's session. `supabase status` shows it; the stack is shared across worktrees, see memory `drmed-migration-number-collision`. If another branch's migrations are applied, coordinate before resetting. Then run:

```bash
/opt/homebrew/bin/supabase db reset 2>&1 | tail -5
```
Expected: the reset finishes with no error; the 0170 post-condition block passes.

- [ ] **Step 6: Regenerate types** — `npm run db:types` → `src/types/database.ts` gains the ten tables, the two patients columns and the RPCs.

- [ ] **Step 7: Run the gate** — `npm test && npm run typecheck && npm run lint`. Expected PASS, including `referral-sources.test.ts`, `seed-grant-parity.test.ts`, `pg-error-coverage.test.ts` and the booking/registration validation tests.

- [ ] **Step 8: Commit** — `git add supabase/migrations/0170_sheet_sync_foundation.sql supabase/seed.sql src/lib/accounting/pg-errors.ts src/lib/patients src/lib/sheet-sync/referral-mapper.ts src/types/database.ts` (+ any test updated in Step 4) — `git commit -m "feat(db): 0170 sheet sync foundation — channels, ownership trigger, lease-fenced RPCs"`

---

### Task 9: Local database proofs (hand-run)

**Files:**
- Create: `scripts/sheet-sync-db-proof.ts`
- Modify: `package.json` (`"sheet-sync:db-proof": "tsx scripts/sheet-sync-db-proof.ts"`)

Model it on `scripts/perf/rls-equivalence-prove.ts`. Read that file first for the `pg` client setup, the `DB_URL` default (`postgresql://postgres:postgres@127.0.0.1:54322/postgres`), and how it impersonates principals. `import "./lib/load-env"` goes first and `requireLocalOrExplicitProd("sheet-sync:db-proof", { writes: "nothing (every check runs inside a transaction that is rolled back)" })` comes before the client. **Refuse to run against a non-local host even with `--prod`**: after the guard, `if (!/127\.0\.0\.1|localhost/.test(DB_URL)) process.exit(2)`.

Everything runs in ONE transaction that ends in `rollback`. Each check is a `savepoint` / `rollback to savepoint` pair, so an expected error does not abort the rest. Print one line per check (`PASS`/`FAIL name — detail`) and exit 1 on any FAIL.

Fixture setup inside the transaction:
- three `auth.users` + `staff_profiles` rows: an active admin, an active reception user, and an **inactive** admin. Copy the columns the rls-prove script uses.
- one patient `P` (`referral_source = 'walk_in'`) inserted as `postgres` with no setting → assert origin `staff`, `row_version = 0`.
- `update sheet_sync_settings set paused = false` (inside the transaction only).

Impersonation: `set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub', <uid>, 'role', 'authenticated')::text, true);` Reset with `reset role`. For anon: `set local role anon`. For a portal patient: `set local role anon` + claims carrying `patient_id` (see `src/lib/supabase/patient.ts` for the claim name).

Checks (each a function returning `[name, ok, detail]`):

1. **ACL matrix.** For each of the nine admin-read tables, as admin: `select count(*)` succeeds. As reception: it succeeds and returns 0 rows after one row is inserted as `postgres`. As the inactive admin: 0 rows (`has_role` requires active). As anon and as the portal patient: `permission denied` (42501). `sheet_mirror_staging`: 42501 for every JWT role.
2. **RPC ACL.** As `authenticated` (admin): `select public.sheet_sync_acquire('manual', null, true)` → 42501. Repeat for each RPC name in the migration's list. As `service_role` (`set local role service_role`): acquire works.
3. **Ownership trigger.** As `authenticated` admin (the staff client path), `update patients set referral_source = 'online_google', referral_source_origin = 'sheet' where id = P` → origin is `staff` and `row_version` went up by 1. As `postgres` with no setting, change the source → `staff`. Call `resolve_patient_guarded` with a new email and `referral_source = 'online_facebook'` → the new row's origin is `patient`. Set it to NULL → origin NULL.
4. **Pause.** With `paused = true`: `sheet_sync_acquire('cron', null, false)` returns `skipped_paused` and inserts a `skipped_paused` run; `('cron', null, true)` (dry run) returns `running`.
5. **Lease + fencing.** With `paused = false`: acquire A → `running`. Acquire B → P0062. `update sheet_sync_runs set heartbeat_at = now() - interval '11 minutes'` on A. Acquire B → `running` and A is now `failed`. `sheet_mirror_stage(A.token, 'lab', '[]')` → P0063. `sheet_sync_finish(A.token, …)` → P0063.
6. **Snapshot atomicity.** With lease B, stage 3 chunks of 2 lab rows (valid `sheet_encounter_lines` JSON, `identity_key` `name:x|y`). Before commit, `sheet_encounter_lines where tab='lab'` still holds the 1 pre-existing row. After `sheet_mirror_commit(B,'lab')` it holds exactly 6 rows and the staging rows for B are gone. Also: a commit with a stale token raises P0063 and leaves the live rows untouched.
7. **Conditional fill never overwrites.** Patient Q: `phone = '+639170000000'`, `email = null`, `referral_source = 'walk_in'` (staff). Op `fill` with phone `+639171111111`, email `q@example.com`, `referral_source = 'online_facebook'` → phone unchanged, email filled, source unchanged (staff-owned). Exactly one `sheet_sync_changes` row (`email`). A second identical op → no change, `row_version` unchanged (no-op update suppressed).
8. **Sheet-owned channel follows the sheet.** Patient R with origin `sheet` via `sheet_resort_apply` from `other` → `online_google`: origin `sheet`. Then a fill op with `referral_source: null` → source NULL, origin NULL.
9. **Create.** A `create` op with no birthdate → the row exists with `legacy_import_run_id` set, origin `sheet`, one `create` change row, links for each `link_keys` entry, and a facts row. The run now carries `legacy_import_run_id`.
10. **Revert.** Run S fills patient T's email. `sheet_sync_revert_run` (new lease) restores it: email back to NULL and `restored = 1`. Run U fills patient V's email, then a staff update touches V → revert reports `blocked = 1` and V is unchanged. Revert of the run that created patient W (untouched) → W deleted, `deleted = 1`. A second revert of the same run → `22023`.
11. **Review upsert.** Two upserts of the same `(kind,item_key)` → one open row, `last_seen_at` moved. Dismiss it → the next upsert does not reopen it. `p_clear_absent = true` with an empty list → the other open items of that tab become `resolved` with `resolution.auto`. `sheet_review_resolve` on a resolved item → P0064.

- [ ] **Step 1: Write the script** (checks above; ~350 lines).
- [ ] **Step 2: Run** `npm run sheet-sync:db-proof` → every line PASS, exit 0. If a check fails, fix the **migration** (then `supabase db reset`, `npm run db:types`) and amend the Task 8 commit only if nothing else was committed after it; otherwise commit the fix as `fix(db): …`.
- [ ] **Step 3: Control test.** Temporarily drop `and r.status = 'running'` from `_sheet_sync_fence` → check 5 must FAIL (the taken-over worker could still write). Comment out the `app.referral_origin` read in the trigger → check 3 must FAIL. Restore both, `supabase db reset`, re-run → all PASS. This proves the checks are not vacuous (memory: vacuous-assertions trap).
- [ ] **Step 4: Run** `npx vitest run scripts/lib/guard-coverage.test.ts` → PASS (the new runner is discovered automatically).
- [ ] **Step 5: Commit** — `git commit -m "test(db): hand-run local proofs for sheet sync ACLs, fencing, fill and revert"`

---

# Phase C — runtime

### Task 10: Shared Google token helper and the sheet reader

**Files:**
- Create: `src/lib/google/service-account-token.ts`, `src/lib/google/service-account-token.test.ts`
- Modify: `src/lib/accounting/google-sheets.ts` (use the helper; behaviour unchanged)
- Create: `src/lib/sheet-sync/reader.ts`, `src/lib/sheet-sync/reader.test.ts`, `src/lib/sheet-sync/config.ts`

- [ ] **Step 1: Failing test** `service-account-token.test.ts`. Generate a real RSA key in the test so `jose` signs for real:

```ts
import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetTokenCacheForTests, getServiceAccountToken } from "./service-account-token";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const SA = JSON.stringify({ client_email: "svc@example.iam.gserviceaccount.com", private_key: privateKey });

describe("getServiceAccountToken", () => {
  beforeEach(() => __resetTokenCacheForTests());
  it("caches per scope", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ access_token: "t", expires_in: 3600 })));
    await getServiceAccountToken(SA, "scope-a", f as unknown as typeof fetch);
    await getServiceAccountToken(SA, "scope-a", f as unknown as typeof fetch);
    await getServiceAccountToken(SA, "scope-b", f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("sends a signed JWT assertion with the scope", async () => {
    const f = vi.fn(async (_u: string, init: RequestInit) => {
      const assertion = new URLSearchParams(String(init.body)).get("assertion")!;
      const claims = JSON.parse(Buffer.from(assertion.split(".")[1], "base64url").toString());
      expect(claims).toMatchObject({ iss: "svc@example.iam.gserviceaccount.com", scope: "scope-a" });
      return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }));
    });
    expect(await getServiceAccountToken(SA, "scope-a", f as unknown as typeof fetch)).toBe("t");
  });
  it("throws a clear error on a failed exchange without echoing the key", async () => {
    const f = vi.fn(async () => new Response("nope", { status: 400 }));
    await expect(getServiceAccountToken(SA, "s", f as unknown as typeof fetch)).rejects.toThrow(/token exchange failed \(400\)/);
  });
});
```

- [ ] **Step 2: Implement** `src/lib/google/service-account-token.ts`. Move `parseServiceAccount` and the body of `fetchAccessToken` from `src/lib/accounting/google-sheets.ts` (lines ~20–86) here. Changes: the cache becomes `const cache = new Map<string, { accessToken: string; expiresAt: number }>()` keyed by `` `${sa.client_email}|${scope}` ``; `scope` and `fetchImpl` are parameters; add `export function __resetTokenCacheForTests() { cache.clear(); }`. **No `server-only`** (the CLI imports it). It holds no secret of its own; the caller passes the JSON.

  In `google-sheets.ts`, delete the moved code and call `getServiceAccountToken(serviceAccountJson, "https://www.googleapis.com/auth/spreadsheets")` where `fetchAccessToken(...)` was called. Keep `import "server-only"` there.

- [ ] **Step 3: Failing test** `reader.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { readSheetTabs } from "./reader";

const ok = (ranges: Array<{ range: string; values?: unknown[][] }>) =>
  vi.fn(async () => new Response(JSON.stringify({ valueRanges: ranges })));

describe("readSheetTabs", () => {
  it("makes ONE batchGet with unformatted values and serial dates, and maps tabs", async () => {
    const f = ok([
      { range: "'CUSTOMER LIST2'!A1:V9", values: [["h"]] },
      { range: "'LAB SERVICE'!A1:T9", values: [["h"]] },
      { range: "'DOCTOR CONSULTATION'!A1:R9" },
    ]);
    const tabs = await readSheetTabs({ sheetId: "SHEET", token: async () => "tok", fetchImpl: f as unknown as typeof fetch });
    expect(f).toHaveBeenCalledTimes(1);
    const url = String(f.mock.calls[0][0]);
    expect(url).toContain("/spreadsheets/SHEET/values:batchGet?");
    expect(url).toContain("valueRenderOption=UNFORMATTED_VALUE");
    expect(url).toContain("dateTimeRenderOption=SERIAL_NUMBER");
    expect(tabs.customers).toEqual([["h"]]);
    expect(tabs.consult).toEqual([]);
  });
  it("refuses a response whose ranges do not match the requested tabs", async () => {
    const f = ok([{ range: "'OTHER'!A1:B2", values: [] }, { range: "'LAB SERVICE'!A1", values: [] }, { range: "'DOCTOR CONSULTATION'!A1", values: [] }]);
    await expect(readSheetTabs({ sheetId: "S", token: async () => "t", fetchImpl: f as unknown as typeof fetch })).rejects.toThrow(/CUSTOMER LIST2/);
  });
  it("reports the HTTP status on failure", async () => {
    const f = vi.fn(async () => new Response("denied", { status: 403 }));
    await expect(readSheetTabs({ sheetId: "S", token: async () => "t", fetchImpl: f as unknown as typeof fetch })).rejects.toThrow(/403/);
  });
});
```

- [ ] **Step 4: Implement** `reader.ts`:

```ts
import { SHEET_TAB_NAMES, type Cell, type RawTabs, type TabKey } from "./types";

const MAX_ROWS_PER_TAB = 200_000;

/**
 * ONE values.batchGet over every synced tab → one consistent snapshot (spec §3).
 * UNFORMATTED_VALUE + SERIAL_NUMBER: dates arrive as serials, currency as numbers,
 * text as typed. The response is validated tab by tab; a mismatch throws.
 */
export async function readSheetTabs(opts: {
  sheetId: string;
  token: () => Promise<string>;
  fetchImpl?: typeof fetch;
}): Promise<RawTabs> {
  const f = opts.fetchImpl ?? fetch;
  const keys = Object.keys(SHEET_TAB_NAMES) as TabKey[];
  const qs = keys.map((k) => `ranges=${encodeURIComponent(`'${SHEET_TAB_NAMES[k]}'`)}`).join("&");
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(opts.sheetId)}/values:batchGet?${qs}` +
    "&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER&majorDimension=ROWS";
  const res = await f(url, { headers: { authorization: `Bearer ${await opts.token()}` } });
  if (!res.ok) throw new Error(`Google Sheets read failed (${res.status})`);
  const body = (await res.json()) as { valueRanges?: Array<{ range?: string; values?: Cell[][] }> };
  const ranges = body.valueRanges ?? [];
  const out = {} as RawTabs;
  keys.forEach((k, i) => {
    const vr = ranges[i];
    const name = SHEET_TAB_NAMES[k];
    if (!vr?.range || !vr.range.startsWith(`'${name}'!`)) throw new Error(`Google Sheets returned no range for tab "${name}"`);
    const values = vr.values ?? [];
    if (!Array.isArray(values) || values.length > MAX_ROWS_PER_TAB) throw new Error(`Tab "${name}" returned an unexpected shape`);
    out[k] = values;
  });
  return out;
}
```

- [ ] **Step 5: Implement** `config.ts` (no test; exercised by the CLI and cron):

```ts
import { getServiceAccountToken } from "../google/service-account-token";
import { readSheetTabs } from "./reader";
import type { RawTabs } from "./types";

export const SHEETS_READONLY_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";

export function missingSheetEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return ["LEGACY_SHEET_ID", "GOOGLE_SERVICE_ACCOUNT_JSON"].filter((k) => !env[k]);
}

/** The runner's readSheet dependency, built from env. Throws a plain message naming what is missing. */
export function sheetReaderFromEnv(env: NodeJS.ProcessEnv = process.env): () => Promise<RawTabs> {
  return async () => {
    const missing = missingSheetEnv(env);
    if (missing.length) throw new Error(`Sheet sync is not configured: missing ${missing.join(", ")}`);
    return readSheetTabs({
      sheetId: env.LEGACY_SHEET_ID!,
      token: () => getServiceAccountToken(env.GOOGLE_SERVICE_ACCOUNT_JSON!, SHEETS_READONLY_SCOPE),
    });
  };
}
```

- [ ] **Step 6: Run** `npx vitest run src/lib/google src/lib/sheet-sync src/lib/accounting && npm run typecheck` → PASS.
- [ ] **Step 7: Commit** — `git commit -m "feat(sheet-sync): per-scope Google token helper and one-request sheet reader"`

---

### Task 11: The store and `runSheetSync`

**Files:**
- Create: `src/lib/sheet-sync/store.ts`, `src/lib/sheet-sync/run.ts`, `src/lib/sheet-sync/run.test.ts`, `src/lib/sheet-sync/fake-store.ts` (test helper; name ends `.ts` but lives beside the test and is imported only by tests)

- [ ] **Step 1: Write `store.ts`** — the interface plus the supabase implementation:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "../reports/paging";
import type { Database, Json } from "../../types/database";
import type {
  CustomerOp, FactsRecord, LinkRecord, PatientRecord, PrevCustomerRow, ReviewItemInput, TabKey,
} from "./types";

export class SyncBusyError extends Error { constructor() { super("Another sheet sync is running."); this.name = "SyncBusyError"; } }
export class LeaseLostError extends Error { constructor() { super("This sheet sync lost its turn to another run."); this.name = "LeaseLostError"; } }

export type AcquireResult =
  | { status: "running"; runId: string; leaseToken: string }
  | { status: "skipped_paused"; runId: string };

export interface AuditRow {
  actor_id: string | null;
  actor_type: "staff" | "system";
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  metadata: Json;
}

export interface SheetSyncStore {
  acquire(trigger: "cron" | "manual" | "cli" | "resort" | "alias" | "revert", actorId: string | null, dryRun: boolean): Promise<AcquireResult>;
  heartbeat(lease: string): Promise<void>;
  finish(lease: string, status: "succeeded" | "partial" | "failed", perTab: Json, summary: Json, error: string | null): Promise<void>;
  readSettings(): Promise<{ paused: boolean; mirrorWindowStart: string }>;
  lastGoodRowsRead(): Promise<Partial<Record<TabKey, number>>>;
  isSuspectAccepted(tab: TabKey, rowsRead: number): Promise<boolean>;
  loadPatients(): Promise<PatientRecord[]>;
  loadLinks(): Promise<LinkRecord[]>;
  loadFacts(): Promise<FactsRecord[]>;
  loadAliases(): Promise<Map<string, string>>;
  loadCustomerMirror(): Promise<PrevCustomerRow[]>;
  applyCustomerOps(lease: string, ops: CustomerOp[]): Promise<{ created: Record<string, string>; counts: Record<string, number> }>;
  stage(lease: string, tab: TabKey, rows: Json[]): Promise<void>;
  commit(lease: string, tab: TabKey): Promise<number>;
  upsertReview(lease: string, tab: TabKey, items: ReviewItemInput[], clearAbsent: boolean): Promise<Record<string, number>>;
  resortApply(lease: string, patientIds: string[], expectedOld: string | null, next: string | null): Promise<number>;
  aliasApply(lease: string, answerNorm: string, sourceId: string, actorId: string): Promise<number>;
  revertRun(lease: string, targetRunId: string): Promise<Record<string, number>>;
  reviewResolve(itemId: string, actorId: string, action: "link" | "create" | "dismiss", patientId: string | null): Promise<void>;
  resortCandidates(): Promise<Array<{ id: string; answer: string; referral_source: string | null; referral_source_origin: "staff" | "patient" | "sheet" | null }>>;
  audit(row: AuditRow): Promise<void>;
}

type Client = SupabaseClient<Database>;

/** Maps P0062/P0063 to typed errors; everything else becomes an Error with the PG message. */
function raise(error: { code?: string; message: string }): never {
  if (error.code === "P0062") throw new SyncBusyError();
  if (error.code === "P0063") throw new LeaseLostError();
  const e = new Error(error.message) as Error & { code?: string };
  e.code = error.code;
  throw e;
}

const PATIENT_COLUMNS = "id, drm_id, first_name, middle_name, last_name, birthdate, phone, phone_normalized, email, sex, " +
  "address, referred_by_doctor, preferred_release_medium, senior_pwd_id_kind, senior_pwd_id_number, referral_source, " +
  "referral_source_origin, merged_into_id";

const ALL = 200_000; // ceiling for the paged loaders — far above today's ~8k patients

export function createSupabaseStore(client: Client): SheetSyncStore {
  const rpc = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC names are checked against Database by the typed wrappers below
    const { data, error } = await (client.rpc as any)(fn, args);
    if (error) raise(error);
    return data as T;
  };
  const all = async <T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>) => {
    const { rows, truncated } = await fetchAllRows(page, ALL);
    if (truncated) throw new Error("Sheet sync loader hit its row ceiling");
    return rows;
  };
  return {
    async acquire(trigger, actorId, dryRun) {
      const r = await rpc<{ status: string; run_id: string; lease_token?: string }>("sheet_sync_acquire",
        { p_trigger: trigger, p_actor: actorId, p_dry_run: dryRun });
      return r.status === "running"
        ? { status: "running", runId: r.run_id, leaseToken: r.lease_token! }
        : { status: "skipped_paused", runId: r.run_id };
    },
    heartbeat: (lease) => rpc("sheet_sync_heartbeat", { p_lease_token: lease }),
    finish: (lease, status, perTab, summary, error) =>
      rpc("sheet_sync_finish", { p_lease_token: lease, p_status: status, p_per_tab: perTab, p_summary: summary, p_error: error }),
    async readSettings() {
      const { data, error } = await client.from("sheet_sync_settings").select("paused, mirror_window_start").eq("id", true).single();
      if (error) raise(error);
      return { paused: data.paused, mirrorWindowStart: data.mirror_window_start };
    },
    async lastGoodRowsRead() {
      const { data, error } = await client.from("sheet_sync_runs").select("per_tab")
        .eq("dry_run", false).in("status", ["succeeded", "partial"])
        .order("started_at", { ascending: false }).order("id", { ascending: true }).limit(30);
      if (error) raise(error);
      const out: Partial<Record<TabKey, number>> = {};
      for (const row of data ?? []) {
        const per = (row.per_tab ?? {}) as Record<string, { status?: string; rows_read?: number }>;
        for (const k of ["customers", "lab", "consult"] as TabKey[]) {
          if (out[k] === undefined && per[k]?.status === "succeeded" && typeof per[k]?.rows_read === "number") out[k] = per[k]!.rows_read;
        }
      }
      return out;
    },
    async isSuspectAccepted(tab, rowsRead) {
      const { count, error } = await client.from("sheet_sync_review_items").select("id", { count: "exact", head: true })
        .eq("kind", "suspect_snapshot").eq("item_key", `${tab}:${rowsRead}`).eq("status", "dismissed");
      if (error) raise(error);
      return (count ?? 0) > 0;
    },
    loadPatients: () => all<PatientRecord>((from, to) =>
      client.from("patients").select(PATIENT_COLUMNS).order("id").range(from, to) as never),
    loadLinks: () => all<LinkRecord>((from, to) =>
      client.from("sheet_patient_links").select("link_key, patient_id, decision, method").order("link_key").range(from, to) as never),
    loadFacts: () => all<FactsRecord>((from, to) =>
      client.from("patient_acquisition_facts").select("patient_id, registered_on, sheet_new_repeat, source_ref").order("patient_id").range(from, to) as never),
    async loadAliases() {
      const rows = await all<{ raw_normalized: string; referral_source_id: string }>((from, to) =>
        client.from("referral_source_aliases").select("raw_normalized, referral_source_id").order("raw_normalized").range(from, to) as never);
      return new Map(rows.map((r) => [r.raw_normalized, r.referral_source_id]));
    },
    loadCustomerMirror: () => all<PrevCustomerRow>((from, to) =>
      client.from("sheet_customer_rows").select("source_key, patient_id, phone_norm, dob, link_state").order("id").range(from, to) as never),
    applyCustomerOps: (lease, ops) => rpc("sheet_sync_apply_customer_ops", { p_lease_token: lease, p_ops: ops }),
    async stage(lease, tab, rows) { await rpc("sheet_mirror_stage", { p_lease_token: lease, p_tab: tab, p_rows: rows }); },
    commit: (lease, tab) => rpc("sheet_mirror_commit", { p_lease_token: lease, p_tab: tab }),
    upsertReview: (lease, tab, items, clearAbsent) =>
      rpc("sheet_sync_upsert_review", { p_lease_token: lease, p_tab: tab, p_items: items, p_clear_absent: clearAbsent }),
    resortApply: (lease, ids, expectedOld, next) =>
      rpc("sheet_resort_apply", { p_lease_token: lease, p_patient_ids: ids, p_expected_old: expectedOld, p_new: next }),
    aliasApply: (lease, answerNorm, sourceId, actorId) =>
      rpc("sheet_alias_apply", { p_lease_token: lease, p_raw_normalized: answerNorm, p_source_id: sourceId, p_actor: actorId }),
    revertRun: (lease, target) => rpc("sheet_sync_revert_run", { p_lease_token: lease, p_target_run: target }),
    async reviewResolve(itemId, actorId, action, patientId) {
      await rpc("sheet_review_resolve", { p_item_id: itemId, p_actor: actorId, p_action: action, p_patient_id: patientId });
    },
    resortCandidates: () => all((from, to) => client.rpc("sheet_resort_candidates").range(from, to) as never),
    async audit(row) {
      const { error } = await client.from("audit_log").insert(row);
      if (error) console.error("sheet sync audit insert failed", { action: row.action, error: error.message });
    },
  };
}
```

After `npm run db:types` the typed `client.rpc("…")` overloads exist. Replace the `any` wrapper with typed calls if `tsc` accepts them cleanly, and drop the eslint comment. Keep whichever form typechecks without `any` leaking into callers.

- [ ] **Step 2: Write `fake-store.ts`** — an in-memory `SheetSyncStore` for tests. It records every call in `calls: Array<[method, ...args]>` and holds `paused`, `busy`, `leaseLostAfter` (throw `LeaseLostError` on the Nth write), `patients`, `links`, `facts`, `aliases`, `mirror`, `lastGood` and `acceptedSuspect`. `applyCustomerOps` answers creates with `created[create_key] = "new-" + create_key`. Keep it under 150 lines.

- [ ] **Step 3: Failing tests** `run.test.ts`, using the fake store and small synthetic tabs. Import the header fixtures from `src/lib/sheet-sync/__fixtures__/tab-headers.ts` (created in Task 4).

```ts
describe("runSheetSync", () => {
  it("paused: records skipped_paused, audits sheet_sync.skipped as system for cron, reads nothing", async () => { /* store.paused = true; readSheet spy not called; audit action 'sheet_sync.skipped', actor_type 'system'; result.status 'skipped_paused' */ });
  it("dry run: plans every tab, writes NOTHING but finish + audit", async () => { /* calls contain no applyCustomerOps/stage/commit/upsertReview; finish per_tab.customers.planned.create === 1 */ });
  it("real run: ops → stage (≤2000 per chunk) → commit per tab → review upsert with clearAbsent", async () => { /* 4,500 lab rows → 3 stage calls for lab; commit('lab') once; created ids replace pending_create_key in staged customer rows; staged rows have no pending_create_key key */ });
  it("a failing tab makes the run partial, the others still commit, and the audit is sheet_sync.partial", async () => { /* consult headers moved → per_tab.consult.status 'failed', error mentions header; lab committed */ });
  it("a >5% shrink skips that tab as suspect and raises suspect_snapshot without clearing other items", async () => { /* lastGood.lab = 100, sheet has 90 → upsertReview('lab', [suspect], false); no stage for lab; status partial */ });
  it("an accepted suspect count proceeds", async () => { /* acceptedSuspect has 'lab:90' → lab committed */ });
  it("sheet read failure → failed run with the error, finish still called", async () => {});
  it("lease lost mid-run stops without calling finish and reports failed", async () => { /* leaseLostAfter = 2 → result.status 'failed', no finish call */ });
  it("busy → throws SyncBusyError before reading the sheet", async () => {});
  it("audit metadata carries counts and ids only — no names", async () => { /* JSON.stringify(audit.metadata) does not contain the invented patient's surname */ });
  it("manual runs audit as staff with the actor id", async () => {});
});
```

Write each test body fully. The comments state what each one asserts.

- [ ] **Step 4: Implement `run.ts`:**

```ts
import { todayManilaISODate } from "../dates/manila";
import type { Json } from "../../types/database";
import { planCustomers } from "./customer-plan";
import { assignIdentities, type IdentifiedLine } from "./encounter-identity";
import { buildPatientIndex, type PatientIndex } from "./patient-index";
import { checkSnapshot } from "./snapshot";
import { LeaseLostError, SyncBusyError, type SheetSyncStore } from "./store";
import { parseCustomersTab } from "./tabs/customers";
import { parseConsultTab, parseLabTab } from "./tabs/encounters";
import type { CustomerMirrorRow, CustomerOp, LinkRecord, RawTabs, TabKey, TabParse } from "./types";

export const OPS_CHUNK = 500;
export const STAGE_CHUNK = 2000;

export type RunTrigger = "cron" | "manual" | "cli";
export interface TabOutcome {
  status: "succeeded" | "failed" | "skipped";
  rows_read?: number;
  last_date?: string | null;
  undated?: number;
  planned?: Record<string, unknown>;
  applied?: Record<string, number>;
  mirror_rows?: number;
  review?: Record<string, number>;
  error?: string;
}
export interface RunOutcome {
  runId: string | null;
  status: "skipped_paused" | "succeeded" | "partial" | "failed";
  perTab: Partial<Record<TabKey, TabOutcome>>;
  durationMs: number;
  error?: string;
}

const chunks = <T>(a: readonly T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const countKinds = (items: { kind: string }[]) => items.reduce<Record<string, number>>((m, i) => ((m[i.kind] = (m[i.kind] ?? 0) + 1), m), {});
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function lineToRow(l: IdentifiedLine): Json {
  return {
    sheet_row: l.sheetRow, service_date: l.serviceDate, name_raw: l.nameRaw, name_norm: l.nameNorm, loose_key: l.looseKey,
    patient_id: l.patientId, identity_key: l.identityKey, service_raw: l.serviceRaw, doctor_raw: l.doctorRaw,
    hmo_raw: l.hmoRaw, base_php: l.basePhp, final_php: l.finalPhp, clinic_fee_php: l.clinicFeePhp, revenue_php: l.revenuePhp,
    payment_method_raw: l.paymentMethodRaw, payment_detail_raw: l.paymentDetailRaw, release_medium_raw: l.releaseMediumRaw,
    released_on: l.releasedOn, control_no: l.controlNo, test_no: l.testNo, raw: l.raw as Json, row_hash: l.rowHash,
  };
}

export async function runSheetSync(opts: {
  store: SheetSyncStore;
  readSheet: () => Promise<RawTabs>;
  trigger: RunTrigger;
  actorId: string | null;
  dryRun: boolean;
  today?: string;
  now?: () => number;
}): Promise<RunOutcome> {
  const { store } = opts;
  const now = opts.now ?? Date.now;
  const started = now();
  const today = opts.today ?? todayManilaISODate();
  const actorType = opts.trigger === "cron" ? "system" : "staff";
  const audit = (action: string, runId: string | null, metadata: Record<string, unknown>) =>
    store.audit({ actor_id: opts.actorId, actor_type: actorType, action, resource_type: "sheet_sync_run", resource_id: runId, metadata: metadata as Json });

  const acq = await store.acquire(opts.trigger, opts.actorId, opts.dryRun); // SyncBusyError propagates
  if (acq.status === "skipped_paused") {
    await audit("sheet_sync.skipped", acq.runId, { reason: "paused", trigger: opts.trigger });
    return { runId: acq.runId, status: "skipped_paused", perTab: {}, durationMs: now() - started };
  }
  const lease = acq.leaseToken;
  const perTab: Partial<Record<TabKey, TabOutcome>> = {};

  try {
    const [raw, settings, lastGood, patients, linkRows, factRows, aliases, prevMirror] = await Promise.all([
      opts.readSheet(), store.readSettings(), store.lastGoodRowsRead(), store.loadPatients(), store.loadLinks(),
      store.loadFacts(), store.loadAliases(), store.loadCustomerMirror(),
    ]);
    let index: PatientIndex = buildPatientIndex(patients);
    const links = new Map<string, LinkRecord>(linkRows.map((l) => [l.link_key, l]));
    const facts = new Map(factRows.map((f) => [f.patient_id, f]));

    /** Shared snapshot gate: false ⇒ tab skipped as suspect (item raised when not dry). */
    const snapshotOk = async (tab: TabKey, parsed: TabParse<unknown>) => {
      const snap = checkSnapshot(parsed.rowsRead, lastGood[tab]);
      if (!snap.suspect || (await store.isSuspectAccepted(tab, parsed.rowsRead))) return true;
      perTab[tab] = { status: "failed", rows_read: parsed.rowsRead, error: `suspect_snapshot: ${snap.previous} → ${snap.current} rows (−${snap.shrinkPct}%)` };
      if (!opts.dryRun) {
        await store.upsertReview(lease, tab, [{ kind: "suspect_snapshot", item_key: `${tab}:${parsed.rowsRead}`,
          payload: { tab, previous: snap.previous, current: snap.current, shrink_pct: snap.shrinkPct } }], false);
      }
      return false;
    };

    // Customers
    try {
      const parsed = parseCustomersTab(raw.customers, { today, aliases });
      if (await snapshotOk("customers", parsed)) {
        const plan = planCustomers({ rows: parsed.rows, index, links, facts, prevRows: prevMirror, importedAtIso: new Date(started).toISOString() });
        const review = [...parsed.issues, ...plan.review];
        const out: TabOutcome = { status: "succeeded", rows_read: parsed.rowsRead, last_date: parsed.lastDate, undated: parsed.undated,
          planned: plan.counts, review: countKinds(review) };
        if (!opts.dryRun) {
          const created: Record<string, string> = {};
          const applied: Record<string, number> = {};
          for (const batch of chunks<CustomerOp>(plan.ops, OPS_CHUNK)) {
            const res = await store.applyCustomerOps(lease, batch);
            Object.assign(created, res.created);
            for (const [k, v] of Object.entries(res.counts)) applied[k] = (applied[k] ?? 0) + v;
          }
          const mirror = plan.mirror.map(({ pending_create_key, ...row }: CustomerMirrorRow) =>
            ({ ...row, patient_id: pending_create_key ? created[pending_create_key] ?? null : row.patient_id }));
          for (const batch of chunks(mirror, STAGE_CHUNK)) await store.stage(lease, "customers", batch as unknown as Json[]);
          out.mirror_rows = await store.commit(lease, "customers");
          await store.upsertReview(lease, "customers", review, true);
          out.applied = applied;
          if (Object.keys(created).length) {
            // Clinical identity must see the patients this run just created.
            index = buildPatientIndex(await store.loadPatients());
            for (const l of await store.loadLinks()) links.set(l.link_key, l);
          }
        }
        perTab.customers = out;
      }
    } catch (e) {
      if (e instanceof LeaseLostError) throw e;
      perTab.customers = { status: "failed", error: errText(e) };
    }
    await store.heartbeat(lease);

    // Lab + consult (reporting mirror only)
    for (const tab of ["lab", "consult"] as const) {
      try {
        const parse = tab === "lab" ? parseLabTab : parseConsultTab;
        const parsed = parse(raw[tab], { today, windowStart: settings.mirrorWindowStart });
        if (!(await snapshotOk(tab, parsed))) continue;
        const lines = assignIdentities(parsed.rows, index, links);
        const out: TabOutcome = { status: "succeeded", rows_read: parsed.rowsRead, last_date: parsed.lastDate, undated: parsed.undated,
          planned: { mirror_rows: lines.length, linked: lines.filter((l) => l.patientId).length }, review: countKinds(parsed.issues) };
        if (!opts.dryRun) {
          for (const batch of chunks(lines.map(lineToRow), STAGE_CHUNK)) await store.stage(lease, tab, batch);
          out.mirror_rows = await store.commit(lease, tab);
          await store.upsertReview(lease, tab, parsed.issues, true);
        }
        perTab[tab] = out;
      } catch (e) {
        if (e instanceof LeaseLostError) throw e;
        perTab[tab] = { status: "failed", error: errText(e) };
      }
      await store.heartbeat(lease);
    }

    const statuses = (["customers", "lab", "consult"] as const).map((t) => perTab[t]?.status ?? "failed");
    const status: RunOutcome["status"] = statuses.every((s) => s === "succeeded") ? "succeeded"
      : statuses.some((s) => s === "succeeded") ? "partial" : "failed";
    const durationMs = now() - started;
    await store.finish(lease, status, perTab as Json, { duration_ms: durationMs, dry_run: opts.dryRun } as Json, null);
    await audit(opts.dryRun ? "sheet_sync.dry_run" : status === "succeeded" ? "sheet_sync.completed" : `sheet_sync.${status}`,
      acq.runId, { trigger: opts.trigger, dry_run: opts.dryRun, status, duration_ms: durationMs, per_tab: summarize(perTab) });
    return { runId: acq.runId, status, perTab, durationMs };
  } catch (e) {
    const durationMs = now() - started;
    if (!(e instanceof LeaseLostError)) {
      await store.finish(lease, "failed", perTab as Json, { duration_ms: durationMs } as Json, errText(e)).catch(() => undefined);
    }
    await audit("sheet_sync.failed", acq.runId, { trigger: opts.trigger, error: e instanceof LeaseLostError ? "lease_lost" : "run_error" });
    return { runId: acq.runId, status: "failed", perTab, durationMs, error: errText(e) };
  }
}

/** Numbers only for audit metadata (never names). */
function summarize(perTab: Partial<Record<TabKey, TabOutcome>>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(perTab)) {
    out[k] = { status: v?.status, rows_read: v?.rows_read, mirror_rows: v?.mirror_rows, applied: v?.applied, review: v?.review };
  }
  return out;
}

/** Re-sort / alias / revert: one fenced run row per admin action (plan D3). Never subject to pause. */
export async function withAdminLease<T>(
  store: SheetSyncStore,
  trigger: "resort" | "alias" | "revert",
  actorId: string,
  fn: (lease: string) => Promise<T>,
): Promise<{ runId: string; result: T }> {
  const acq = await store.acquire(trigger, actorId, false);
  if (acq.status !== "running") throw new Error("Admin sheet-sync actions are never paused"); // defensive
  try {
    const result = await fn(acq.leaseToken);
    await store.finish(acq.leaseToken, "succeeded", {} as Json, { result } as unknown as Json, null);
    return { runId: acq.runId, result };
  } catch (e) {
    if (!(e instanceof LeaseLostError)) {
      await store.finish(acq.leaseToken, "failed", {} as Json, {} as Json, errText(e)).catch(() => undefined);
    }
    throw e;
  }
}

export { LeaseLostError, SyncBusyError };
```

`new Date(started).toISOString()` is a full instant (`legacy_intake.imported_at`), not a truncated date, so `manila-usage.test.ts` allows it. If the guard flags it anyway, pass `nowIso` in instead.

- [ ] **Step 5: Run** `npx vitest run src/lib/sheet-sync && npm run typecheck` → PASS.
- [ ] **Step 6: Commit** — `git commit -m "feat(sheet-sync): lease-fenced runner with dry run, partial tabs and snapshot guard"`

---

### Task 12: CLI `npm run sheet:sync`

**Files:**
- Create: `scripts/sheet-sync.ts`
- Modify: `package.json` (`"sheet:sync": "tsx scripts/sheet-sync.ts"`), `.env.example`

- [ ] **Step 1: Read** `scripts/import-legacy-customers.ts` for how a runner builds its service-role client after the guard, and `scripts/lib/env-guard.ts` for `requireLocalOrExplicitProd` / `requireTargetConfirmation` / `expectedConfirmToken`.

- [ ] **Step 2: Write** `scripts/sheet-sync.ts`:

```ts
/**
 * Sheet Sync CLI — the same runSheetSync the cron and the admin page use.
 *   npm run sheet:sync                          dry run against LOCAL (default)
 *   npm run sheet:sync -- --commit --confirm=local
 *   npm run sheet:sync -- --prod                dry run against prod (reads patient data)
 *   npm run sheet:sync -- --prod --commit --confirm=<project-ref>
 * A commit is refused while the sync is paused (the admin page's switch) — the
 * same rule as the cron. Needs LEGACY_SHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON.
 */
import "./lib/load-env";
import { expectedConfirmToken, requireLocalOrExplicitProd, requireTargetConfirmation } from "./lib/env-guard";

async function main() {
  requireLocalOrExplicitProd("sheet:sync", {
    writes: "patients (create / fill blanks), sheet_sync_* and sheet mirror tables — only with --commit; a dry run still reads patient data",
  });
  const commit = process.argv.includes("--commit");
  if (commit) requireTargetConfirmation("sheet:sync");

  const { createClient } = await import("@supabase/supabase-js");
  const { createSupabaseStore } = await import("../src/lib/sheet-sync/store");
  const { runSheetSync } = await import("../src/lib/sheet-sync/run");
  const { sheetReaderFromEnv } = await import("../src/lib/sheet-sync/config");

  const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const outcome = await runSheetSync({
    store: createSupabaseStore(client as never), readSheet: sheetReaderFromEnv(),
    trigger: "cli", actorId: null, dryRun: !commit,
  });
  console.log(JSON.stringify({ run_id: outcome.runId, status: outcome.status, duration_ms: outcome.durationMs,
    error: outcome.error ?? null, per_tab: outcome.perTab }, null, 2));
  if (!commit) console.log(`\nDry run only. To apply: --commit --confirm=${expectedConfirmToken()}`);
  if (outcome.status === "skipped_paused") console.log("The sync is PAUSED — unpause it on /staff/admin/sheet-sync first.");
  process.exit(outcome.status === "failed" ? 1 : 0);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
```

Match the other runners' exact argument conventions. If they call `requireTargetConfirmation()` with different parameters, follow them.

- [ ] **Step 3: `.env.example`** — under the Google service account entry add:

```
# Sheet Sync (/staff/admin/sheet-sync): the reception Google Sheet "LAB SERVICES (RECEPTION)".
# The service account above needs Viewer on it. Unset = the sync records a failed run saying so.
LEGACY_SHEET_ID=
```

- [ ] **Step 4: Run** `npx vitest run scripts/lib` → PASS (guard coverage sees the guard before `createClient`). Then `npm run sheet:sync` against local with the key exported, to confirm the dry run prints per-tab counts:

```bash
export GOOGLE_SERVICE_ACCOUNT_JSON="$(grep '^GOOGLE_SERVICE_ACCOUNT_JSON=' ~/Claude/DRMed/.env.local | cut -d= -f2- | sed "s/^'//; s/'$//")"
LEGACY_SHEET_ID=199CjfHAO9XqVJ1Yty4eheqCTkg1CJn9YtmPeR6muVDM npm run sheet:sync > "$SCRATCH/cli-dry.json" 2>&1; echo "exit $?"
```
(`$SCRATCH` = the session scratchpad. Read only the `per_tab` numbers; the output holds no names.) Expected: exit 0, `status: "succeeded"`, `rows_read` ≈ 4.9k / 21.5k / 9.0k.

- [ ] **Step 5: Commit** — `git commit -m "feat(sheet-sync): guarded CLI runner (dry run by default)"`

---

### Task 13: Nightly cron (three-place rule) and retention

**Files:**
- Create: `src/app/api/cron/sheet-sync/route.ts`
- Modify: `vercel.json`, `src/lib/ops/cron-heartbeats.ts`, `.github/workflows/cron-watchdog.yml`, `src/app/api/cron/data-retention/route.ts`

- [ ] **Step 1: Failing drift test first.** Add the `CRON_HEARTBEATS` entry only, then run `npx vitest run src/lib/ops/cron-heartbeats.test.ts` → FAIL (vercel.json and the workflow lack it). Entry:

```ts
  {
    key: "sheet-sync",
    label: "Reception sheet sync",
    description: "Copies new patients and the day's lab and consultation lines from the reception Google Sheet. Skipped while paused.",
    path: "/api/cron/sheet-sync",
    schedule: "0 16 * * *",
    actions: ["sheet_sync.completed", "sheet_sync.skipped"],
    maxAge: 30 * 60 * 60 * 1000,
    activeFrom: "2026-09-27",
  },
```

`activeFrom` = the expected merge date + 2 days. Task 21 re-checks it on merge day and bumps all three places together if the merge slips.

- [ ] **Step 2: Add the other two places.** `vercel.json` crons: `{ "path": "/api/cron/sheet-sync", "schedule": "0 16 * * *" }`. Workflow `watched(...)` VALUES:
`('sheet-sync', ARRAY['sheet_sync.completed', 'sheet_sync.skipped'], interval '30 hours', date '2026-09-27'),` (match the existing rows' comma placement).
Run the drift test → PASS.

- [ ] **Step 3: Route** `src/app/api/cron/sheet-sync/route.ts` (copy `sync-accounting/route.ts`'s header, secret check and exports):

```ts
import { NextResponse } from "next/server";
import { withCronMonitor } from "@/lib/ops/cron-monitor";
import { createAdminClient } from "@/lib/supabase/admin";
import { sheetReaderFromEnv } from "@/lib/sheet-sync/config";
import { runSheetSync, SyncBusyError } from "@/lib/sheet-sync/run";
import { createSupabaseStore } from "@/lib/sheet-sync/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// 00:00 Manila. The first catch-up (~4.9k customers, ~3.9k mirror lines) runs via the
// CLI; the nightly delta fits well inside 5 minutes (the admin page records duration).
export const maxDuration = 300;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ ok: false, error: "CRON_SECRET not configured" }, { status: 500 });
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  return withCronMonitor("sheet-sync", async (markFailed) => {
    try {
      const outcome = await runSheetSync({ store: createSupabaseStore(createAdminClient()), readSheet: sheetReaderFromEnv(),
        trigger: "cron", actorId: null, dryRun: false });
      if (outcome.status === "partial" || outcome.status === "failed") markFailed();
      return NextResponse.json({ ok: outcome.status !== "failed", status: outcome.status, run_id: outcome.runId, duration_ms: outcome.durationMs });
    } catch (err) {
      markFailed();
      const busy = err instanceof SyncBusyError;
      console.error("sheet sync cron failed", err);
      return NextResponse.json({ ok: false, error: busy ? "busy" : "error" }, { status: busy ? 409 : 500 });
    }
  });
}
```

- [ ] **Step 4: Retention.** In `data-retention/route.ts`, add two blocks in the file's existing shape (cutoff → `.delete().lt(...).select("id")` → count → errors → summary):
  - `sheet_sync_review_items` where `status in ('resolved','dismissed')` and `resolved_at < now − 90 days` → `summary.sheet_review_items_purged`. **Keep dismissed `suspect_snapshot` items**: they are acceptances the runner reads. Add `.neq("kind", "suspect_snapshot")`.
  - `sheet_mirror_staging` where `staged_at < now − 1 day` (orphans of crashed runs) → `summary.sheet_staging_purged`.
  Update the header comment's list of what the sweep purges.

- [ ] **Step 5: Run** `npm test && npm run typecheck` → PASS. **Commit** — `git commit -m "feat(sheet-sync): nightly cron at 00:00 Manila (three-place) + retention of old review items"`

---

# Phase D — admin page `/staff/admin/sheet-sync`

Read first: `src/app/(staff)/staff/(dashboard)/admin/settings/alerts/{page.tsx,actions.ts,client.tsx}` (page shell, action shape, `Switch` usage) and `src/app/(staff)/staff/(dashboard)/critical-alerts/page.tsx` (paged list with `count: "exact"`, `ListPagination`, `table-params`). Components come from `src/components/ui/*` and `src/components/staff/*`. Dates render only through `manilaDateTime` / `manilaDate` / `friendlyManilaDate`. The page is **admin only**; reads use the RLS server client (`createClient()`), and writes go through the actions below using the service-role store.

Page layout (one route, four views by `?view=`): **Overview** (default) · **Review queue** (`?view=review&kind=…&page=…&size=…`) · **Re-sort sources** (`?view=resort`) · **Run history** (`?view=history&page=…&size=…`). Render the view switch as a row of links styled like the existing filter chips (see `drmed-staff-ui` skill: "page headers + filter chips"). Each link carries only `view` (plus `kind` inside the review view).

### Task 14: Route, nav, server actions, Overview and Run history

**Files:**
- Modify: `src/lib/staff/route-names.ts` (`"/staff/admin/sheet-sync": "Sheet Sync"`), `src/components/staff/staff-nav-config.ts`, `src/components/staff/staff-nav-config.test.ts`
- Create: `src/app/(staff)/staff/(dashboard)/admin/sheet-sync/page.tsx`, `actions.ts`, `format.ts`, `format.test.ts`, `sync-controls.tsx`, `run-history.tsx`

- [ ] **Step 1: Nav.** Add the Admin Tools item right after `/staff/admin/patient-merge` (same divider group as Import Patients / Merge Duplicate Patients):

```ts
{ href: "/staff/admin/sheet-sync", label: ROUTE_NAME["/staff/admin/sheet-sync"],
  description: "Keep patients and patient-source numbers current from the reception Google Sheet.", roles: ["admin"] },
```

In `staff-nav-config.test.ts`, add `describe("Sheet Sync is admin-only")`, modelled on the existing "Hidden Tabs is admin-only" block: visible for admin, absent for reception / medtech / pathologist / xray_technician, and `/staff/admin/sheet-sync?view=review` lights exactly this item.

- [ ] **Step 2: `format.ts` + failing test** — plain words for codes shown on the page (CLAUDE.md "Plain language by audience"; an admin page, but still no raw enum codes):

```ts
import type { ReviewKind, TabKey } from "@/lib/sheet-sync/types";

export const TAB_LABEL: Record<TabKey, string> = { customers: "Customers", lab: "Lab services", consult: "Doctor consultations" };
export const KIND_LABEL: Record<ReviewKind, string> = {
  ambiguous_patient: "Which patient is this?",
  identity_conflict: "Details don't match the patient",
  possible_existing_patient: "Might already be a patient",
  unmapped_source: "Unknown \"how did you hear\" answer",
  unparseable_date: "Date the sync can't read",
  invalid_row: "Row the sync can't use",
  suspect_snapshot: "Sheet shrank suddenly",
};
export const TRIGGER_LABEL: Record<string, string> = {
  cron: "Nightly", manual: "Sync now", cli: "Command line", resort: "Re-sort approval", alias: "Answer mapped", revert: "Undo",
};
export const STATUS_LABEL: Record<string, string> = {
  running: "Running", succeeded: "Done", partial: "Partly done", failed: "Failed", skipped_paused: "Skipped (paused)",
};
export function durationLabel(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}
```

Test: every `ReviewKind` and every run status/trigger in the 0170 CHECK lists has a label. Read the lists from the migration text with a regex, the way `website-messages-schema.test.ts` pins its CHECK lists. Also test `durationLabel(65000) === "1 min 5 s"`.

- [ ] **Step 3: `actions.ts`** — all six actions. Shared shape: `requireAdminStaff()` → zod → store → `audit()` → `revalidatePath(PATH)`. Errors go through `translatePgError`, except `SyncBusyError` / `LeaseLostError`, which have their own messages.

```ts
"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { ipAndAgent, firstIssue } from "@/lib/server/action-helpers";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { REFERRAL_SOURCE_IDS } from "@/lib/patients/referral-sources";
import { sheetReaderFromEnv } from "@/lib/sheet-sync/config";
import { computeResortGroups } from "@/lib/sheet-sync/resort";
import { LeaseLostError, runSheetSync, SyncBusyError, withAdminLease, type RunOutcome } from "@/lib/sheet-sync/run";
import { createSupabaseStore } from "@/lib/sheet-sync/store";

const PATH = "/staff/admin/sheet-sync";
type ErrResult = { ok: false; error: string };
type ActionResult = { ok: true } | ErrResult;
type ActionDataResult<T> = { ok: true; data: T } | ErrResult;

function fail(e: unknown): ErrResult {
  if (e instanceof SyncBusyError) return { ok: false, error: "A sync is running right now. Try again in a few minutes." };
  if (e instanceof LeaseLostError) return { ok: false, error: "A newer sync took over. Check the run history." };
  const err = e as { code?: string; message?: string };
  if (err?.code) return { ok: false, error: translatePgError(err as never) };
  console.error("sheet sync action failed", e);
  return { ok: false, error: "Something went wrong. Please try again." };
}

const PauseSchema = z.object({ paused: z.boolean(), reason: z.string().trim().max(400).nullable() });
export async function setSheetSyncPausedAction(input: z.infer<typeof PauseSchema>): Promise<ActionResult> {
  const session = await requireAdminStaff();
  const parsed = PauseSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const admin = createAdminClient();
  const { data: before } = await admin.from("sheet_sync_settings").select("paused").eq("id", true).single();
  if (before?.paused === parsed.data.paused) return { ok: true };
  const now = new Date().toISOString();
  const { error } = await admin.from("sheet_sync_settings").update({
    paused: parsed.data.paused,
    paused_at: parsed.data.paused ? now : null,
    paused_by: parsed.data.paused ? session.user_id : null,
    pause_reason: parsed.data.paused ? parsed.data.reason || null : null,
    updated_at: now,
  }).eq("id", true);
  if (error) return fail(error);
  const { ip, ua } = await ipAndAgent();
  await audit({ actor_id: session.user_id, actor_type: "staff", action: parsed.data.paused ? "sheet_sync.paused" : "sheet_sync.resumed",
    resource_type: "sheet_sync_settings", resource_id: null, metadata: { reason: parsed.data.paused ? parsed.data.reason : null },
    ip_address: ip, user_agent: ua });
  revalidatePath(PATH);
  return { ok: true };
}

export async function runSheetSyncNowAction(input: { dryRun: boolean }): Promise<ActionDataResult<Pick<RunOutcome, "runId" | "status" | "durationMs" | "perTab" | "error">>> {
  const session = await requireAdminStaff();
  try {
    const outcome = await runSheetSync({ store: createSupabaseStore(createAdminClient()), readSheet: sheetReaderFromEnv(),
      trigger: "manual", actorId: session.user_id, dryRun: input.dryRun === true });
    revalidatePath(PATH);
    return { ok: true, data: { runId: outcome.runId, status: outcome.status, durationMs: outcome.durationMs, perTab: outcome.perTab, error: outcome.error } };
  } catch (e) {
    return fail(e);
  }
}

const ResolveSchema = z.object({ itemId: z.string().uuid(), action: z.enum(["link", "create", "dismiss"]), patientId: z.string().uuid().nullable() });
export async function resolveReviewItemAction(input: z.infer<typeof ResolveSchema>): Promise<ActionResult> {
  const session = await requireAdminStaff();
  const parsed = ResolveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  if (parsed.data.action === "link" && !parsed.data.patientId) return { ok: false, error: "Pick the patient first." };
  try {
    await createSupabaseStore(createAdminClient()).reviewResolve(parsed.data.itemId, session.user_id, parsed.data.action, parsed.data.patientId);
  } catch (e) { return fail(e); }
  const { ip, ua } = await ipAndAgent();
  await audit({ actor_id: session.user_id, actor_type: "staff", action: "sheet_sync.review_resolved",
    resource_type: "sheet_sync_review_item", resource_id: parsed.data.itemId,
    patient_id: parsed.data.action === "link" ? parsed.data.patientId : null,
    metadata: { action: parsed.data.action }, ip_address: ip, user_agent: ua });
  revalidatePath(PATH);
  return { ok: true };
}

const AliasSchema = z.object({ itemId: z.string().uuid(), sourceId: z.enum(REFERRAL_SOURCE_IDS) });
export async function mapAnswerToChannelAction(input: z.infer<typeof AliasSchema>): Promise<ActionDataResult<{ patientsUpdated: number }>> {
  const session = await requireAdminStaff();
  const parsed = AliasSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const admin = createAdminClient();
  const { data: item, error } = await admin.from("sheet_sync_review_items").select("item_key, kind, status").eq("id", parsed.data.itemId).single();
  if (error || !item || item.kind !== "unmapped_source" || item.status !== "open") return { ok: false, error: "Someone already handled this review item. Refresh the page." };
  try {
    const store = createSupabaseStore(admin);
    const { runId, result } = await withAdminLease(store, "alias", session.user_id,
      (lease) => store.aliasApply(lease, item.item_key, parsed.data.sourceId, session.user_id));
    const { ip, ua } = await ipAndAgent();
    await audit({ actor_id: session.user_id, actor_type: "staff", action: "sheet_sync.alias_set", resource_type: "sheet_sync_run",
      resource_id: runId, metadata: { review_item_id: parsed.data.itemId, referral_source_id: parsed.data.sourceId, patients_updated: result },
      ip_address: ip, user_agent: ua });
    revalidatePath(PATH);
    return { ok: true, data: { patientsUpdated: result } };
  } catch (e) { return fail(e); }
}

const ResortSchema = z.object({ answerNorm: z.string().max(200), from: z.string().nullable(), to: z.string().nullable() });
export async function approveResortGroupAction(input: z.infer<typeof ResortSchema>): Promise<ActionDataResult<{ updated: number }>> {
  const session = await requireAdminStaff();
  const parsed = ResortSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const store = createSupabaseStore(createAdminClient());
  try {
    // Recompute on the server — never trust patient ids from the browser.
    const [candidates, aliases] = await Promise.all([store.resortCandidates(), store.loadAliases()]);
    const group = computeResortGroups(candidates, aliases).groups
      .find((g) => g.answerNorm === parsed.data.answerNorm && g.from === parsed.data.from && g.to === parsed.data.to);
    if (!group) return { ok: false, error: "This group changed since the page loaded. Refresh the page." };
    const { runId, result } = await withAdminLease(store, "resort", session.user_id,
      (lease) => store.resortApply(lease, group.patientIds, group.from, group.to));
    const { ip, ua } = await ipAndAgent();
    await audit({ actor_id: session.user_id, actor_type: "staff", action: "sheet_sync.resort_applied", resource_type: "sheet_sync_run",
      resource_id: runId, metadata: { from: group.from, to: group.to, proposed: group.patientIds.length, updated: result },
      ip_address: ip, user_agent: ua });
    revalidatePath(PATH);
    return { ok: true, data: { updated: result } };
  } catch (e) { return fail(e); }
}

const RevertSchema = z.object({ runId: z.string().uuid() });
export async function revertRunAction(input: z.infer<typeof RevertSchema>): Promise<ActionDataResult<Record<string, number>>> {
  const session = await requireAdminStaff();
  const parsed = RevertSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const store = createSupabaseStore(createAdminClient());
  try {
    const { runId, result } = await withAdminLease(store, "revert", session.user_id, (lease) => store.revertRun(lease, parsed.data.runId));
    const { ip, ua } = await ipAndAgent();
    await audit({ actor_id: session.user_id, actor_type: "staff", action: "sheet_sync.reverted", resource_type: "sheet_sync_run",
      resource_id: parsed.data.runId, metadata: { undo_run_id: runId, ...result }, ip_address: ip, user_agent: ua });
    revalidatePath(PATH);
    return { ok: true, data: result };
  } catch (e) { return fail(e); }
}
```

`audit()`'s `AuditEntry` accepts `patient_id`; pass it only for the link action. That is the one place a decision names a patient, and `patient_id` is an id, not a name.

- [ ] **Step 4: `page.tsx`** — server component:

```tsx
export const metadata = { title: ROUTE_NAME["/staff/admin/sheet-sync"] };
export const dynamic = "force-dynamic";
export const maxDuration = 300; // "Sync now" runs inside this route's server action

export default async function SheetSyncPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireAdminStaff();
  const params = await searchParams;
  const view = (["overview", "review", "resort", "history"] as const).find((v) => v === params.view) ?? "overview";
  const supabase = await createClient();
  const [{ data: settings }, { data: lastRuns }, openCounts] = await Promise.all([
    supabase.from("sheet_sync_settings").select("*").eq("id", true).single(),
    supabase.from("sheet_sync_runs").select("id, trigger, dry_run, status, started_at, ended_at, per_tab, summary, error")
      .order("started_at", { ascending: false }).order("id", { ascending: true }).limit(1),
    countOpenByKind(supabase), // one head count per kind, count: "exact"
  ]);
  const envMissing = missingSheetEnv();
  // … PageHeader (subtitle: "Keeps patients current from the reception Google Sheet \"LAB SERVICES (RECEPTION)\" and keeps a
  //   copy of its lab and consultation lines for patient-source reports. Nothing here creates visits or payments."),
  // view links with the open-review total as a badge on "Review queue",
  // then {view === "overview" && <Overview …/>} etc.
}
```

**Overview** content:
1. **Status card.** "Paused" / "On — runs every night at 12:00 midnight" with a `<SyncSwitch>` (client, in `sync-controls.tsx`). Pausing asks for an optional reason in a small inline form, then confirms, the same confirm-before-pausing idea as `online-booking/client.tsx` but using `<Switch>`. It shows `paused_at` / `paused_by` / `pause_reason` when paused. If `envMissing.length`, show a red `Alert`: "Not configured on this server: LEGACY_SHEET_ID …", listing the names only.
2. **Sync now card** (`<SyncNow paused={…}>`, client): buttons **"Preview (dry run)"**, which is always enabled, and **"Sync now"**, which is disabled while paused with the hint "Turn the sync on first. A preview works while paused." A pending state reads "Reading the sheet… this can take a minute." The result panel shows, per tab: rows read, sheet last updated, and for Customers: to link, to create, to fill, facts; mirror rows; review counts by kind label. The same component renders the latest run's `per_tab` below when idle.
3. **Per-tab table** from the latest non-dry run: Tab · Sheet last updated (`friendlyManilaDate(last_date)`) · Rows read · Copied rows · Open issues (link to `?view=review&kind=…`) · Status. A failed tab shows its `error` text.
4. A footnote: "Lab and consultation lines are a reporting copy. They never become visits, payments or accounting entries here."

**Run history** (`run-history.tsx`, server component): paged (`count: "exact"`, `parsePage`/`parsePageSize`/`rangeFor`, order `started_at desc, id asc`, `ListPagination`). Columns: Started (`manilaDateTime`) · Type (`TRIGGER_LABEL`, plus a "Preview" badge when `dry_run`) · Status · Duration (`durationLabel(summary.duration_ms)`) · What changed (Customers created/filled/linked from `per_tab.customers.applied`; mirror rows per tab; or for resort/alias/revert the `summary.result` numbers) · Error · **Undo**. The client `<UndoRunButton>` shows only when `!dry_run && status in (succeeded, partial) && trigger !== "revert" && !reverted_by_run_id`. It opens a confirm `Dialog`: "Undo this run? Patients it created are removed if nothing uses them yet; details it filled in are put back unless someone changed that patient since. Changes to the reporting copy are not undone. The next sync rebuilds it." The result reads "Put back N · Kept M (changed since) · Removed K new patients · Kept J (in use)". Reverted runs show "Undone" with the undo run's time.

- [ ] **Step 5: Verify locally.** `npm run dev` on a free port (3005 per memory `drmed-sidebar-cleanup`), signed in as a local admin (the port-3005 + local GoTrue smoke-user recipe in that memory). Check with Playwright `browser_snapshot` (text, not screenshots): the nav item is visible; the Overview renders paused; "Sync now" is disabled; Preview runs and shows counts (needs the env from Task 12 Step 4 exported into the dev server's env); pausing and resuming works; the run history lists the preview.
- [ ] **Step 6: Gate + commit** — `npm test && npm run typecheck && npm run lint` → `git commit -m "feat(sheet-sync): admin page — status, pause, sync now, run history with undo"`

---

### Task 15: Review queue with resolvers

**Files:**
- Create: `src/app/(staff)/staff/(dashboard)/admin/sheet-sync/review-queue.tsx` (server list) + `review-actions.tsx` (client controls)

- [ ] **Step 1: List.** `?view=review` shows kind chips with open counts: "All", then each kind by `KIND_LABEL`. Below them is a paged list of `status = 'open'` items (`count: "exact"`, order `last_seen_at desc, id asc`, default 25/page, `ListPagination`), filtered by `kind` when set (validated against the kind list; unknown → "All"). A toggle link "Show handled" lists resolved and dismissed items read-only with who and when.
- [ ] **Step 2: Item cards by kind** (all text from `payload`):
  - `ambiguous_patient` / `identity_conflict` / `possible_existing_patient`: the reason, a table of the sheet rows (row #, name as typed, DOB, registered, phone ending ••1234), and the candidates (DRM-ID linking to `/staff/patients/<id>`, name, DOB), each with a radio button. Controls: **Link to selected patient**, **Create a new patient**, **Dismiss**. A note says "Applied on the next sync (nightly, or Sync now)."
  - `unmapped_source`: `"<answer>" — N rows` with a `Select` of every channel (`REFERRAL_SOURCE_LABEL`, in `REFERRAL_SOURCE_IDS` order) and **Map answer**, which calls `mapAnswerToChannelAction` and reports "N patients updated". Also **Dismiss**.
  - `unparseable_date` / `invalid_row`: tab, sheet row, column and the value as typed. The only action is **Dismiss**, with the hint "Fix it in the sheet — the next sync picks it up."
  - `suspect_snapshot`: "Customers had 4,901 rows last time and 4,410 now (−10%). The sync skipped this tab." Action: **Accept the new row count** (dismiss). Hint: "Only if rows were deleted on purpose; otherwise check the sheet for a filter or a sort in progress."
- [ ] **Step 3: Client controls** use `useTransition`, show the action's error inline, and call `router.refresh()` on success.
- [ ] **Step 4: Verify** with the local dev server and the local run from Task 12. Resolve one ambiguous item by linking, map one unknown answer, dismiss one date item. Each shows in `audit_log` (`select action, metadata from audit_log where action like 'sheet_sync.%' order by created_at desc limit 5` via psql against local) with ids and no names.
- [ ] **Step 5: Commit** — `git commit -m "feat(sheet-sync): admin review queue — link, create, map answer, dismiss"`

---

### Task 16: Re-sort panel

**Files:**
- Create: `src/app/(staff)/staff/(dashboard)/admin/sheet-sync/resort-panel.tsx` (server) + client approve button inside `review-actions.tsx`

- [ ] **Step 1:** `?view=resort` loads `store.resortCandidates()` + aliases through the **admin client**. `sheet_resort_candidates` is service-role only and the page has already passed `requireAdminStaff()`, which is the same trust boundary as the action. It computes `computeResortGroups`. Show an intro: "Patients imported from the sheet in May were sorted by an older, rougher list. These groups show what the new list would change. Nothing changes until you approve a group. Each approval can be undone from Run history." Then a table: Answer as typed (sample) · Now (`referralSourceLabel(from)`, or "Not recorded") · Proposed (label, or **"Not recorded"** for null) · Patients · **Approve**. Below it: "N patients were changed by staff since the import and are left alone."
- [ ] **Step 2:** The approve button calls `approveResortGroupAction({ answerNorm, from, to })` behind a confirm (`Dialog`) and reports "N patients updated".
- [ ] **Step 3: Verify** locally after seeding a few May-style patients. Local has none, so insert 3 rows via psql with `legacy_intake = '{"source":"google_sheet_CUSTOMER_LIST2","raw":{"How did you know about DR Med?":"Family / Friends"}}'` and `referral_source = 'customer_referral'`. Approve → origin `sheet`, value `family_friends`. Then **Undo** from Run history → back to `customer_referral` with origin `staff`.
- [ ] **Step 4: Commit** — `git commit -m "feat(sheet-sync): reviewed re-sort of May-imported patient sources"`

---

### Task 17: Repo guard and the duplicate-digest check

**Files:**
- Create: `src/lib/sheet-sync/mirror-readers.test.ts`
- Possibly modify: `src/lib/patients/find-duplicates.ts`

- [ ] **Step 1: Guard test:**

```ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../../..");
const ALLOWED = [
  "src/lib/sheet-sync/",
  "src/app/(staff)/staff/(dashboard)/admin/sheet-sync/",
  "src/types/database.ts",
];
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}

describe("sheet mirror tables stay out of money surfaces (spec §11)", () => {
  it("only the sync and its admin page read sheet_encounter_lines / sheet_customer_rows", () => {
    const offenders = walk(join(ROOT, "src"))
      .map((f) => relative(ROOT, f))
      .filter((f) => !ALLOWED.some((a) => f.startsWith(a)))
      .filter((f) => /sheet_(encounter_lines|customer_rows)/.test(readFileSync(join(ROOT, f), "utf8")));
    expect(offenders).toEqual([]);
  });
  it("guards itself: the scan finds the sync's own readers", () => {
    const hits = walk(join(ROOT, "src/lib/sheet-sync")).filter((f) => /sheet_customer_rows/.test(readFileSync(f, "utf8")));
    expect(hits.length).toBeGreaterThan(0);
  });
});
```

(PR 2 adds the Patient Sources report path to `ALLOWED`.) Also scan `supabase/migrations/*.sql` other than 0170 for the two table names. Views and functions are a read path too, and today none may exist.

- [ ] **Step 2: Duplicate digest.** Read `src/lib/patients/find-duplicates.ts` (`loadCandidatePairs`, used by the `dedup-digest` cron). Answer: will ~540 sheet-created patients flood the admin email? They match existing patients only if they look like duplicates. The §5.3 rules create a patient only when there is no full-name, loose-name, phone or DOB+name candidate, so the digest should grow little. Measure after the local run from Task 19: run `loadCandidatePairs` against local before and after the commit run and record the difference in the PR body. If it jumps by more than 20 pairs, stop and ask the owner. Do not silently exclude sheet-created patients from duplicate detection; finding real duplicates is its job.
- [ ] **Step 3: Commit** — `git commit -m "test(sheet-sync): repo guard keeping mirror tables out of money surfaces"`

---

# Phase E — docs, verification, review, ship

### Task 18: Docs

**Files:** `docs/drmed-user-guide.html`, `CLAUDE.md`, `.claude/skills/drmed-migrations/SKILL.md`, `.claude/skills/drmed-staff-ui/SKILL.md`, the spec.

- [ ] **User guide.** Add `<section class="sub" id="adm-sheet-sync">` under Admin Tools, numbered after the last Admin Tools section, with a TOC `<li>` beside Email Alerts' entry. Contents: the `where` line (`Admin › Admin Tools › Sheet Sync · /staff/admin/sheet-sync · Admin only`), then an intro covering what it does, that it ships paused, and that nothing becomes a visit or payment. Then:
  - a `dl.defs` for the four views and every review-item kind (use the `KIND_LABEL` wording exactly);
  - `ol.steps` for turning it on (preview first, check the numbers, switch on), handling each review kind, mapping an answer, approving a re-sort group, and undoing a run;
  - the D9 note that the website forms' "How did you hear about us?" list gained the new channels;
  - a glossary `dt` for "Sheet Sync".
  Bump the TOC tag and footer to the next version (v2.15), date 24 September 2026 or the merge date, "at migration 0170". **Every label must match the code**; the guide claims it was checked, so check it.
- [ ] **CLAUDE.md.** Update the migration-ledger paragraph (0170 in flight → applied at merge), and change the P-code line to "in use: P0001–P0034, P0040–P0064; next free P0065". Add a "Where things live" row: `Sheet Sync (reception Google Sheet → patients + reporting mirror): parsers, identity rules, lease-fenced runner, CLI — src/lib/sheet-sync/, scripts/sheet-sync.ts; admin page /staff/admin/sheet-sync; mirror tables readable only there (mirror-readers.test.ts)`.
- [ ] **drmed-migrations skill.** Add a 0170 line to the migration list in the file's style and the P0062–P0064 meanings; next free P0065. Add a note on the `app.referral_origin` pattern: patients' channel ownership is set only inside security-definer functions.
- [ ] **drmed-staff-ui skill.** Add the Admin Tools nav item.
- [ ] **Spec.** Append a "§14 Planning refinements (2026-09-24)" table listing D1–D11 with one line each.
- [ ] Commit — `git commit -m "docs(sheet-sync): user guide section, CLAUDE.md, skills, spec refinements"`

### Task 19: End-to-end verification on the local stack

- [ ] **Step 1:** `npm test && npm run typecheck && npm run lint && npm run build` → all green (`build` catches server/client boundary mistakes vitest cannot).
- [ ] **Step 2: Real sheet → local DB.** With the Task 12 env exported, run in order, capturing output to the scratchpad and reading only numbers:
  1. `npm run sheet:sync` (dry run) → counts per tab.
  2. Unpause locally (`update sheet_sync_settings set paused=false` via psql, or the page).
  3. `npm run sheet:sync -- --commit --confirm=local` → record `duration_ms`. It **must be < 240 s**; otherwise stop and profile before continuing.
  4. Run the commit again → the second run's `applied` shows ~0 creates, ~0 fills and only `facts`/`link` noise near 0; `mirror_rows` unchanged. This proves the nightly delta is small and that a rerun is idempotent.
  5. `npm run sheet-sync:db-proof` → all PASS.
  The local DB has no May patients, so creates ≈ all customers. The ±5% volume gate against the reviewer's replay (spec §5.3) is checked on **prod** in Task 21.
- [ ] **Step 3: Cron route locally.** `curl -s -H "Authorization: Bearer $CRON_SECRET" http://localhost:3005/api/cron/sheet-sync` (with `dangerouslyDisableSandbox`) → while paused: `status: "skipped_paused"` and an `audit_log` row `sheet_sync.skipped` with `actor_type = 'system'`.
- [ ] **Step 4: Browser pass** (Playwright MCP, text-first): every view renders; review actions work; undo works; no console errors (`browser_console_messages`). One screenshot at most, of the Overview after a real run.
- [ ] **Step 5:** Fix anything found (commit each fix separately).

### Task 20: Reviews — Fable, then Codex (astra high)

- [ ] **Step 1: Fable review.** Dispatch an `Agent` with `model: "fable"`, subagent_type `superpowers:code-reviewer`. Prompt: the spec path, this plan path, `git diff origin/main...HEAD`, and the focus list. Security: RLS/ACL on 10 tables + 14 functions, `app.referral_origin` reachability, seed parity. Data safety: can the sync overwrite a staff value, create a duplicate patient, or leave a half-written mirror? Lease/fencing races. Revert correctness. Money isolation: does anything outside the allow-list read mirror tables? Manila dates. Audit metadata free of names. Ask for findings with severity + file:line + failure scenario.
- [ ] **Step 2: Codex review.** `export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"`, then invoke the `codex-review` skill (astra, high) on the branch diff. **Do not pipe it**. Open the report, confirm a `Status: Completed` line and real content, and treat exit 0 as "ran", not "clean" (CLAUDE.md).
- [ ] **Step 3:** Triage both with `superpowers:receiving-code-review`. Fix every real finding, following the existing pattern (user rule 4). Re-run Tasks 19.1 and 19.2(4–5). Record a "PR 1 review log" table in the spec (finding → resolution), like §12.

### Task 21: Prod dry run, push, PR, apply, merge

Order matters: the migration must be on prod **before** the app merges (CLAUDE.md), and the sync ships paused.

- [ ] **Step 1: Number re-check** (Task 8 Step 0 again, on the day). Rebase on `origin/main`; re-run the full gate.
- [ ] **Step 2: Confirm with the user before any outward step.** Summarise in plain words: push the branch (public repo; the diff holds no personal data — verify with `git diff origin/main...HEAD | grep -iE "<the invented names only>"` and a scan of the fixtures), open the PR, apply 0170 to prod, set `LEGACY_SHEET_ID` on Vercel production, merge. Ask once, then proceed.
- [ ] **Step 3: Push + PR.** `git push -u origin feat/sheet-sync`; `gh pr create`. The body covers: what it does, "ships PAUSED", the D1–D11 table, the D9 public-form wording change (owner-visible), the duplicate-digest measurement from Task 17, verification evidence (test counts, local timings, db-proof PASS, review outcomes), and the post-merge checklist. End with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Mark it ready at once (memory: ready-for-review cancel trap; no CI here, but keep the habit).
- [ ] **Step 4: Apply 0170 to prod** (owner authorised Claude-run pushes, memory `feedback-drmed-apply-migrations-yourself`). From this worktree, on current main, with `supabase/.temp/{project-ref,linked-project.json,pooler-url}` copied in: `supabase db push --dry-run` must list **only** 0170. Then `supabase db push`. **Verify by object, not the summary line** (memory `supabase-db-push-remote-only-migration`): ledger has 0170; the ten tables exist with RLS; `sheet_sync_settings.paused = true`; 18 referral sources; `select count(*) from patients where referral_source is not null and referral_source_origin is distinct from 'staff'` = 0; `has_function_privilege('authenticated','public.sheet_sync_acquire(text,uuid,boolean)','execute')` = false.
- [ ] **Step 5: Vercel env.** Set `LEGACY_SHEET_ID` for Production (`vercel env add LEGACY_SHEET_ID production`) and confirm `GOOGLE_SERVICE_ACCOUNT_JSON` is already set there (the accounting export uses it).
- [ ] **Step 6: Merge** with the repo's merge path, then confirm the Vercel production deploy is READY (merge ≠ deploy). Run `npm run db:types:remote` if possible; otherwise note that local types match 0170.
- [ ] **Step 7: Prod dry run — owner evidence (spec §11).** `npm run sheet:sync -- --prod` (a dry run; it reads prod patient data, which the guard announces). Compare `per_tab.customers.planned` against the spec's replay: ~4,187 link (86%), ~540 create, ~44 ambiguous, ~93 loose-only review, 2 conflicts. **Outside ±5% ⇒ stop and investigate before anyone unpauses.** Put the numbers, in plain words, in the handoff to the owner. The owner, not Claude, decides when to unpause. After they do, the catch-up runs via `npm run sheet:sync -- --prod --commit --confirm=qhptbmafrosgibooelpp`; record its duration on the admin page (run history).
- [ ] **Step 8: Wrap-up** per CLAUDE.md: plain-English summary, next step (PR 2 Patient Sources), context-hygiene check. Update memory `drmed-sheet-sync` (state: PR 1 merged, 0170 on prod, paused; the D-decisions worth keeping) and the index line in `MEMORY.md`.

---

## Self-review (done while writing)

- **Spec coverage** (§4–§5, §11): channels + mapper + aliases (T3, T8) · origin/row_version trigger (T8, D2) · re-sort panel (T7, T16) · settings/runs/lease/fencing (T8, T11) · review items incl. auto-clear + dismiss (T8, T15) · before-images + revert (T8, T14) · links, facts (T5, T8) · customer + encounter mirrors with staged swap (T8, T11) · per-cell dates (T2) · clinical mirror identities (T6) · §5.3 identity rules + corroboration + expected-volume gate (T5, T21) · pause/skipped heartbeat, partial ⇒ monitor error, cron three-place, CLI catch-up timing (T11–T13, T19) · admin page with every listed control (T14–T16) · user guide (T18) · security matrix (T9) · repo guard (T17) · retention (T13). PRs 2–5 are excluded by design.
- **Placeholders:** Task 5's test header array is to be shared via `__fixtures__/tab-headers.ts` (explicit instruction, not a TBD). Task 13's `activeFrom` is a concrete date with a re-check step.
- **Type consistency:** `CustomerOp`/`FillFields`/`LinkRecord` (T5) are used unchanged by the store (T11) and match the SQL op keys (T8). `withAdminLease` (T11) is used by the actions (T14). `ReviewKind` matches the 0170 CHECK and `KIND_LABEL`.
