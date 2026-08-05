# EOD cash denomination count (PR N) — design

**Date:** 2026-08-05
**Branch:** `pf-followup-pr-n` (worktree `.worktrees/pf-followup-pr-n`, off `main` at `5b7af3f`)
**Series:** PF follow-up PRs J–N. J/K/L closed, M open (#138). PR N is independent of M and must not depend on anything unmerged.

## Problem

The EOD close (`/staff/payments/eod`) records a single hand-typed
`counted_cash_php`. There is no record of *how* the till was counted, so a
short/over can't be traced to a pile (e.g. "we're one ₱1000 short" vs "the
coins were miscounted"), and the physical count sheet the clinic keeps on
paper has no in-app counterpart.

## Decisions (client/user-locked)

1. **Denomination rows:** bills ₱1000/₱500/₱200/₱100/₱50/₱20 and coins
   ₱20/₱10/₱5/₱1/₱0.25 — **11 rows**, with the ₱20 bill and ₱20 coin as
   separate rows (separate physical piles). 5- and 1-sentimo omitted (out of
   practical circulation).
2. **Grid is the source of truth:** "Cash you actually counted" becomes a
   computed, read-only figure derived from the grid. No free-typed total on
   new closes. A DB guard enforces breakdown-sum = `counted_cash_php`.
3. **Visibility — all three surfaces:** closed-day panel on the EOD page,
   admin operations cash report (panel + CSV), and a printable A5 count
   sheet.

## Storage — migration `0132_eod_denomination_count.sql`

Schema facts confirmed against `0043_eod_cash_reconciliation.sql`: the
declaration table is `eod_close_records`; no later migration touches it;
next free migration number is 0132; next free custom error code is P0048.

### Column

```sql
alter table public.eod_close_records
  add column counted_denominations jsonb
  check (counted_denominations is null
         or jsonb_typeof(counted_denominations) = 'object');
```

Object keyed by denomination slug, values are piece counts:

```json
{"bill_1000":3,"bill_500":2,"bill_100":7,"coin_20":4,"coin_1":10,"coin_0.25":8}
```

The `bill_`/`coin_` prefix is what lets the two ₱20 piles coexist. Zero-count
keys may be omitted or present as `0` — both valid.

**Nullable, no backfill.** Every existing prod close predates the feature;
inventing counts would fabricate audit data. NULL renders as "not recorded".
NULL is legal **for historical rows only** — the app always writes a
breakdown on new closes, and the guard below never blocks a NULL.

### Helper

```sql
create or replace function public.cash_denomination_total_php(p jsonb)
returns numeric(14,2) language sql immutable
```

Sums `count × value` over the slugs. SQL `numeric` is exact, so no centavo
trick is needed here (unlike the TS side). This function and the TS module
are the **two copies of the canonical denomination table** — each carries a
comment pointing at the other, and the local-stack test asserts parity
(see Testing).

### Guard — P0048 (`BEFORE INSERT OR UPDATE` trigger)

Matches 0043 house style (P0015/P0017/P0018/P0019 are all trigger raises,
which gives `translatePgError` a readable message). Raises `P0048` when
`counted_denominations` is **not null** and any of:

- a key is not in the 11-slug whitelist;
- a value is not a non-negative integer;
- `cash_denomination_total_php(counted_denominations) <> counted_cash_php`.

**Must skip NULL explicitly** (review adjustment 1): the admin reopen action
UPDATEs legacy rows whose breakdown is NULL; without the skip, reopening any
pre-PR-N close would raise.

### Replace `cash_drawer_state(date, uuid)` — load-bearing

The `closed` CTE in `cash_drawer_state` selects an **explicit column list**;
without re-creating the function the EOD page would never see the breakdown.
Re-create with `counted_denominations` added to that list. `create or
replace` keeps the existing `authenticated` grant. No other change to the
function body.

### After the migration

`npm run db:types` regenerated; `translatePgError` gains:

```
case "P0048": return err.message ?? "The denomination counts don't add up to the counted total. Re-check the count sheet.";
```

## Shared pure module — `src/lib/accounting/cash-denominations.ts`

Pure, no `server-only`, vitest-covered (same shape as PR L's
`status-filter.ts`). Exports:

- `CASH_DENOMINATIONS` — ordered table `{ key, value_php, form: "bill" | "coin", label }`, bills descending then coins descending. **Mirror of the SQL table** — comment cross-references the migration.
- `DenominationCounts` type — `Partial<Record<DenominationKey, number>>`.
- `denominationsTotal(counts)` — **computes in centavos** (integer arithmetic, divide by 100 once) so ₱0.25 × n can't drift in floating point.
- `mergeDenominations(a, b)` — key-wise sum, for multi-shift days in the ops report.
- `parseDenominations(unknown)` — validates shape coming back from jsonb (unknown keys / non-integers / negatives → null), used by every read surface.
- `formatDenominationSummary(counts)` — compact "₱1000 ×3 · ₱500 ×2 · …" string for sub-rows, skipping zero counts.

## Server action — `closeEodAction` + `CloseEodSchema`

- `CloseEodSchema`: **`counted_cash_php` is removed entirely** (review
  adjustment 2) and replaced by `counted_denominations` — a record of the 11
  slugs to non-negative integers, each ≤ 100,000 pieces (keeps the derived
  total within the old 10M-peso cap's intent). An ignored
  field is a trap for the next reader; the schema describes what's consumed.
- The action **derives `counted_cash_php` server-side** via
  `denominationsTotal` and inserts both the derived total and the breakdown.
  The client-side total is display-only. The DB guard then re-checks the tie,
  making it enforceable against any future writer.
- Variance is still recomputed server-side from `cash_drawer_state` exactly
  as today; the variance-reason requirement is unchanged.
- Audit metadata (`eod_close.created`) gains `counted_denominations`.
- `eod-client.tsx` is the only caller; no other call sites to migrate
  (verified by grep — `CloseEodSchema` is referenced only in
  `cash-drawer/actions.ts` and `validations/accounting.ts`).

## UI — `eod-client.tsx`

Open-day form:

- The free-text counted input is **replaced** by a two-column grid: Bills
  (₱1000 → ₱20) left, Coins (₱20 → ₱0.25) right; each row is a count input
  (`inputMode="numeric"`, integers only) with a line subtotal shown once
  non-zero.
- "Cash you actually counted" and "Difference (over / short)" become
  computed read-only figures (client-side via `denominationsTotal` — same
  module the server uses, so they can't disagree).
- "Close day" stays disabled while **every** input is blank (the analogue of
  today's `!counted` guard). An all-zeros count is allowed once something is
  entered — it lands as a large variance, which already forces a reason.
- Plain-language convention (CLAUDE.md): reception-facing labels stay
  jargon-free — "Bills", "Coins", "Cash you actually counted", "Difference".

Closed-day panel (green card):

- Gains the breakdown table (11 rows, zero rows collapsed into the summary
  line) under the existing expected/counted/difference `dl`; NULL →
  "Denomination count not recorded" (historical closes).
- Gains a "Print count sheet" link to the new route.

## Admin operations cash report

- `EodCloseRow` (in `src/lib/operations/cash-report.ts`) gains
  `counted_denominations`; the page's `.select(...)` adds the column.
- `buildCashReconRows` merges multi-shift breakdowns per day via
  `mergeDenominations`; `CashReconRow` gains the merged counts (null when no
  close that day recorded one).
- `CashReconPanel` renders a compact sub-row per reconciled day using
  `formatDenominationSummary` (expandable is not needed — the summary string
  is one line).
- **CSV** (`/api/admin/operations/cash.csv`): the route currently fetches no
  EOD data — it gains the `eod_close_records` fetch and a new "Cash
  reconciliation" section: Expected / Counted / Variance rows (pesos) and
  one row per denomination in **pieces**, with the row label saying so
  (e.g. "₱1000 bills (pieces)") since the rest of the sheet is pesos.

## Printable count sheet

- Route: `src/app/(staff)/staff/(dashboard)/payments/eod/[closeId]/count-sheet/page.tsx`.
- **Gate: reception/admin** — same check as the EOD page
  (`requireActiveStaff()` + role redirect), *not* the bare any-staff gate the
  consent-print page uses (review adjustment 3): cash-count data matches the
  EOD page's own audience.
- Layout reuses the **main-branch** receipt/consent print pattern (logo
  strip, named `@page` in `globals.css`) — deliberately *not* PR M's slip
  modules, since #138 is unmerged and PR N must stand alone. New
  `@page cash-count { size: A5; margin: 10mm }` + `.cash-count-print` scoping
  class, following the `@page receipt` comment block's approach.
- Content: clinic header, business date + shift, the 11-row denomination
  table with per-row subtotals, counted total, expected, variance (+ reason),
  closed-by name and time, then "Counted by" and "Witness" signature lines.
  Renders for any close row (including reopened ones, watermarked
  "REOPENED"), NULL breakdown → totals only with "not recorded" note.
- Server-side **audit row on view** (`eod_close.count_sheet_viewed`),
  matching how other cash/print surfaces audit access.
- Print button reuses the plain `window.print()` client-button pattern.

## Error handling

- P0048 → `translatePgError` message above; surfaced through the existing
  `setErr` path in `eod-client.tsx`.
- `parseDenominations` returning null on malformed stored jsonb degrades
  every read surface to "not recorded" rather than crashing — defensive only;
  the guard makes malformed rows unreachable through normal writes.

## Testing

- **Vitest** — `cash-denominations.test.ts`: centavo arithmetic (₱0.25
  cases), zero/omitted keys, unknown-key and negative rejection in
  `parseDenominations`, `mergeDenominations`, summary formatting;
  `cash-report.test.ts` extended for merged breakdown rows.
- **Local Supabase stack** — migration applies clean on `db reset`; P0048
  raises on: unknown key, negative, non-integer, sum mismatch; NULL
  breakdown insert + **reopen of a NULL-breakdown row** both succeed
  (the review-adjustment-1 regression); `cash_drawer_state` returns the
  breakdown in `closed`. **SQL/TS parity test:** for every
  `CASH_DENOMINATIONS` key, an insert with that key alone passes the guard
  and `cash_denomination_total_php` equals `denominationsTotal` — catches
  the two tables drifting.
- **Playwright** — close a day via the grid, verify computed total/variance,
  reason-required path, closed panel breakdown, count-sheet page renders.
- `npm run typecheck`, `lint`, `build`, full `npm test`.

## Out of scope (surface to client later)

- Multi-shift denomination entry UX beyond what exists (v1 has one active
  shift).
- Expected-vs-counted per denomination (would require tracking which
  denominations were *received*, which payments don't record).
- Sentimo 0.05/0.01 rows.
