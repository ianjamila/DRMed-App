# Patient Sources 5b — weekly + monthly owner email — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Email the owner(s) a Monday-morning weekly and a 1st-of-the-month monthly Patient Sources digest (new patients by channel, served, returning, revenue, top referrers, cost per new patient, each against the period before), sent at most once per recipient per period, with an Email Alerts "Send me a preview" button and an `npm run email:preview` script.

**Architecture:** Pure helpers + a pure renderer in `src/lib/marketing/` (`patient-sources.ts`, new `patient-sources-digest.ts`); a server-only data module that reads the report through the existing `loadPatientSourcesReport` loader (two calls, one per period) and pages `ad_spend_daily` directly (never the admin-only RPCs); a cron module that claims one send per recipient through a tiny closed SQL function `_ps_digest_claim` backed by a service-role-only claim table; two thin cron routes; one migration (2 alert keys + claim table + claim fn + `service_role` SELECT on `ad_spend_daily`).

**Tech Stack:** Next.js 16 (App Router route handlers, Server Actions), TypeScript, Supabase JS (service-role client), Postgres/plpgsql, Vitest, `pg` + `tsx` for the concurrency proof.

**Spec:** `docs/superpowers/specs/2026-10-01-patient-sources-phase5-design.md` §0, §1, §2 (`channelDeltas`, `biggestMover`, `sundayObservation`), §4, §6. 5a's helpers (`asOfLabel`, `Period`, `lastCompletedWeek`, `previousWeek`, `lastCompletedMonth`, `previousMonth`, `trendWeeks`, `trendCardData`, `todayRows`, `isoWeekday`, `reportCsvResponse` `asOf`) already exist on this branch.

**Branch/worktree:** `.worktrees/ps-email`, branch `feat/patient-sources-5b-email`, built ON TOP of `feat/patient-sources-5a` (PR #292). If #292 has merged before this starts, `git fetch && git merge origin/main` first; if not, keep this branch stacked and open its PR against `feat/patient-sources-5a` (merge 5a first — the STACKED-PR trap in `drmed-list-polish-batch` memory).

**Execution notes (from past sessions):**
- Sonnet implementers stalled editing big page files — the **controller does page/client edits directly** (Task 11, and the page tweak in Task 13). Sonnet sub-agents are fine for the pure-helper, SQL, route and test tasks.
- Never run `git stash` bare (shared stash stack). Bash is zsh: never name a variable `path`; no `python3` heredocs; `curl` to localhost needs the sandbox disabled.
- Database work runs ONLY on the isolated stack from Task 0 (API **56421**, DB **56422**, `project_id = drmed-ps5b`) — never the shared 54322 stack, never `ps5c-stack` (56321/56322), never prod until Task 15.
- Commit after each task with a Conventional Commit message ending in `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. The post-commit hook may print `Killed: 9 python3 -c "import graphify"` — harmless.

**Design decisions this plan makes where the spec leaves a gap** (each is also called out where it bites):
1. `sendEmail`'s `definite` field is **optional** (`definite?: boolean`, missing = "not definite"), because ~6 existing tests mock `{ ok: false, kind: "error", error }` and a required field would break their typecheck.
2. The claim function returns the new `attempts` number (`integer`, NULL = not claimed) and takes a 5th argument `p_include_unknown boolean default false` — the spec's four-argument form has no way to express the operator's `include_unknown=1` retry. The Resend idempotency key carries the attempt number (`{key}:{from}:{recipient}:{attempts}`) so a rebuilt payload on a legitimate retry never collides with an earlier key (Resend answers a reused key with a different body by 409).
3. A claim that returns NULL is classified by reading the row back (`sent` → already sent; `unknown` → counted and fails the monitor so an operator looks; `sending` → in flight). The spec's single `already_sent` number cannot tell these apart, and silently skipping an `unknown` row would hide the very condition the design exists to surface.
4. A build/report/spend failure returns 500 and does **not** write `.completed` (a failed run is not a heartbeat); every non-failing path, including partial `failed`/`unknown` sends, does. `include_unknown=1` is only accepted together with `period_from`.
5. "No older than 62 days" is measured from the period **start**.
6. The digest cron logic lives in one module (`patient-sources-digest-cron.server.ts`) with injected deps so it is unit-testable; the two routes are ~10 lines each. `renderPatientSourcesDigest(data, { appUrl })` has no separate `period` argument — `data.kind` carries it.
7. The "Send me a preview" Server Action lives in a new `preview-actions.ts` beside `actions.ts` (keeps the 400-line actions file untouched and the action testable).
8. The page's "Latest service date in the sheet" wording is extracted into `sheetDatesText()` so the email and the page cannot drift.

---

## File map

| File | Change | Responsibility |
|---|---|---|
| `src/lib/marketing/patient-sources.ts` | modify | export `totalsByChannel`; + `channelDeltas`, `biggestMover`, `sundayObservation`, `sheetDatesText` |
| `src/lib/marketing/patient-sources.test.ts` | modify | tests for the above |
| `src/lib/notifications/email.ts` | modify | `idempotencyKey` input, `definite` on error results, export `SendEmailInput` |
| `src/lib/notifications/email.test.ts` | create | send/definite/idempotency tests |
| `supabase/migrations/<N>_patient_sources_digest.sql` | create | 2 alert keys + seeds, `patient_sources_digest_sends`, `_ps_digest_claim`, `service_role` SELECT on `ad_spend_daily`, post-check |
| `supabase/seed.sql` | modify | re-revoke the claim table from anon/authenticated |
| `supabase/tests/0151_rls_initplan_smoke.sql` | modify | allow-list the claim table (service-role-only by design) |
| `supabase/tests/<N>_patient_sources_digest_smoke.sql` | create | sequential claim-state + ACL smoke |
| `scripts/ps-digest-claim-concurrency-proof.ts` | create | two-session race proof for `_ps_digest_claim`, `--control` mutants |
| `src/lib/db/concurrency-proof-guard.test.ts` | modify | REGISTRY entry + proof count 23 → 24 |
| `package.json` | modify | `ps-digest-claim:concurrency-proof`, `email:preview` scripts |
| `src/types/database.ts` | regenerate | claim table + `_ps_digest_claim` |
| `src/lib/notifications/staff-alerts.ts` + `.test.ts` | modify | 2 keys + registry entries |
| `src/lib/ops/cron-heartbeats.ts`, `vercel.json`, `.github/workflows/cron-watchdog.yml` | modify | the two crons (+ stale schedule-count comment) |
| `src/lib/ops/cron-schedule.ts` + `.test.ts` | modify | monthly shape |
| `src/lib/marketing/patient-sources-digest.ts` | create | types, periods, retry validation, spend aggregation, **pure renderer** |
| `src/lib/marketing/patient-sources-digest.test.ts` | create | periods, aggregation, render tests |
| `src/lib/marketing/patient-sources-digest.server.ts` | create | `loadPatientSourcesDigest`, `readSpend`, `buildPatientSourcesDigestEmail` |
| `src/lib/marketing/patient-sources-digest.server.test.ts` | create | loader, spend paging/equivalence, never-call-RPC guard |
| `src/lib/marketing/patient-sources-surfaces.test.ts` | modify | digest module listed as a surface |
| `src/lib/marketing/patient-sources-digest-cron.server.ts` | create | store adapter + `runPatientSourcesDigest` + `runDigestCron` |
| `src/lib/marketing/patient-sources-digest-cron.server.test.ts` | create | claim/send/record/retry/audit tests |
| `src/lib/notifications/alert-last-sent.ts` + `.test.ts` | modify | `alertLastSentLine` |
| `src/app/api/cron/patient-sources-weekly/route.ts` + `route.test.ts` | create | weekly cron |
| `src/app/api/cron/patient-sources-monthly/route.ts` | create | monthly cron |
| `src/app/(staff)/staff/(dashboard)/admin/settings/alerts/preview-actions.ts` + `preview-actions.test.ts` | create | `sendPatientSourcesPreviewAction` |
| `src/app/(staff)/staff/(dashboard)/admin/settings/alerts/client.tsx` | modify (**controller**) | "Send me a preview" button + shared Last-sent line |
| `src/app/(staff)/staff/(dashboard)/marketing/patients/page.tsx` | modify (**controller**) | use `sheetDatesText` |
| `scripts/lib/email-preview-args.ts` + `.test.ts` | create | CLI arg parsing |
| `scripts/email-preview.mts` | create | `npm run email:preview` |
| `CLAUDE.md`, `docs/drmed-user-guide.html` | modify | ledger, admin notes, 5.2 Email Alerts, Patient Sources paragraph (version bump at merge only) |

---

### Task 0: Setup, number claim, isolated stack (controller runs this)

**Files:** none committed.

- [ ] **Step 1: Confirm the base and install dependencies**

Run:
```bash
cd /Users/jamila/Claude/DRMed/.worktrees/ps-email
git status --short | head -3; git branch --show-current
git merge-base --is-ancestor 33efc8f4 HEAD && echo "has #287 guard" || echo "MISSING #287 guard"
SCRATCH=/private/tmp/claude-501/-Users-jamila/3b674312-e5b3-4261-ba5b-259737df9a52/scratchpad   # use YOUR session scratchpad
npm ci > $SCRATCH/npm-ci-5b.log 2>&1; echo exit=$?
```
Expected: clean tree, `feat/patient-sources-5b-email`, `has #287 guard`, `exit=0`. If `MISSING`: `git fetch origin && git merge origin/main`, resolve, re-run.

- [ ] **Step 2: Claim the migration number**

Run: `git fetch -q origin && npm run claim -- migration`
Expected: prints the claimed number (at the time of writing the next free one is **0209**; prod head is 0208). Write it down as `<N>` — every `<N>` below (`supabase/migrations/<N>_patient_sources_digest.sql`, `supabase/tests/<N>_patient_sources_digest_smoke.sql`, comments) is that number. Never renumber into one you did not claim.

- [ ] **Step 3: Start an isolated stack from a copy of `supabase/`**

```bash
SP=$SCRATCH/ps5b-stack
rm -rf $SP && mkdir -p $SP && rsync -a --exclude .temp --exclude .branches supabase/ $SP/supabase/
mkdir -p $SP/supabase/.temp && echo 17.6.1.167 > $SP/supabase/.temp/postgres-version
node -e '
const fs=require("fs");const f=process.argv[1];let s=fs.readFileSync(f,"utf8");
s=s.replace(/^project_id = ".*"$/m,"project_id = \"drmed-ps5b\"");
s=s.replace(/^(port|shadow_port) = 54(\d{3})$/gm,(m,k,n)=>`${k} = 56${"4"+n.slice(1)}`);
fs.writeFileSync(f,s);' $SP/supabase/config.toml
grep -n -E "^project_id|^(port|shadow_port) = " $SP/supabase/config.toml
npx supabase --version
npx supabase start --workdir $SP > $SP/start.log 2>&1; echo exit=$?
```
Expected: every port line reads `564xx` (API `56421`, DB `56422`, shadow `56420`); `--version` prints `2.118.x`; `exit=0`. The pinned `17.6.1.167` image is deliberate: images `.106`/`.111` segfault on any refused function call (memory `supabase-postgres-denied-function-segfault`) and the proofs below make refused calls. Do not stop or touch any other `supabase_*_DRMed*` container.

- [ ] **Step 3b: Shell variables for every later DB step**

```bash
export PSQL=/opt/homebrew/opt/libpq/bin/psql
export DB=postgresql://postgres:postgres@127.0.0.1:56422/postgres
export SP=$SCRATCH/ps5b-stack
$PSQL $DB -At -c "select max(version) from supabase_migrations.schema_migrations; select version();"
```
Expected: `0208` (or the current main head) and `PostgreSQL 17.6`.

- [ ] **Step 4: Baseline gate is green before any change**

Run: `npx vitest run src/lib/marketing src/lib/notifications src/lib/ops src/lib/db scripts/lib 2>&1 | tail -6`
Expected: all pass (record the file/test counts). Any pre-existing failure is fixed or reported before Task 1.

---

### Task 1: Pure helpers — `channelDeltas`, `biggestMover`, `sundayObservation`, `sheetDatesText`

**Files:** Modify `src/lib/marketing/patient-sources.ts`; Test `src/lib/marketing/patient-sources.test.ts`.

- [ ] **Step 1: Write the failing tests** (append; extend the test file's imports from `./patient-sources` with `channelDeltas, biggestMover, sundayObservation, sheetDatesText, channelLabel, type ChannelDelta, type SeriesRow`, and import `manilaDate` from `@/lib/dates/manila` if not already imported)

```ts
const srow = (bucket_start: string, channel: string, confirmed: number, unconfirmed = 0): SeriesRow => ({
  bucket_start, channel, confirmed, unconfirmed,
});

describe("channelDeltas", () => {
  it("adds confirmed + unconfirmed and keeps a channel that fell to zero", () => {
    const cur = [srow("2026-10-01", "walk_in", 5, 1), srow("2026-10-02", "walk_in", 2)];
    const prev = [srow("2026-09-24", "walk_in", 3), srow("2026-09-24", "online_google", 4)];
    expect(
      channelDeltas(cur, prev).map(({ channel, now, before, change, pct }) => ({ channel, now, before, change, pct })),
    ).toEqual([
      { channel: "walk_in", now: 8, before: 3, change: 5, pct: 5 / 3 },
      { channel: "online_google", now: 0, before: 4, change: -4, pct: -1 },
    ]);
  });

  it("has a null pct when there was nothing before, and a channel new this period is included", () => {
    const [d] = channelDeltas([srow("2026-10-01", "walk_in", 3)], []);
    expect(d).toMatchObject({ channel: "walk_in", now: 3, before: 0, change: 3, pct: null });
  });

  it("returns nothing when there is no comparison period", () => {
    expect(channelDeltas([srow("2026-10-01", "walk_in", 3)], null)).toEqual([]);
  });

  it("orders like the channel table: this period's total, then label", () => {
    const cur = [srow("2026-10-01", "online_google", 2), srow("2026-10-01", "walk_in", 2)];
    const out = channelDeltas(cur, []).map((d) => d.label);
    expect(out).toEqual([...out].sort((a, b) => a.localeCompare(b)));
  });
});

describe("biggestMover", () => {
  const d = (channel: string, now: number, before: number): ChannelDelta => ({
    channel, label: channelLabel(channel), now, before, change: now - before,
    pct: before === 0 ? null : (now - before) / before,
  });

  it("is null when no channel moved by 3 or more", () => {
    expect(biggestMover([d("a", 5, 3), d("b", 1, 3)])).toBeNull(); // +2 and -2
    expect(biggestMover([])).toBeNull();
  });
  it("accepts a move of exactly 3 up or down", () => {
    expect(biggestMover([d("a", 6, 3)])?.channel).toBe("a");
    expect(biggestMover([d("b", 0, 3)])?.channel).toBe("b");
  });
  it("picks the largest absolute change", () => {
    expect(biggestMover([d("a", 8, 3), d("b", 0, 6)])?.channel).toBe("b"); // +5 vs -6
  });
  it("breaks a tie on |change| by the larger |pct|, with null ranking last", () => {
    expect(biggestMover([d("a", 10, 6), d("b", 4, 0)])?.channel).toBe("a"); // +4 (67%) vs +4 (null)
    expect(biggestMover([d("a", 4, 0), d("b", 10, 6)])?.channel).toBe("b");
    expect(biggestMover([d("a", 7, 3), d("b", 3, 7)])?.channel).toBe("a"); // +4 (133%) vs -4 (57%)
  });
  it("breaks a full tie by list order (the channel-table order)", () => {
    expect(biggestMover([d("a", 6, 3), d("b", 0, 3)])?.channel).toBe("a"); // +3 (100%) vs -3 (100%)
    expect(biggestMover([d("b", 0, 3), d("a", 6, 3)])?.channel).toBe("b");
  });
});

describe("sundayObservation", () => {
  // 2026-10-04 and 2026-09-27 are Sundays.
  const cur = [srow("2026-10-04", "walk_in", 2, 1), srow("2026-10-01", "walk_in", 9)];
  it("reports Sunday activity this period when the period before recorded none", () => {
    expect(sundayObservation(cur, [srow("2026-09-29", "walk_in", 4)], "week")).toBe(
      "Sunday activity was recorded this week (3 served); none was recorded on Sunday the week before.",
    );
    expect(sundayObservation(cur, [], "month")).toBe(
      "Sunday activity was recorded this month (3 served); none was recorded on Sunday the month before.",
    );
  });
  it("says nothing when the period before also had Sunday activity", () => {
    expect(sundayObservation(cur, [srow("2026-09-27", "walk_in", 1)], "week")).toBeNull();
  });
  it("says nothing when this period had none, or when there is no comparison", () => {
    expect(sundayObservation([srow("2026-10-01", "walk_in", 9)], [], "week")).toBeNull();
    expect(sundayObservation(cur, null, "week")).toBeNull();
    expect(sundayObservation([], [], "week")).toBeNull();
  });
});

describe("sheetDatesText", () => {
  it("is the page's wording: service dates per tab, then the registration date", () => {
    expect(
      sheetDatesText({ sheet_last_dates: { lab: "2026-09-30", consult: "2026-09-29", customers: "2026-09-28" } }),
    ).toBe(
      ` Latest service date in the sheet: Lab ${manilaDate("2026-09-30")} · Consultations ${manilaDate("2026-09-29")}. ` +
        `Latest registration date in the sheet: ${manilaDate("2026-09-28")}.`,
    );
  });
  it("skips tabs with no date and is empty when there are none", () => {
    expect(sheetDatesText({ sheet_last_dates: { lab: null, customers: null } })).toBe("");
    expect(sheetDatesText({ sheet_last_dates: {} })).toBe("");
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/lib/marketing/patient-sources.test.ts` → FAIL (`channelDeltas` etc. not exported).

- [ ] **Step 3: Implement.** In `patient-sources.ts`: (a) change `function totalsByChannel(` to `export function totalsByChannel(`; (b) add `manilaDate` to the `@/lib/dates/manila` import; (c) append after `channelTable`:

```ts
export interface ChannelDelta {
  channel: string;
  label: string;
  /** This period: confirmed + unconfirmed. */
  now: number;
  /** The comparison period: confirmed + unconfirmed. */
  before: number;
  change: number;
  /** change / before as a fraction (0.5 = +50%); null when there was nothing before. */
  pct: number | null;
}

/**
 * Per-channel change for the owner email (spec §2). Includes channels that are
 * zero now but were positive before, so a fall to zero stays visible. Ordered
 * like `channelTable` (this period's total, then label, then code). No
 * comparison period → no deltas.
 */
export function channelDeltas(current: readonly SeriesRow[], previous: readonly SeriesRow[] | null): ChannelDelta[] {
  if (previous === null) return [];
  const cur = totalsByChannel(current);
  const prev = totalsByChannel(previous);
  return [...new Set([...cur.keys(), ...prev.keys()])]
    .map((channel) => {
      const c = cur.get(channel);
      const p = prev.get(channel);
      const now = (c?.confirmed ?? 0) + (c?.unconfirmed ?? 0);
      const before = (p?.confirmed ?? 0) + (p?.unconfirmed ?? 0);
      return {
        channel,
        label: channelLabel(channel),
        now,
        before,
        change: now - before,
        pct: before === 0 ? null : (now - before) / before,
      };
    })
    .sort((a, b) => b.now - a.now || a.label.localeCompare(b.label) || a.channel.localeCompare(b.channel));
}

/** A channel must move by at least this many people to be called out. */
export const BIGGEST_MOVER_MIN = 3;

/**
 * The channel with the largest |change| of at least BIGGEST_MOVER_MIN. A tie on
 * |change| goes to the larger |pct| (null ranks last), then to list order — the
 * deltas arrive in channel-table order, so a strictly-greater test keeps the
 * earlier one.
 */
export function biggestMover(deltas: readonly ChannelDelta[]): ChannelDelta | null {
  let best: ChannelDelta | null = null;
  for (const d of deltas) {
    if (Math.abs(d.change) < BIGGEST_MOVER_MIN) continue;
    if (best === null) {
      best = d;
      continue;
    }
    const a = Math.abs(d.change);
    const b = Math.abs(best.change);
    if (a > b) best = d;
    else if (a === b) {
      const pa = d.pct === null ? -1 : Math.abs(d.pct);
      const pb = best.pct === null ? -1 : Math.abs(best.pct);
      if (pa > pb) best = d;
    }
  }
  return best;
}

/**
 * An observation, never a cause (spec §2): the period had served customers on a
 * Sunday and the period before recorded none. No claim about opening hours.
 * `current` / `previous` are served-by-day rows (any channel split).
 */
export function sundayObservation(
  current: readonly SeriesRow[],
  previous: readonly SeriesRow[] | null,
  unit: "week" | "month",
): string | null {
  if (previous === null) return null;
  const onSundays = (rows: readonly SeriesRow[]) =>
    rows
      .filter((r) => isoWeekday(r.bucket_start) === 0)
      .reduce((s, r) => s + Number(r.confirmed) + Number(r.unconfirmed), 0);
  const now = onSundays(current);
  if (now < 1 || onSundays(previous) > 0) return null;
  return `Sunday activity was recorded this ${unit} (${now} served); none was recorded on Sunday the ${unit} before.`;
}

const SHEET_TAB_LABEL: Record<string, string> = { lab: "Lab", consult: "Consultations", customers: "Customers" };

/**
 * "Latest service date in the sheet: Lab …. Latest registration date in the
 * sheet: …." — the Patient Sources page's own wording (leading space on each
 * sentence, "" when there is nothing to say), shared so the page and the owner
 * email cannot drift. "customers" is the latest REGISTRATION date, not a sync
 * time (0189); lab/consult are the latest service dates.
 */
export function sheetDatesText(s: Pick<SummaryRow, "sheet_last_dates">): string {
  const dates = Object.entries(s.sheet_last_dates ?? {}).filter(([, d]) => d);
  const service = dates.filter(([tab]) => tab !== "customers");
  const registration = dates.find(([tab]) => tab === "customers")?.[1];
  return (
    (service.length > 0
      ? ` Latest service date in the sheet: ${service.map(([tab, d]) => `${SHEET_TAB_LABEL[tab] ?? tab} ${manilaDate(d as string)}`).join(" · ")}.`
      : "") +
    (registration ? ` Latest registration date in the sheet: ${manilaDate(registration as string)}.` : "")
  );
}
```

- [ ] **Step 4: Run** `npx vitest run src/lib/marketing/patient-sources.test.ts` → PASS; then `npx tsc --noEmit 2>&1 | head -5` → no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/marketing/patient-sources.ts src/lib/marketing/patient-sources.test.ts
git commit -m "feat(sources): channel deltas, biggest mover and Sunday observation helpers" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `sendEmail` — idempotency key and a `definite` outcome

**Files:** Modify `src/lib/notifications/email.ts`; Create `src/lib/notifications/email.test.ts`.

- [ ] **Step 1: Write the failing test** `src/lib/notifications/email.test.ts`

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { sendEmail } from "./email";

const INPUT = { to: "owner@example.com", subject: "S", text: "T" };

beforeEach(() => {
  vi.stubEnv("NOTIFICATIONS_LIVE", "true");
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  vi.stubEnv("RESEND_FROM_EMAIL", "DRMed <noreply@drmed.ph>");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function stubFetch(impl: () => Promise<Response>) {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const headersOf = (f: ReturnType<typeof vi.fn>) => (f.mock.calls[0]![1] as { headers: Record<string, string> }).headers;

describe("sendEmail", () => {
  it("returns the Resend id on a 2xx", async () => {
    stubFetch(async () => new Response(JSON.stringify({ id: "em_1" }), { status: 200 }));
    expect(await sendEmail(INPUT)).toEqual({ ok: true, id: "em_1" });
  });

  it("sends an Idempotency-Key header only when one is given", async () => {
    const f1 = stubFetch(async () => new Response(JSON.stringify({ id: "em_1" }), { status: 200 }));
    await sendEmail({ ...INPUT, idempotencyKey: "patient_sources_weekly:2026-09-28:owner@example.com:1" });
    expect(headersOf(f1)["Idempotency-Key"]).toBe("patient_sources_weekly:2026-09-28:owner@example.com:1");

    const f2 = stubFetch(async () => new Response(JSON.stringify({ id: "em_2" }), { status: 200 }));
    await sendEmail(INPUT);
    expect(headersOf(f2)["Idempotency-Key"]).toBeUndefined();
  });

  it("marks a non-2xx answer as a DEFINITE failure (Resend read the request and refused it)", async () => {
    stubFetch(async () => new Response("invalid", { status: 422 }));
    const r = await sendEmail(INPUT);
    expect(r).toMatchObject({ ok: false, kind: "error", definite: true });
    expect((r as { error: string }).error).toContain("422");
  });

  it("marks a thrown fetch as NOT definite (the request may have reached Resend)", async () => {
    stubFetch(async () => {
      throw new Error("socket hang up");
    });
    expect(await sendEmail(INPUT)).toMatchObject({ ok: false, kind: "error", definite: false, error: "socket hang up" });
  });

  it("marks a 2xx with an unreadable body as NOT definite (the mail was probably accepted)", async () => {
    stubFetch(async () => new Response("<html>not json</html>", { status: 200 }));
    expect(await sendEmail(INPUT)).toMatchObject({ ok: false, kind: "error", definite: false });
  });

  it("skips (and never calls fetch) when this environment is not live", async () => {
    vi.stubEnv("NOTIFICATIONS_LIVE", "");
    const f = stubFetch(async () => new Response("{}", { status: 200 }));
    const r = await sendEmail(INPUT);
    expect(r).toMatchObject({ ok: false, kind: "skipped" });
    expect(f).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/lib/notifications/email.test.ts` → FAIL (`definite` missing, header missing).

- [ ] **Step 3: Implement.** Replace the top of `email.ts` (the `SendEmailInput` / `SendResult` declarations) and the fetch block:

```ts
export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /**
   * Sent as Resend's `Idempotency-Key`. Defence in depth for a retry of the SAME
   * send inside Resend's window — callers that must not double-send claim the
   * send first and never rely on this alone.
   */
  idempotencyKey?: string;
}

export type SendResult =
  | { ok: true; id: string }
  // definite: true ONLY when an HTTP response with a non-2xx status was read —
  // Resend refused the mail. false/absent means the request may have reached
  // Resend (fetch threw, or a 2xx body could not be read): the mail may exist.
  | { ok: false; kind: "error"; error: string; definite?: boolean }
  | { ok: false; kind: "skipped"; reason: string };
```
and inside `sendEmail`: headers become

```ts
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : {}),
      },
```
the non-2xx return gains `definite: true`, and the `catch` return gains `definite: false`:

```ts
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, kind: "error", error: `Resend ${res.status}: ${body.slice(0, 200)}`, definite: true };
    }
    const data = (await res.json()) as { id?: string };
    return { ok: true, id: data.id ?? "" };
  } catch (err) {
    return { ok: false, kind: "error", error: err instanceof Error ? err.message : "unknown", definite: false };
  }
```

- [ ] **Step 4: Run** `npx vitest run src/lib/notifications` → PASS (existing notify-* mocks still typecheck because `definite` is optional); `npx tsc --noEmit 2>&1 | head -5` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/notifications/email.ts src/lib/notifications/email.test.ts
git commit -m "feat(notify): sendEmail idempotency key and definite-failure flag" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 3: Migration `<N>` + alert registry + seed/smoke parity

One commit, because `staff-alerts.test.ts` pins the registry to the **last** `staff_alert_settings_key_check` across sorted migrations — the TS list and the migration must land together.

**Files:**
- Create: `supabase/migrations/<N>_patient_sources_digest.sql`
- Modify: `src/lib/notifications/staff-alerts.ts`, `src/lib/notifications/staff-alerts.test.ts`, `supabase/seed.sql`, `supabase/tests/0151_rls_initplan_smoke.sql`

- [ ] **Step 1: Re-grep the newest key list** (it was 0192's seven at the time of writing)

Run: `git grep -l staff_alert_settings_key_check supabase/migrations | sort | tail -2` and read the `check (alert_key in (...))` of the LAST file. If it is not exactly `website_message, template_health, dedup_digest, online_booking, released_payment_removed, stale_bookings, result_released`, use that list in Step 3 instead (never drop a key).

- [ ] **Step 2: Write the failing registry test** (append to `staff-alerts.test.ts`; the existing "CHECK list matches STAFF_ALERT_KEYS" and "every key is seeded" tests are the real pin and will fail until the migration exists)

```ts
describe("Patient Sources owner emails", () => {
  it("are admin-default alerts with their own sent actions", () => {
    expect(STAFF_ALERTS.patient_sources_weekly).toMatchObject({
      label: "Weekly patient sources",
      defaultRoles: ["admin"],
      sentAction: "system.patient_sources_weekly.sent",
    });
    expect(STAFF_ALERTS.patient_sources_monthly).toMatchObject({
      label: "Monthly patient sources",
      defaultRoles: ["admin"],
      sentAction: "system.patient_sources_monthly.sent",
    });
  });
});
```

- [ ] **Step 3: Write the migration** `supabase/migrations/<N>_patient_sources_digest.sql`

```sql
-- =============================================================================
-- <N> — Patient Sources owner emails: two alert keys, the send-claim table, its
--       claim function, and a service_role read of ad_spend_daily
-- =============================================================================
-- Two staff alerts for Admin Tools > Email Alerts (0155): a weekly digest (Monday
-- 07:00 Manila) and a monthly digest (the 1st, 08:00 Manila) of Patient Sources
-- numbers, sent by /api/cron/patient-sources-weekly and -monthly.
--
-- DELIVERY RULE: at most once, automatically. A duplicate owner digest is a
-- nuisance; a missed one is visible on the cron watchdog. So when delivery is
-- uncertain nothing re-sends by itself — the row is flagged 'unknown' for an
-- operator. public.patient_sources_digest_sends holds one row per
-- (alert, period start, recipient); public._ps_digest_claim() is the atomic claim
-- (a single INSERT ... ON CONFLICT DO UPDATE ... WHERE, so two overlapping cron
-- invocations cannot both win — proven by scripts/ps-digest-claim-concurrency-proof.ts).
--
-- Statuses: sending (claimed) | sent (Resend 2xx with an id) | failed (definite:
-- Resend answered non-2xx, or sending was skipped) | unknown (the request may have
-- reached Resend, or a 'sending' row went stale — 15 minutes).
--
-- The table is service_role-only server state: RLS on, NO policy, nothing for
-- anon/authenticated (supabase/seed.sql re-revokes it after a local reset, and
-- supabase/tests/0151_rls_initplan_smoke.sql allow-lists it).
--
-- The cron reads ad_spend_daily DIRECTLY with the service key. Prod has
-- service_role SELECT on it through Supabase default privileges; a fresh replay
-- only gets it from seed.sql, so grant it here and local proofs match prod. It
-- must NEVER call ad_spend_daily_totals / ad_spend_coverage / ad_spend_rows /
-- patient_sources_revenue|overlaps|referrers|people with the service key: those
-- are admin-only inside the body, so a service-key call is a REFUSED function
-- call, and on prod image 17.6.1.111 a refused call crashes Postgres.
-- =============================================================================

-- (1) The two alert keys. The CHECK is re-created with the FULL literal list;
-- STAFF_ALERT_KEYS in src/lib/notifications/staff-alerts.ts is pinned to the
-- latest definition by staff-alerts.test.ts.
alter table public.staff_alert_settings
  drop constraint if exists staff_alert_settings_key_check;

alter table public.staff_alert_settings
  add constraint staff_alert_settings_key_check
    check (alert_key in (
      'website_message', 'template_health', 'dedup_digest', 'online_booking',
      'released_payment_removed', 'stale_bookings', 'result_released',
      'patient_sources_weekly', 'patient_sources_monthly'
    ));

insert into public.staff_alert_settings (alert_key)
values ('patient_sources_weekly'), ('patient_sources_monthly')
on conflict (alert_key) do nothing;

-- (2) One row per (alert, period start, recipient).
create table if not exists public.patient_sources_digest_sends (
  alert_key   text        not null
              check (alert_key in ('patient_sources_weekly', 'patient_sources_monthly')),
  period_from date        not null,
  period_to   date        not null check (period_to >= period_from),
  recipient   text        not null check (recipient <> '' and recipient = lower(recipient)),
  status      text        not null check (status in ('sending', 'sent', 'failed', 'unknown')),
  attempts    int         not null default 1 check (attempts >= 1),
  provider_id text,
  last_error  text,
  updated_at  timestamptz not null default now(),
  primary key (alert_key, period_from, recipient)
);

alter table public.patient_sources_digest_sends enable row level security;
-- No policy on purpose: server code (service_role) only.
-- Literal revokes (not format() in a do block): seed-grant-parity.test.ts regex-scans for them.
revoke all on public.patient_sources_digest_sends from public, anon, authenticated;
grant select, insert, update on public.patient_sources_digest_sends to service_role;

-- (3) The atomic claim. Returns the new attempt number, or NULL when this call
-- did not claim: the row is already sent, in flight, or unknown (and the caller
-- did not ask for unknowns). A 'sending' row older than 15 minutes is first
-- flipped to 'unknown' and NOT claimed — the run that owned it died between the
-- claim and recording the outcome, so the email may or may not have gone.
-- SECURITY INVOKER: service_role holds the table privileges it needs.
create or replace function public._ps_digest_claim(
  p_key             text,
  p_from            date,
  p_to              date,
  p_recipient       text,
  p_include_unknown boolean default false
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_recipient text := lower(btrim(p_recipient));
  v_attempts  integer;
begin
  if p_key is null or p_from is null or p_to is null or v_recipient is null or v_recipient = '' then
    raise exception '_ps_digest_claim: key, period and recipient are required' using errcode = '22023';
  end if;

  update public.patient_sources_digest_sends s
     set status = 'unknown',
         last_error = coalesce(s.last_error, 'the send started but its outcome was never recorded'),
         updated_at = now()
   where s.alert_key = p_key
     and s.period_from = p_from
     and s.recipient = v_recipient
     and s.status = 'sending'
     and s.updated_at < now() - interval '15 minutes';

  insert into public.patient_sources_digest_sends as ds
    (alert_key, period_from, period_to, recipient, status, attempts, updated_at)
  values (p_key, p_from, p_to, v_recipient, 'sending', 1, now())
  on conflict (alert_key, period_from, recipient) do update
    set status = 'sending',
        attempts = ds.attempts + 1,
        provider_id = null,
        last_error = null,
        updated_at = now()
  where ds.status = 'failed' or (p_include_unknown and ds.status = 'unknown')
  returning ds.attempts into v_attempts;

  return v_attempts;
end;
$$;

-- New functions default to postgres + service_role (0119); restate it, and name
-- anon/authenticated too (hosted Supabase grants them EXECUTE directly).
revoke all on function public._ps_digest_claim(text, date, date, text, boolean) from public, anon, authenticated;
grant execute on function public._ps_digest_claim(text, date, date, text, boolean) to service_role;

-- (4) The cron reads ad spend with the service key.
grant select on public.ad_spend_daily to service_role;

-- (5) Post-checks, 0206 style: a replay that does not land every piece fails loudly.
do $$
declare
  v_def text;
  k     text;
  r     text;
  rel   regclass := 'public.patient_sources_digest_sends'::regclass;
  fn    text := 'public._ps_digest_claim(text,date,date,text,boolean)';
begin
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = 'public.staff_alert_settings'::regclass
     and c.conname = 'staff_alert_settings_key_check';
  foreach k in array array[
    'website_message', 'template_health', 'dedup_digest', 'online_booking',
    'released_payment_removed', 'stale_bookings', 'result_released',
    'patient_sources_weekly', 'patient_sources_monthly'
  ] loop
    if v_def is null or position('''' || k || '''' in v_def) = 0 then
      raise exception 'post-check: staff_alert_settings_key_check is missing %', k;
    end if;
  end loop;

  if (select count(*) from public.staff_alert_settings
       where alert_key in ('patient_sources_weekly', 'patient_sources_monthly')) <> 2 then
    raise exception 'post-check: a Patient Sources alert settings row is missing';
  end if;

  if not (select c.relrowsecurity from pg_class c where c.oid = rel) then
    raise exception 'post-check: RLS is off on patient_sources_digest_sends';
  end if;
  if exists (select 1 from pg_policy p where p.polrelid = rel) then
    raise exception 'post-check: patient_sources_digest_sends must have no policy (service_role only)';
  end if;

  foreach r in array array['anon', 'authenticated'] loop
    if has_table_privilege(r, rel, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       or has_any_column_privilege(r, rel, 'SELECT,INSERT,UPDATE,REFERENCES') then
      raise exception 'post-check: % holds a privilege on patient_sources_digest_sends', r;
    end if;
    if has_function_privilege(r, fn, 'execute') then
      raise exception 'post-check: % can execute _ps_digest_claim', r;
    end if;
  end loop;

  if not has_table_privilege('service_role', rel, 'SELECT,INSERT,UPDATE') then
    raise exception 'post-check: service_role cannot read/insert/update patient_sources_digest_sends';
  end if;
  if has_table_privilege('service_role', rel, 'DELETE') then
    raise exception 'post-check: service_role must not DELETE from patient_sources_digest_sends';
  end if;
  if not has_function_privilege('service_role', fn, 'execute') then
    raise exception 'post-check: service_role cannot execute _ps_digest_claim';
  end if;
  if not has_table_privilege('service_role', 'public.ad_spend_daily'::regclass, 'SELECT') then
    raise exception 'post-check: service_role cannot read ad_spend_daily';
  end if;
end;
$$;
```

(Keep the `where ds.status = 'failed' or (p_include_unknown and ds.status = 'unknown')` line and the `interval '15 minutes'` text byte-identical — Task 4's `--control` mutants string-replace them and throw if they vanish.)

- [ ] **Step 4: Registry.** In `staff-alerts.ts` append the two keys to `STAFF_ALERT_KEYS` (after `"result_released"`) and two entries to `STAFF_ALERTS`:

```ts
  patient_sources_weekly: {
    key: "patient_sources_weekly",
    label: "Weekly patient sources",
    description:
      "Monday 7:00 AM: last week's new patients by channel, served, revenue, top referrers and cost per new patient, compared with the week before.",
    defaultRoles: ["admin"],
    sentAction: "system.patient_sources_weekly.sent",
  },
  patient_sources_monthly: {
    key: "patient_sources_monthly",
    label: "Monthly patient sources",
    description: "1st of the month, 8:00 AM: the same for last month vs the month before.",
    defaultRoles: ["admin"],
    sentAction: "system.patient_sources_monthly.sent",
  },
```

- [ ] **Step 5: Seed parity.** Append to the tail of `supabase/seed.sql` (after the last existing carve-out):

```sql
-- <N>: the Patient Sources owner-email send claims are service_role-only server
-- state (RLS on, no policy). The blanket grants above would hand anon/authenticated
-- ALL on a fresh local database while prod holds nothing for them — re-revoke by name.
revoke all on public.patient_sources_digest_sends from anon, authenticated;
```

- [ ] **Step 6: 0151 smoke allow-list.** In `supabase/tests/0151_rls_initplan_smoke.sql`, inside the second assertion's `c.relname not in (...)` list, add after `'sheet_mirror_staging'` (add the comma to that line):

```sql
      'sheet_mirror_staging',
      -- <N>: Patient Sources owner-email send claims. Only the service-role cron
      -- (via _ps_digest_claim) reads or writes it; no admin page shows it, so a
      -- policy would only widen access. anon/authenticated hold nothing (third assertion).
      'patient_sources_digest_sends'
```

- [ ] **Step 7: Run the pinned tests**

Run: `npx vitest run src/lib/notifications/staff-alerts.test.ts src/lib/supabase/seed-grant-parity.test.ts src/lib/db/concurrency-proof-guard.test.ts 2>&1 | tail -15`
Expected: `staff-alerts` + `seed-grant-parity` PASS. **`concurrency-proof-guard` FAILS** on `_ps_digest_claim` ("takes locks or claims work … but has no concurrency proof") — that failure is the guard working; Task 4 supplies the proof. Do not commit a green-skipped guard.

- [ ] **Step 8: Commit** (guard failure expected until Task 4; commit both tasks' work as separate commits but run the guard only after Task 4)

```bash
git add supabase/migrations/<N>_patient_sources_digest.sql supabase/seed.sql supabase/tests/0151_rls_initplan_smoke.sql src/lib/notifications/staff-alerts.ts src/lib/notifications/staff-alerts.test.ts
git commit -m "feat(db): <N> — Patient Sources owner-email alert keys, send claims and claim function" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Isolated-stack DB proof — replay, smoke, two-session concurrency, `--control`, types

**Files:**
- Create: `supabase/tests/<N>_patient_sources_digest_smoke.sql`, `scripts/ps-digest-claim-concurrency-proof.ts`
- Modify: `src/lib/db/concurrency-proof-guard.test.ts`, `package.json`, `src/types/database.ts` (regenerated)

- [ ] **Step 1: Replay every migration + `seed.sql` on the isolated stack**

```bash
rsync -a --delete supabase/migrations/ $SP/supabase/migrations/ && rsync -a supabase/seed.sql $SP/supabase/seed.sql
npx supabase db reset --workdir $SP > $SP/reset.log 2>&1; echo exit=$?
$PSQL $DB -At -c "select max(version) from supabase_migrations.schema_migrations"
```
Expected: `exit=0`; max version is `<N>`. (Only this isolated project resets — `--workdir` points at the copy.)

- [ ] **Step 2: Write the smoke** `supabase/tests/<N>_patient_sources_digest_smoke.sql` (sequential states + the ACL that must hold AFTER `db reset`, i.e. migrations + seed — not just the migration's own post-check)

```sql
-- <N> smoke: the claim function's states one after another, and the ACLs after a
-- full replay (migrations + seed.sql). Sequential only — a transaction never waits
-- on itself, so the RACE is proven by scripts/ps-digest-claim-concurrency-proof.ts.
-- Run: psql "$DB" -v ON_ERROR_STOP=1 -f supabase/tests/<N>_patient_sources_digest_smoke.sql
begin;

do $$
declare
  k  constant text := 'patient_sources_weekly';
  f  constant date := date '2090-01-05';
  t  constant date := date '2090-01-11';
  r  constant text := 'owner@example.com';
  a  integer;
  s  text;
  e  text;
begin
  -- a fresh claim lower-cases + trims the recipient and returns attempt 1
  a := public._ps_digest_claim(k, f, t, '  Owner@Example.com ');
  if a is distinct from 1 then raise exception 'smoke: first claim should return 1, got %', a; end if;
  select status into s from public.patient_sources_digest_sends where alert_key = k and period_from = f and recipient = r;
  if s is distinct from 'sending' then raise exception 'smoke: claimed row should be sending, got %', s; end if;

  -- an in-flight row cannot be claimed again
  if public._ps_digest_claim(k, f, t, r) is not null then raise exception 'smoke: a sending row was claimed twice'; end if;

  -- a definite failure is re-claimed, attempts + 1, error cleared
  update public.patient_sources_digest_sends set status = 'failed', last_error = 'Resend 422', provider_id = 'x'
   where alert_key = k and period_from = f and recipient = r;
  a := public._ps_digest_claim(k, f, t, r);
  if a is distinct from 2 then raise exception 'smoke: re-claim of a failed row should return 2, got %', a; end if;
  select status, last_error into s, e from public.patient_sources_digest_sends where alert_key = k and period_from = f and recipient = r;
  if s <> 'sending' or e is not null then raise exception 'smoke: re-claim must reset to sending with no error (% / %)', s, e; end if;

  -- a sent row is never claimed, even when unknowns are allowed
  update public.patient_sources_digest_sends set status = 'sent', provider_id = 'em_1'
   where alert_key = k and period_from = f and recipient = r;
  if public._ps_digest_claim(k, f, t, r) is not null then raise exception 'smoke: a sent row was claimed'; end if;
  if public._ps_digest_claim(k, f, t, r, true) is not null then raise exception 'smoke: a sent row was claimed with include_unknown'; end if;

  -- an unknown row is claimed only when the operator asks for unknowns
  update public.patient_sources_digest_sends set status = 'unknown', last_error = 'socket hang up'
   where alert_key = k and period_from = f and recipient = r;
  if public._ps_digest_claim(k, f, t, r) is not null then raise exception 'smoke: an unknown row was claimed automatically'; end if;
  a := public._ps_digest_claim(k, f, t, r, true);
  if a is distinct from 3 then raise exception 'smoke: include_unknown re-claim should return 3, got %', a; end if;

  -- a STALE sending row (older than 15 minutes) becomes unknown and is NOT claimed
  update public.patient_sources_digest_sends set status = 'sending', last_error = null, updated_at = now() - interval '16 minutes'
   where alert_key = k and period_from = f and recipient = r;
  if public._ps_digest_claim(k, f, t, r) is not null then raise exception 'smoke: a stale sending row was claimed'; end if;
  select status, last_error into s, e from public.patient_sources_digest_sends where alert_key = k and period_from = f and recipient = r;
  if s <> 'unknown' or e is null then raise exception 'smoke: a stale sending row must flip to unknown with a note (% / %)', s, e; end if;

  -- a 14-minute-old sending row is still in flight: untouched
  update public.patient_sources_digest_sends set status = 'sending', last_error = null, updated_at = now() - interval '14 minutes'
   where alert_key = k and period_from = f and recipient = r;
  if public._ps_digest_claim(k, f, t, r) is not null then raise exception 'smoke: a fresh sending row was claimed'; end if;
  select status into s from public.patient_sources_digest_sends where alert_key = k and period_from = f and recipient = r;
  if s <> 'sending' then raise exception 'smoke: a 14-minute-old sending row must stay sending, got %', s; end if;

  -- a different period or recipient is its own claim
  if public._ps_digest_claim(k, f + 7, t + 7, r) is distinct from 1 then raise exception 'smoke: next period must claim fresh'; end if;
  if public._ps_digest_claim(k, f, t, 'ops@example.com') is distinct from 1 then raise exception 'smoke: another recipient must claim fresh'; end if;

  -- constraints
  begin
    insert into public.patient_sources_digest_sends (alert_key, period_from, period_to, recipient, status)
    values (k, f, t, 'x@example.com', 'bogus');
    raise exception 'smoke: a bogus status was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.patient_sources_digest_sends (alert_key, period_from, period_to, recipient, status)
    values ('stale_bookings', f, t, 'x@example.com', 'sent');
    raise exception 'smoke: a foreign alert key was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.patient_sources_digest_sends (alert_key, period_from, period_to, recipient, status)
    values (k, f, t, 'MixedCase@example.com', 'sent');
    raise exception 'smoke: a non-lower-case recipient was accepted';
  exception when check_violation then null;
  end;
  begin
    perform public._ps_digest_claim(k, f, t, '   ');
    raise exception 'smoke: a blank recipient was accepted';
  exception when sqlstate '22023' then null;
  end;
end;
$$;

-- ACLs and shape AFTER a full replay (migrations + seed.sql).
do $$
declare
  rel regclass := 'public.patient_sources_digest_sends'::regclass;
  fn  text := 'public._ps_digest_claim(text,date,date,text,boolean)';
  r   text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if has_table_privilege(r, rel, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       or has_any_column_privilege(r, rel, 'SELECT,INSERT,UPDATE,REFERENCES') then
      raise exception 'smoke: % holds a privilege on the claim table after the seed (seed.sql re-revoke missing?)', r;
    end if;
    if has_function_privilege(r, fn, 'execute') then raise exception 'smoke: % can execute _ps_digest_claim', r; end if;
  end loop;
  if not has_function_privilege('service_role', fn, 'execute') then raise exception 'smoke: service_role cannot execute the claim'; end if;
  if not has_table_privilege('service_role', 'public.ad_spend_daily'::regclass, 'SELECT') then raise exception 'smoke: service_role cannot read ad_spend_daily'; end if;
  if not (select relrowsecurity from pg_class where oid = rel) then raise exception 'smoke: RLS is off'; end if;
  if exists (select 1 from pg_policy where polrelid = rel) then raise exception 'smoke: the claim table must have no policy'; end if;
  if (select count(*) from public.staff_alert_settings where alert_key in ('patient_sources_weekly', 'patient_sources_monthly')) <> 2 then
    raise exception 'smoke: a Patient Sources alert row is missing';
  end if;
  if (select prosecdef from pg_proc where oid = fn::regprocedure) then raise exception 'smoke: _ps_digest_claim must be SECURITY INVOKER'; end if;
  raise notice '<N> smoke: claim states, constraints and ACLs OK.';
end;
$$;

rollback;
```

- [ ] **Step 3: Run the smoke and the 0151 smoke on the replayed stack**

```bash
$PSQL $DB -v ON_ERROR_STOP=1 -f supabase/tests/<N>_patient_sources_digest_smoke.sql 2>&1 | tail -4
$PSQL $DB -v ON_ERROR_STOP=1 -f supabase/tests/0151_rls_initplan_smoke.sql 2>&1 | tail -6
```
Expected: `<N> smoke: claim states, constraints and ACLs OK.`; then the three 0151 notices (`all policies evaluate…`, `no table lost its last policy.`, `no-policy tables grant nothing to anon/authenticated.`) with no ERROR. If the third 0151 assertion names `patient_sources_digest_sends`, the seed re-revoke (Task 3 Step 5) is missing or the reset ran on stale files — redo Step 1.

- [ ] **Step 4: Write the two-session concurrency proof** `scripts/ps-digest-claim-concurrency-proof.ts`

```ts
// Hand-run local CONCURRENCY proof for the Patient Sources owner-email claim
// (supabase/migrations/<N>_patient_sources_digest.sql): public._ps_digest_claim.
//
// supabase/tests/<N>_patient_sources_digest_smoke.sql proves each claim state one
// statement after another. This runner proves the same function when two or more
// cron invocations claim the SAME recipient/period AT THE SAME MOMENT: separate `pg`
// connections, each acting as service_role (the role the cron uses).
//
// DETERMINISTIC, NOT LUCKY. Forced scenarios hold one side's claim in an open
// transaction, start the other, and do not move on until pg_locks shows that
// backend waiting on a row lock. If the interleaving is not reached the scenario
// FAILS — it never degrades into a sequential run. Only C (free races) relies on timing.
//
// Scenarios: A fresh row (second claim waits on the uncommitted insert, then loses) ·
// B failed row (second claim waits on the row lock, then loses; attempts +1 once) ·
// C free races on a failed row (exactly one winner of 4) · D stale 'sending' row
// (nobody claims; flipped to unknown exactly once) · E include_unknown race (one winner).
//
// FIXTURES are committed (two connections cannot see each other's uncommitted rows),
// tagged psd-<hex>, swept at start, deleted in finally and then counted.
//
// Run (isolated or local stack, <N> applied):
//   SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:56422/postgres \
//     npm run ps-digest-claim:concurrency-proof [-- --control]
//   PSD_ROUNDS=100 npm run ps-digest-claim:concurrency-proof
//
// --control proves the proof can fail: it copies the live function into a throwaway
// schema with ONE guard removed and passes only if the named scenarios FAIL:
//   M1 drops the `where ds.status = 'failed' …` guard (A, B, C, E must fail)
//   M2 makes the stale window 15 years, i.e. no stale flip (D must fail)
//
// concurrency-proof: _ps_digest_claim (scenarios A–E and both mutants race the real claim)
import "./lib/load-env";
import { requireLocalOrExplicitProd } from "./lib/env-guard";
import { randomBytes } from "node:crypto";
import { Client } from "pg";

requireLocalOrExplicitProd("ps-digest-claim:concurrency-proof", {
  writes:
    "throwaway rows in public.patient_sources_digest_sends tagged psd-<hex>, committed so two connections can race on them, then deleted",
});

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
// This script COMMITS rows, so it must never run against a non-local host, opt-in or not.
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(DB_URL)) {
  console.error(`[ps-digest-claim:concurrency-proof] refusing to run against a non-local DB_URL (${DB_URL}).`);
  process.exit(2);
}

const TAG = `psd-${randomBytes(3).toString("hex")}`;
const KEY = "patient_sources_weekly";
const FROM = "2090-01-05";
const TO = "2090-01-11";
const ROUNDS = Number(process.env.PSD_ROUNDS ?? 25);
const CONTROL = process.argv.includes("--control");
const who = (n: string) => `${TAG}-${n}@example.test`;

let fnSchema = "public";
let monitor: Client;
const open: Client[] = [];

/** End every connection except the monitor (rolling back anything still open). */
async function closeRacers(): Promise<void> {
  for (const c of open.splice(0)) {
    if (c === monitor) continue;
    await c.query("rollback").catch(() => undefined);
    await c.end().catch(() => undefined);
  }
  open.push(monitor);
}

async function connect(): Promise<Client> {
  const c = new Client({ connectionString: DB_URL });
  await c.connect();
  await c.query("set statement_timeout = '20s'");
  open.push(c);
  return c;
}
async function backendPid(c: Client): Promise<number> {
  return (await c.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
}
/** begin + act as service_role, like the cron's admin client. */
async function prepare(c: Client): Promise<void> {
  await c.query("begin");
  await c.query("set local role service_role");
}
function claimQuery(c: Client, recipient: string, includeUnknown: boolean) {
  return c.query<{ n: number | null }>(
    `select ${fnSchema}._ps_digest_claim($1, $2::date, $3::date, $4, $5) as n`,
    [KEY, FROM, TO, recipient, includeUnknown],
  );
}
/** One racer: claim, then end its own transaction the moment its own call answers. */
async function racer(c: Client, recipient: string, includeUnknown: boolean): Promise<number | null> {
  await prepare(c);
  const n = (await claimQuery(c, recipient, includeUnknown)).rows[0]!.n;
  await c.query("commit");
  return n === null ? null : Number(n);
}
async function mustWait(pid: number, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { rowCount } = await monitor.query(
      "select 1 from pg_locks where pid = $1 and not granted and locktype in ('transactionid', 'tuple')",
      [pid],
    );
    if (rowCount) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`${label}: the second claim never waited on the first (interleaving not reached)`);
}
async function put(recipient: string, status: string, ageMinutes = 0, attempts = 1): Promise<void> {
  await monitor.query(
    `insert into public.patient_sources_digest_sends (alert_key, period_from, period_to, recipient, status, attempts, updated_at)
     values ($1, $2, $3, $4, $5, $6, now() - make_interval(mins => $7))
     on conflict (alert_key, period_from, recipient) do update
       set status = excluded.status, attempts = excluded.attempts, updated_at = excluded.updated_at, last_error = null`,
    [KEY, FROM, TO, recipient, status, attempts, ageMinutes],
  );
}
async function rowOf(recipient: string) {
  const { rows } = await monitor.query<{ status: string; attempts: number }>(
    "select status, attempts from public.patient_sources_digest_sends where alert_key = $1 and period_from = $2 and recipient = $3",
    [KEY, FROM, recipient],
  );
  return rows[0] ?? null;
}
function expect(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

type Scenario = () => Promise<void>;

const scenarios: Record<string, Scenario> = {
  // concurrency-proof: _ps_digest_claim
  // A — fresh row: the loser blocks on the winner's uncommitted INSERT, then finds it taken.
  async A() {
    const r = who("a");
    const [s1, s2] = [await connect(), await connect()];
    await prepare(s1);
    const n1 = (await claimQuery(s1, r, false)).rows[0]!.n;
    await prepare(s2);
    const p2 = claimQuery(s2, r, false);
    await mustWait(await backendPid(s2), "A");
    await s1.query("commit");
    const n2 = (await p2).rows[0]!.n;
    await s2.query("commit");
    expect(Number(n1) === 1 && n2 === null, `A: expected winner 1 / loser null, got ${n1} / ${n2}`);
    const row = await rowOf(r);
    expect(row?.status === "sending" && row.attempts === 1, `A: row ${JSON.stringify(row)}`);
  },
  // B — failed row: both want to re-claim; one wins, attempts goes up exactly once.
  async B() {
    const r = who("b");
    await put(r, "failed");
    const [s1, s2] = [await connect(), await connect()];
    await prepare(s1);
    const n1 = (await claimQuery(s1, r, false)).rows[0]!.n;
    await prepare(s2);
    const p2 = claimQuery(s2, r, false);
    await mustWait(await backendPid(s2), "B");
    await s1.query("commit");
    const n2 = (await p2).rows[0]!.n;
    await s2.query("commit");
    expect(Number(n1) === 2 && n2 === null, `B: expected winner 2 / loser null, got ${n1} / ${n2}`);
    const row = await rowOf(r);
    expect(row?.status === "sending" && row.attempts === 2, `B: row ${JSON.stringify(row)}`);
  },
  // C — free race of four claimers on a failed row, ROUNDS times: exactly one winner.
  async C() {
    const r = who("c");
    for (let i = 0; i < ROUNDS; i++) {
      await put(r, "failed");
      const conns = await Promise.all([connect(), connect(), connect(), connect()]);
      const out = await Promise.all(conns.map((c) => racer(c, r, false)));
      const winners = out.filter((n) => n !== null);
      expect(winners.length === 1 && winners[0] === 2, `C round ${i}: outcomes ${JSON.stringify(out)}`);
      const row = await rowOf(r);
      expect(row?.attempts === 2 && row.status === "sending", `C round ${i}: row ${JSON.stringify(row)}`);
      await closeRacers();
    }
  },
  // D — stale 'sending' row: nobody may claim it; it flips to unknown exactly once.
  async D() {
    const r = who("d");
    for (let i = 0; i < ROUNDS; i++) {
      await put(r, "sending", 20);
      const conns = await Promise.all([connect(), connect()]);
      const out = await Promise.all(conns.map((c) => racer(c, r, false)));
      expect(out.every((n) => n === null), `D round ${i}: a stale sending row was claimed ${JSON.stringify(out)}`);
      const row = await rowOf(r);
      expect(row?.status === "unknown" && row.attempts === 1, `D round ${i}: row ${JSON.stringify(row)}`);
      await closeRacers();
    }
  },
  // E — operator retry with include_unknown while the cron also runs: one winner.
  async E() {
    const r = who("e");
    for (let i = 0; i < ROUNDS; i++) {
      await put(r, "unknown");
      const conns = await Promise.all([connect(), connect(), connect()]);
      const out = await Promise.all(conns.map((c) => racer(c, r, true)));
      const winners = out.filter((n) => n !== null);
      expect(winners.length === 1 && winners[0] === 2, `E round ${i}: outcomes ${JSON.stringify(out)}`);
      await closeRacers();
    }
  },
};

async function runAll(): Promise<Record<string, string | null>> {
  const result: Record<string, string | null> = {};
  for (const [name, fn] of Object.entries(scenarios)) {
    try {
      await fn();
      result[name] = null;
      console.log(`  ok   ${name}`);
    } catch (e) {
      result[name] = e instanceof Error ? e.message : String(e);
      console.log(`  FAIL ${name}: ${result[name]}`);
    }
    await closeRacers();
  }
  return result;
}

const MUTANTS: Array<{ id: string; note: string; from: string; to: string; mustFail: string[] }> = [
  {
    id: "M1",
    note: "claim guard removed (any conflicting row is taken over)",
    from: "where ds.status = 'failed' or (p_include_unknown and ds.status = 'unknown')",
    to: "",
    mustFail: ["A", "B", "C", "E"],
  },
  { id: "M2", note: "no stale flip (15 years)", from: "interval '15 minutes'", to: "interval '15 years'", mustFail: ["D"] },
];

async function makeMutant(schema: string, m: (typeof MUTANTS)[number]): Promise<void> {
  const def = (
    await monitor.query<{ d: string }>(
      "select pg_get_functiondef('public._ps_digest_claim(text,date,date,text,boolean)'::regprocedure) as d",
    )
  ).rows[0]!.d;
  if (!def.includes(m.from)) throw new Error(`${m.id}: the live function no longer contains «${m.from}» — update MUTANTS`);
  const body = def.replace("public._ps_digest_claim", `${schema}._ps_digest_claim`).replace(m.from, m.to);
  await monitor.query(`create schema ${schema}`);
  await monitor.query(body);
  await monitor.query(`grant usage on schema ${schema} to service_role`);
  await monitor.query(`grant execute on function ${schema}._ps_digest_claim(text,date,date,text,boolean) to service_role`);
}

async function sweep(): Promise<void> {
  await monitor.query("delete from public.patient_sources_digest_sends where recipient like 'psd-%@example.test'");
  const { rows } = await monitor.query<{ nspname: string }>("select nspname from pg_namespace where nspname like 'psd_ctl_%'");
  for (const r of rows) await monitor.query(`drop schema ${r.nspname} cascade`);
}

async function main(): Promise<void> {
  monitor = await connect();
  const lock = await monitor.query<{ ok: boolean }>("select pg_try_advisory_lock(hashtext('ps-digest-claim:concurrency-proof')) as ok");
  if (!lock.rows[0]!.ok) {
    console.error("another ps-digest-claim concurrency proof is running — exiting");
    process.exit(2);
  }
  let exit = 0;
  const cleanup = async () => {
    await closeRacers();
    await sweep().catch(() => undefined);
    const left = await monitor.query("select 1 from public.patient_sources_digest_sends where recipient like $1", [`${TAG}%`]).catch(() => null);
    if (left?.rowCount) {
      console.error(`FAIL: ${left.rowCount} tagged rows left behind`);
      exit = 1;
    }
  };
  process.once("SIGINT", () => void cleanup().finally(() => process.exit(130)));
  try {
    await sweep();
    console.log(`Plan: ${(await monitor.query<{ v: string }>("select version() as v")).rows[0]!.v}`);
    console.log(`Real function (public), ${ROUNDS} free-race rounds:`);
    const real = await runAll();
    const failed = Object.entries(real).filter(([, e]) => e !== null);
    console.log(`${Object.keys(real).length - failed.length}/${Object.keys(real).length} scenarios passed.`);
    if (failed.length > 0) exit = 1;

    if (CONTROL) {
      for (const m of MUTANTS) {
        const schema = `psd_ctl_${randomBytes(3).toString("hex")}`;
        console.log(`Control ${m.id}: ${m.note}`);
        await makeMutant(schema, m);
        fnSchema = schema;
        const res = await runAll();
        fnSchema = "public";
        const survived = m.mustFail.filter((s) => res[s] === null);
        if (survived.length > 0) {
          console.log(`  CONTROL FAIL ${m.id}: scenarios ${survived.join(", ")} still passed against the mutant — the proof cannot catch this bug`);
          exit = 1;
        } else console.log(`  control ${m.id} ok: ${m.mustFail.join(", ")} all failed against the mutant`);
        await monitor.query(`drop schema ${schema} cascade`);
      }
    }
  } finally {
    await cleanup();
    await monitor.query("select pg_advisory_unlock(hashtext('ps-digest-claim:concurrency-proof'))").catch(() => undefined);
    await monitor.end().catch(() => undefined);
  }
  process.exit(exit);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
```

(`open.length = 0; open.push(monitor)` between rounds keeps the `open` list from holding ended connections; `monitor` stays alive for the whole run. The mutant schemas are swept at the next start if a run is killed.)

- [ ] **Step 5: npm script + guard registry**

In `package.json` add after `waiver:concurrency-proof` (add the comma): `"ps-digest-claim:concurrency-proof": "tsx scripts/ps-digest-claim-concurrency-proof.ts"`.
In `src/lib/db/concurrency-proof-guard.test.ts` add to `REGISTRY` (alphabetical neighbours do not matter): `_ps_digest_claim: { proof: ["scripts/ps-digest-claim-concurrency-proof.ts"] },` and change `expect(proofs.length).toBe(23);` to `.toBe(24);`.

- [ ] **Step 6: Run the proof on the isolated stack, then its controls**

```bash
export SUPABASE_DB_URL=$DB
npm run -s ps-digest-claim:concurrency-proof 2>&1 | tail -12
npm run -s ps-digest-claim:concurrency-proof -- --control 2>&1 | tail -22
```
Expected (first): `ok   A` … `ok   E`, `5/5 scenarios passed.`, exit 0. Expected (second): the same, then `control M1 ok: A, B, C, E all failed against the mutant` and `control M2 ok: D all failed against the mutant`, exit 0. A `CONTROL FAIL` line means a scenario does not actually exercise the guard — fix the scenario, never the expectation. Re-run `PSD_ROUNDS=100 npm run -s ps-digest-claim:concurrency-proof 2>&1 | tail -3` once → `5/5`. Record the three outputs for the PR body. `unset SUPABASE_DB_URL` afterwards.

- [ ] **Step 7: Regenerate the DB types from the isolated stack**

Run: `npm run db:types -- --workdir $SP && git diff --stat src/types/database.ts`
Expected: a diff adding `patient_sources_digest_sends` (Row/Insert/Update) and `_ps_digest_claim` (Args with `p_include_unknown?: boolean`, Returns `number`). Nothing from other unmerged work.

- [ ] **Step 8: Guard + typecheck + commit**

```bash
npx vitest run src/lib/db src/lib/notifications/staff-alerts.test.ts src/lib/supabase scripts/lib 2>&1 | tail -6   # all PASS now
npx tsc --noEmit 2>&1 | head -5
git add supabase/tests/<N>_patient_sources_digest_smoke.sql scripts/ps-digest-claim-concurrency-proof.ts src/lib/db/concurrency-proof-guard.test.ts package.json src/types/database.ts
git commit -m "test(db): <N> claim smoke and two-session concurrency proof with mutant controls" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
`scripts/lib/guard-coverage.test.ts` must stay green: the proof imports `./lib/load-env`, calls `requireLocalOrExplicitProd` before the first `new Client`.

---

### Task 5: Cron wiring — `vercel.json`, `CRON_HEARTBEATS`, watchdog, monthly schedule text

All four cron edits plus the schedule describer in one commit (the drift tests compare them to each other).

**Files:** Modify `src/lib/ops/cron-heartbeats.ts`, `vercel.json`, `.github/workflows/cron-watchdog.yml`, `src/lib/ops/cron-schedule.ts`, `src/lib/ops/cron-schedule.test.ts`.

- [ ] **Step 1: Decide `activeFrom`** (UTC dates; the watchdog treats "never ran" as PENDING before it and STALE from it on)

Weekly fires Sunday 23:00 UTC (= Monday 07:00 Manila); `activeFrom` = the Monday UTC date after the FIRST Sunday that follows the production deploy. Monthly fires 00:00 UTC on the 1st; `activeFrom` = the 2nd of the first month that starts after the deploy. Default (deploy before Sunday 2026-10-04 23:00 UTC): weekly **`2026-10-05`**, monthly **`2026-11-02`**. If the merge slips, compute: `node -e 'const d=new Date(process.argv[1]+"T00:00:00Z");const s=new Date(d);s.setUTCDate(d.getUTCDate()+((7-d.getUTCDay())%7||7));s.setUTCDate(s.getUTCDate()+1);console.log("weekly",s.toISOString().slice(0,10));const m=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,2));console.log("monthly",m.toISOString().slice(0,10))' <deploy-date-YYYY-MM-DD>` and use those two dates in Steps 3 and 5.

- [ ] **Step 2: Write the failing schedule tests.** In `cron-schedule.test.ts`: in "does not guess at a shape it cannot read" replace `"0 9 1 * *"` with `"0 9 29 * *"`, and add `"0 9 1 * 1"`, `"0 9 1 1 *"`, `"0 9 0 * *"`; add:

```ts
  it("reads a monthly run on one day of the month, moving the day forward when the Manila shift crosses midnight", () => {
    expect(describeCronSchedule("0 0 1 * *")).toBe("On the 1st of every month at 8:00 AM");
    expect(describeCronSchedule("0 9 1 * *")).toBe("On the 1st of every month at 5:00 PM");
    expect(describeCronSchedule("0 16 1 * *")).toBe("On the 2nd of every month at 12:00 AM");
    expect(describeCronSchedule("30 20 2 * *")).toBe("On the 3rd of every month at 4:30 AM");
    expect(describeCronSchedule("0 20 11 * *")).toBe("On the 12th of every month at 4:00 AM");
    expect(describeCronSchedule("0 20 21 * *")).toBe("On the 22nd of every month at 4:00 AM");
  });
```
and widen the last test's regex to `/^(Every \w+|On the \d{1,2}(st|nd|rd|th) of every month) at \d{1,2}:\d{2} [AP]M$/`. Run `npx vitest run src/lib/ops/cron-schedule.test.ts` → FAIL.

- [ ] **Step 3: Implement the monthly shape** in `cron-schedule.ts`. Update the doc comment's "Only the two shapes" to "the three shapes the clinic uses: daily, weekly on one weekday, monthly on one day (1–28)". Add above `describeCronSchedule`:

```ts
function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}
```
and replace the day-of-month/month guard + tail of `describeCronSchedule`:

```ts
  const [min, hour, dayOfMonth, month, dayOfWeek] = fields;
  const minute = inRange(min, 59);
  const hourUtc = inRange(hour, 23);
  if (minute === null || hourUtc === null || month !== "*") return fallback;

  const manila = hourUtc * 60 + minute + MANILA_OFFSET_MINUTES;
  const dayShift = Math.floor(manila / MINUTES_PER_DAY);
  const at = clockTime(manila % MINUTES_PER_DAY);

  if (dayOfMonth !== "*") {
    // Monthly on one day. Days 29–31 are not read: a short month would skip the run.
    const day = inRange(dayOfMonth, 28);
    if (day === null || day < 1 || dayOfWeek !== "*") return fallback;
    return `On the ${ordinal(day + dayShift)} of every month at ${at}`;
  }
  if (dayOfWeek === "*") return `Every day at ${at}`;
  // Cron allows both 0 and 7 for Sunday.
  const weekday = inRange(dayOfWeek, 7);
  if (weekday === null) return fallback;
  return `Every ${WEEKDAYS[(weekday + dayShift) % 7]} at ${at}`;
```
(`"0 9 29 * *"` → `inRange(...,28)` null → fallback ✓; `"0 9 0 * *"` → day 0 → fallback ✓.) Run the schedule test → PASS.

- [ ] **Step 4: Write the cron entries.** In `cron-heartbeats.ts` append to `CRON_HEARTBEATS` (after `stale-bookings`):

```ts
  {
    key: "patient-sources-weekly",
    label: "Patient sources email (weekly)",
    description: "Emails admins a Monday summary of last week's new patients by channel, revenue, referrers and cost per new patient.",
    path: "/api/cron/patient-sources-weekly",
    schedule: "0 23 * * 0",
    actions: ["system.patient_sources_weekly.completed"],
    maxAge: 8 * 24 * 60 * 60 * 1000,
    activeFrom: "2026-10-05",
  },
  {
    key: "patient-sources-monthly",
    label: "Patient sources email (monthly)",
    description: "Emails admins a summary on the 1st of last month's new patients by channel, revenue, referrers and cost per new patient.",
    path: "/api/cron/patient-sources-monthly",
    schedule: "0 0 1 * *",
    actions: ["system.patient_sources_monthly.completed"],
    maxAge: 32 * 24 * 60 * 60 * 1000,
    activeFrom: "2026-11-02",
  },
```
`vercel.json`: append to `crons` (add the comma after the `sheet-sync` block):

```json
    {
      "path": "/api/cron/patient-sources-weekly",
      "schedule": "0 23 * * 0"
    },
    {
      "path": "/api/cron/patient-sources-monthly",
      "schedule": "0 0 1 * *"
    }
```
`cron-watchdog.yml`: change the stale comment `# Source: vercel.json (eight schedules across seven routes).` to `# Source: vercel.json (eleven schedules across ten routes).` (the old "eight schedules across seven routes" was already one short: vercel.json held nine across eight before this PR), and append two rows to `watched` (add the trailing comma to the `stale-bookings` row; keep the 14-space indent):

```
              ('patient-sources-weekly', ARRAY['system.patient_sources_weekly.completed'], interval '8 days', date '2026-10-05', NULL::text),
              ('patient-sources-monthly', ARRAY['system.patient_sources_monthly.completed'], interval '32 days', date '2026-11-02', NULL::text)
```
Also update the sentence `# Daily 30h / weekly 8d allow Vercel jitter…` → `# Daily 30h / weekly 8d / monthly 32d allow Vercel jitter and GitHub scheduling delay.` Run `git grep -n "schedules across"` to confirm no other copy of the count exists.

- [ ] **Step 5: Run the drift guards**

Run: `npx vitest run src/lib/ops 2>&1 | tail -8`
Expected: PASS — `cron-heartbeats.test.ts` (vercel ↔ module ↔ SQL parity, label rules: no `/`, `_`, `?`, `=`, "api" or "cron" in labels/descriptions), `cron-monitor.test.ts` (iterates every entry), `cron-schedule.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ops vercel.json .github/workflows/cron-watchdog.yml
git commit -m "feat(cron): schedule the weekly and monthly Patient Sources emails; describe monthly schedules" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 6: Digest periods, retry validation and spend aggregation (pure)

**Files:** Create `src/lib/marketing/patient-sources-digest.ts` (this task adds everything except the renderer; Task 7 appends it), `src/lib/marketing/patient-sources-digest.test.ts`.

- [ ] **Step 1: Write the failing tests** `src/lib/marketing/patient-sources-digest.test.ts`

```ts
import { describe, expect, it } from "vitest";
import {
  aggregateSpend,
  DIGEST_ALERT_KEY,
  digestPeriods,
  periodEnd,
  retryPeriodError,
  spendIn,
} from "./patient-sources-digest";

describe("digestPeriods", () => {
  it("weekly on a Monday: the Mon–Sun week just ended, against the week before", () => {
    expect(digestPeriods("week", "2026-10-05")).toEqual({
      cur: { from: "2026-09-28", to: "2026-10-04" },
      prev: { from: "2026-09-21", to: "2026-09-27" },
      tooEarly: false,
    });
  });
  it("monthly on the 1st: the month just ended, against the month before", () => {
    expect(digestPeriods("month", "2026-10-01")).toEqual({
      cur: { from: "2026-09-01", to: "2026-09-30" },
      prev: { from: "2026-08-01", to: "2026-08-31" },
      tooEarly: false,
    });
  });
  it("is leap-February and year-boundary safe", () => {
    expect(digestPeriods("month", "2024-03-01").cur).toEqual({ from: "2024-02-01", to: "2024-02-29" });
    expect(digestPeriods("month", "2024-03-01").prev).toEqual({ from: "2024-01-01", to: "2024-01-31" });
    expect(digestPeriods("month", "2027-01-01").cur).toEqual({ from: "2026-12-01", to: "2026-12-31" });
    expect(digestPeriods("week", "2027-01-04").cur).toEqual({ from: "2026-12-28", to: "2027-01-03" });
  });
  it("drops the comparison (null) when the period before starts before Patient Sources' first date", () => {
    const m = digestPeriods("month", "2024-01-01"); // current = Dec 2023, previous would be Nov 2023
    expect(m.cur).toEqual({ from: "2023-12-01", to: "2023-12-31" });
    expect(m.prev).toBeNull();
    expect(m.tooEarly).toBe(false);
    const w = digestPeriods("week", "2023-12-11"); // current = Mon 4 Dec, previous = Mon 27 Nov
    expect(w.cur).toEqual({ from: "2023-12-04", to: "2023-12-10" });
    expect(w.prev).toBeNull();
    expect(w.tooEarly).toBe(false);
  });
  it("is too_early when the CURRENT period starts before the first date", () => {
    expect(digestPeriods("month", "2023-12-15").tooEarly).toBe(true); // Nov 2023
    expect(digestPeriods("week", "2023-12-04")).toMatchObject({ cur: { from: "2023-11-27", to: "2023-12-03" }, prev: null, tooEarly: true });
  });
});

describe("periodEnd", () => {
  it("is Sunday for a week and the last day for a month", () => {
    expect(periodEnd("week", "2026-09-28")).toBe("2026-10-04");
    expect(periodEnd("month", "2024-02-01")).toBe("2024-02-29");
    expect(periodEnd("month", "2026-12-01")).toBe("2026-12-31");
  });
});

describe("retryPeriodError (?period_from=)", () => {
  it("accepts a finished Monday week / 1st-of-month period not older than 62 days", () => {
    expect(retryPeriodError("week", "2026-10-05", "2026-10-12")).toBeNull();
    expect(retryPeriodError("month", "2026-10-01", "2026-12-02")).toBeNull(); // 61 days old
    expect(retryPeriodError("month", "2026-10-01", "2026-12-03")).toBeNull(); // exactly 62
  });
  it("refuses a period that is more than 62 days old (measured from its start)", () => {
    expect(retryPeriodError("month", "2026-10-01", "2026-12-04")).toMatch(/62 days/);
    expect(retryPeriodError("week", "2026-07-27", "2026-10-12")).toMatch(/62 days/);
  });
  it("refuses a period that has not finished", () => {
    expect(retryPeriodError("week", "2026-10-12", "2026-10-12")).toMatch(/not finished/);
    expect(retryPeriodError("week", "2026-10-12", "2026-10-18")).toMatch(/not finished/); // ends today
    expect(retryPeriodError("month", "2026-10-01", "2026-10-31")).toMatch(/not finished/);
  });
  it("refuses a start that is not a Monday (weekly) or the 1st (monthly)", () => {
    expect(retryPeriodError("week", "2026-10-07", "2026-10-20")).toMatch(/Monday/);
    expect(retryPeriodError("month", "2026-10-05", "2026-11-20")).toMatch(/1st/);
  });
  it("refuses something that is not a real date", () => {
    expect(retryPeriodError("month", "banana", "2026-11-20")).toMatch(/real date/);
    expect(retryPeriodError("month", "2026-02-31", "2026-11-20")).toMatch(/real date/);
  });
});

describe("aggregateSpend", () => {
  it("sums per date × platform in whole cents and sorts by date then platform", () => {
    const out = aggregateSpend([
      { spend_date: "2026-09-29", platform: "meta", spend_php: "7.5" },
      { spend_date: "2026-09-28", platform: "meta", spend_php: 10.1 },
      { spend_date: "2026-09-28", platform: "meta", spend_php: 0.2 },
      { spend_date: "2026-09-28", platform: "google", spend_php: 5 },
    ]);
    expect(out).toEqual([
      { spend_date: "2026-09-28", platform: "google", spend_php: 5 },
      { spend_date: "2026-09-28", platform: "meta", spend_php: 10.3 },
      { spend_date: "2026-09-29", platform: "meta", spend_php: 7.5 },
    ]);
  });
  it("refuses a platform it does not know rather than dropping its spend", () => {
    expect(() => aggregateSpend([{ spend_date: "2026-09-28", platform: "tiktok", spend_php: 1 }])).toThrow(/platform/);
  });
});

describe("spendIn / keys", () => {
  it("keeps only spend inside the period", () => {
    const rows = [
      { spend_date: "2026-09-27", platform: "meta" as const, spend_php: 1 },
      { spend_date: "2026-09-28", platform: "meta" as const, spend_php: 2 },
      { spend_date: "2026-10-05", platform: "meta" as const, spend_php: 3 },
    ];
    expect(spendIn(rows, { from: "2026-09-28", to: "2026-10-04" })).toEqual([rows[1]]);
  });
  it("maps each period to its alert key", () => {
    expect(DIGEST_ALERT_KEY).toEqual({ week: "patient_sources_weekly", month: "patient_sources_monthly" });
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/lib/marketing/patient-sources-digest.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** `src/lib/marketing/patient-sources-digest.ts` (types, periods, validation, aggregation; the renderer lands in Task 7)

```ts
/**
 * Patient Sources owner email (5b) — the pure half: which periods a digest covers,
 * retry validation, the saved-spend roll-up, and (Task 7) the renderer. Every COUNT
 * comes from the report; nothing here re-derives one. No `server-only`: unit-testable.
 */
import { daysBetweenISO, isISODate, isoDateParts, isoWeekday, lastOfMonthISO, shiftISODate } from "@/lib/dates/manila";
import { PATIENT_SOURCES_MIN_DATE } from "./period";
import {
  comparisonPeriod,
  lastCompletedMonth,
  lastCompletedWeek,
  previousMonth,
  previousWeek,
  type Period,
  type ReferrerRow,
  type RevenueRow,
  type SeriesRow,
  type SpendTotalRow,
  type SummaryRow,
} from "./patient-sources";

export type DigestKind = "week" | "month";
export type DigestAlertKey = "patient_sources_weekly" | "patient_sources_monthly";
export const DIGEST_ALERT_KEY: Record<DigestKind, DigestAlertKey> = {
  week: "patient_sources_weekly",
  month: "patient_sources_monthly",
};

/** One period's figures — each from ONE report call (one snapshot). */
export interface DigestPeriodData {
  period: Period;
  summary: SummaryRow;
  /** Served per day, per channel (the report's `series` at day grain, served mode). */
  servedByDay: SeriesRow[];
  /** New per day, per channel (the report's `new_by_day`). */
  newByDay: SeriesRow[];
  revenue: RevenueRow[];
  referrers: ReferrerRow[];
}

export interface DigestData {
  kind: DigestKind;
  cur: DigestPeriodData;
  /** null when the period before starts before Patient Sources' first date. */
  prev: DigestPeriodData | null;
  /** Saved spend per date × platform over [prev.from ?? cur.from, cur.to]. */
  spend: SpendTotalRow[];
  /** false = the ad-spend table has never held a row ("nothing ever saved"). */
  spendEverSaved: boolean;
  /** When the figures were read — the "Numbers as of" stamp. */
  readAt: Date;
}

/** The last day of a digest period that starts on `from`. */
export function periodEnd(kind: DigestKind, from: string): string {
  if (kind === "week") return shiftISODate(from, 6);
  const { year, month } = isoDateParts(from);
  return lastOfMonthISO(year, month);
}

/**
 * The period a digest sent on `todayISO` covers (the last completed week/month),
 * the period before it (null when it would start before the first date), and
 * `tooEarly` when the CURRENT period itself starts before the first date.
 * A retry for an earlier period passes the day AFTER that period as `todayISO`.
 */
export function digestPeriods(kind: DigestKind, todayISO: string): { cur: Period; prev: Period | null; tooEarly: boolean } {
  const cur = kind === "week" ? lastCompletedWeek(todayISO) : lastCompletedMonth(todayISO);
  const before = kind === "week" ? previousWeek(cur) : previousMonth(cur);
  return { cur, prev: comparisonPeriod(before, PATIENT_SOURCES_MIN_DATE), tooEarly: cur.from < PATIENT_SOURCES_MIN_DATE };
}

export const RETRY_MAX_AGE_DAYS = 62;

/** Why `?period_from=` is not a valid retry target, or null when it is. */
export function retryPeriodError(kind: DigestKind, from: string, todayISO: string): string | null {
  if (!isISODate(from) || shiftISODate(from, 0) !== from) return "period_from must be a real date like 2026-10-05.";
  if (kind === "week" && isoWeekday(from) !== 1) return "period_from must be a Monday for the weekly email.";
  if (kind === "month" && isoDateParts(from).day !== 1) return "period_from must be the 1st of a month for the monthly email.";
  if (periodEnd(kind, from) >= todayISO) return "That period is not finished yet.";
  if (daysBetweenISO(from, todayISO) > RETRY_MAX_AGE_DAYS) return `That period started more than ${RETRY_MAX_AGE_DAYS} days ago.`;
  return null;
}

export interface RawSpendRow {
  spend_date: string;
  platform: string;
  spend_php: number | string;
}

/**
 * Per-ad rows → one total per date × platform, summed in whole cents — the same
 * result the admin-only totals RPC gives (`sum(spend_php)` per date and platform;
 * a test pins the equivalence on a multi-page fixture). An unknown platform throws:
 * dropping it would quietly understate spend.
 */
export function aggregateSpend(rows: readonly RawSpendRow[]): SpendTotalRow[] {
  const totals = new Map<string, { spend_date: string; platform: "meta" | "google"; cents: number }>();
  for (const r of rows) {
    if (r.platform !== "meta" && r.platform !== "google") throw new Error(`ad spend: unknown platform "${r.platform}"`);
    const key = `${r.spend_date}|${r.platform}`;
    const t = totals.get(key) ?? { spend_date: r.spend_date, platform: r.platform, cents: 0 };
    t.cents += Math.round(Number(r.spend_php) * 100);
    totals.set(key, t);
  }
  return [...totals.values()]
    .sort((a, b) => a.spend_date.localeCompare(b.spend_date) || a.platform.localeCompare(b.platform))
    .map((t) => ({ spend_date: t.spend_date, platform: t.platform, spend_php: t.cents / 100 }));
}

/** Spend rows inside a period (cost per new patient must never see the other period's spend). */
export function spendIn(spend: readonly SpendTotalRow[], p: Period): SpendTotalRow[] {
  return spend.filter((s) => s.spend_date >= p.from && s.spend_date <= p.to);
}
```

- [ ] **Step 4: Run** the test → PASS; `npx tsc --noEmit 2>&1 | head -5` → clean (unused-import warnings for `ReferrerRow` etc. are fine — they are used by the types above).

- [ ] **Step 5: Commit**

```bash
git add src/lib/marketing/patient-sources-digest.ts src/lib/marketing/patient-sources-digest.test.ts
git commit -m "feat(sources): owner-email periods, retry validation and ad-spend roll-up" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: The pure renderer `renderPatientSourcesDigest`

**Files:** Modify `src/lib/marketing/patient-sources-digest.ts` (append); Test `src/lib/marketing/patient-sources-digest.test.ts` (append).

- [ ] **Step 1: Write the failing tests** (append; add to the file's imports: `renderPatientSourcesDigest, type DigestData` from `./patient-sources-digest`; `asOfLabel, channelLabel, type SummaryRow` from `./patient-sources`; `formatPhp` from `./format`)

```ts
const SUMMARY: SummaryRow = {
  new_confirmed: 9,
  new_unconfirmed: 3,
  returning_first_recorded: 4,
  served_confirmed: 30,
  served_unconfirmed: 5,
  undated_registrations: 0,
  source_recorded: 40,
  source_total: 45,
  sheet_last_dates: { lab: "2026-10-03", consult: "2026-10-02", customers: "2026-10-01" },
  sync_paused: false,
  last_synced_at: "2026-10-04T10:00:00Z",
  sheet_rows_present: true,
  last_run_status: "succeeded",
};
const sr = (bucket_start: string, channel: string, confirmed: number, unconfirmed = 0) => ({ bucket_start, channel, confirmed, unconfirmed });

function week(over: Partial<DigestData> = {}): DigestData {
  return {
    kind: "week",
    cur: {
      period: { from: "2026-09-28", to: "2026-10-04" },
      summary: { ...SUMMARY },
      servedByDay: [sr("2026-09-29", "walk_in", 10), sr("2026-10-04", "walk_in", 2)],
      newByDay: [sr("2026-09-29", "walk_in", 5, 1), sr("2026-09-30", "online_facebook", 4, 2)],
      revenue: [
        { channel: "walk_in", confirmed_php: 12000, unconfirmed_php: 0 },
        { channel: "online_facebook", confirmed_php: 8000, unconfirmed_php: 0 },
      ],
      referrers: [
        { doctor_label: "Dr. A", new_confirmed: 3, new_unconfirmed: 1 },
        { doctor_label: "Dr. B", new_confirmed: 2, new_unconfirmed: 0 },
      ],
    },
    prev: {
      period: { from: "2026-09-21", to: "2026-09-27" },
      summary: { ...SUMMARY, new_confirmed: 8, new_unconfirmed: 0, returning_first_recorded: 2, served_confirmed: 25, served_unconfirmed: 4 },
      servedByDay: [sr("2026-09-22", "walk_in", 10)],
      newByDay: [sr("2026-09-22", "walk_in", 3), sr("2026-09-23", "online_google", 5)],
      revenue: [{ channel: "walk_in", confirmed_php: 9000, unconfirmed_php: 0 }],
      referrers: [],
    },
    spend: [],
    spendEverSaved: false,
    readAt: new Date("2026-10-04T23:05:00Z"),
    ...over,
  };
}
const render = (d: DigestData) => renderPatientSourcesDigest(d, { appUrl: "https://drmed.ph/" });

describe("renderPatientSourcesDigest — headline", () => {
  it("subject carries the period label, the new count and the change", () => {
    expect(render(week()).subject).toBe("Patient sources, Wk of 28 Sep: 12 new (▲ 4)");
  });
  it("says = 0 for no change and ▼ for a fall", () => {
    const flat = week();
    flat.prev!.summary = { ...SUMMARY };
    expect(render(flat).subject).toBe("Patient sources, Wk of 28 Sep: 12 new (= 0)");
    const down = week();
    down.prev!.summary = { ...SUMMARY, new_confirmed: 20, new_unconfirmed: 0 };
    expect(render(down).subject).toBe("Patient sources, Wk of 28 Sep: 12 new (▼ 8)");
  });
  it("without a comparison the subject has no change and the headline says so", () => {
    const out = render(week({ prev: null }));
    expect(out.subject).toBe("Patient sources, Wk of 28 Sep: 12 new");
    expect(out.text).toContain("no comparison");
    expect(out.html).not.toContain(">Before<");
  });
  it("shows new / served / returning with their changes", () => {
    const { text } = render(week());
    expect(text).toContain("New patients: 12 (9 confirmed · 3 unconfirmed) · ▲ 4");
    expect(text).toContain("Served: 35 · ▲ 6");
    expect(text).toContain("Returning (first recorded): 4 · ▲ 2");
  });
  it("zero new patients keeps served, revenue and the rest, and says so plainly", () => {
    const d = week();
    d.cur.summary = { ...SUMMARY, new_confirmed: 0, new_unconfirmed: 0 };
    d.cur.newByDay = [];
    d.prev = null;
    const { text } = render(d);
    expect(text).toContain("No new patients recorded this week");
    expect(text).toContain("Served: 35");
    expect(text).toContain("Revenue by channel");
  });
  it("monthly wording and label", () => {
    const d = week({ kind: "month" });
    d.cur.period = { from: "2026-09-01", to: "2026-09-30" };
    d.prev!.period = { from: "2026-08-01", to: "2026-08-31" };
    const out = render(d);
    expect(out.subject).toBe("Patient sources, Sep 2026: 12 new (▲ 4)");
    expect(out.text).toContain("this month");
    expect(out.text).not.toContain("Sun (half day)");
  });
});

describe("renderPatientSourcesDigest — movers and Sunday", () => {
  it("names the biggest mover", () => {
    expect(render(week()).text).toContain(`Biggest mover: ${channelLabel("online_facebook")} ▲ 6 (6 now, 0 before).`);
  });
  it("says no channel moved by more than 2 when none did", () => {
    const d = week();
    d.prev!.newByDay = [sr("2026-09-22", "walk_in", 6), sr("2026-09-23", "online_facebook", 6)];
    expect(render(d).text).toContain("No channel moved by more than 2.");
  });
  it("reports Sunday activity as an observation when the week before had none", () => {
    expect(render(week()).text).toContain("Sunday activity was recorded this week (2 served); none was recorded on Sunday the week before.");
    const d = week();
    d.prev!.servedByDay = [sr("2026-09-27", "walk_in", 1)];
    expect(render(d).text).not.toContain("Sunday activity was recorded");
  });
  it("the weekly day rows label Sunday as a half day and never add daily served counts into a total", () => {
    const out = render(week());
    expect(out.html).toContain("Sun (half day)");
    expect(out.text).toContain("Served that day");
    expect(out.text).toContain("not added up");
  });
});

describe("renderPatientSourcesDigest — channels, revenue, referrers", () => {
  it("lists a channel that fell to zero, in table order, with its change", () => {
    const { text } = render(week());
    expect(text).toContain(`${channelLabel("online_google")} | 0 | 5 | -5`);
    expect(text).toContain(`${channelLabel("walk_in")} | 6 | 3 | +3`);
  });
  it("revenue: confirmed only unless something is unconfirmed; total against before", () => {
    const base = render(week());
    expect(base.html).not.toContain(">Unconfirmed<");
    expect(base.text).toContain(`Total ${formatPhp(20000)}, before ${formatPhp(9000)} (▲ ${formatPhp(11000)})`);
    const d = week();
    d.cur.revenue[0] = { channel: "walk_in", confirmed_php: 12000, unconfirmed_php: 500 };
    expect(render(d).html).toContain(">Unconfirmed<");
  });
  it("top 5 referrers, busiest first; a sentence when there are none", () => {
    const d = week();
    d.cur.referrers = Array.from({ length: 7 }, (_, i) => ({ doctor_label: `Dr. ${"ABCDEFG"[i]}`, new_confirmed: 7 - i, new_unconfirmed: 0 }));
    const { text } = render(d);
    expect(text).toContain("Dr. A | 7");
    expect(text).toContain("Dr. E | 3");
    expect(text).not.toContain("Dr. F");
    d.cur.referrers = [];
    expect(render(d).text).toContain("No referring doctor recorded this week.");
  });
  it("escapes dynamic strings in html and leaves text raw", () => {
    const d = week();
    d.cur.referrers = [{ doctor_label: "<b>Dr. X</b>", new_confirmed: 2, new_unconfirmed: 0 }];
    const out = render(d);
    expect(out.html).toContain("&lt;b&gt;Dr. X&lt;/b&gt;");
    expect(out.html).not.toContain("<b>Dr. X</b>");
    expect(out.text).toContain("<b>Dr. X</b> | 2");
  });
});

describe("renderPatientSourcesDigest — cost per new patient", () => {
  const noMoneyZero = (s: string) => expect(s).not.toMatch(/₱0(?![.,\d])/);
  it("with no spend in the period says so, never ₱0 — and points at Ad Performance when nothing was ever saved", () => {
    const out = render(week());
    expect(out.text).toContain("No ad spend saved for this week.");
    expect(out.text).toContain("Ad spend is saved from Ad Performance → Save them to clinic records.");
    noMoneyZero(out.html);
    noMoneyZero(out.text);
    const saved = render(week({ spendEverSaved: true }));
    expect(saved.text).toContain("No ad spend saved for this week.");
    expect(saved.text).not.toContain("Ad spend is saved from Ad Performance");
  });
  it("with spend shows spend, new on spend days and the cost per platform", () => {
    const d = week({
      spend: [
        { spend_date: "2026-09-29", platform: "meta", spend_php: 600 },
        { spend_date: "2026-09-30", platform: "meta", spend_php: 400 },
        { spend_date: "2026-09-22", platform: "meta", spend_php: 500 },
      ],
      spendEverSaved: true,
    });
    const { text } = render(d);
    expect(text).toContain(formatPhp(1000));
    expect(text).toContain(formatPhp(166.67)); // 1,000 over the 6 Facebook patients who joined on spend days
    expect(text).not.toContain("No ad spend saved");
  });
});

describe("renderPatientSourcesDigest — data health, footer", () => {
  it("says nothing when the sheet is included and current", () => {
    const { text } = render(week());
    expect(text).not.toContain("Sheet data is not included yet");
    expect(text).not.toContain("Latest service date in the sheet");
  });
  it("explains each state the page explains, with the sheet dates under it", () => {
    const none = week();
    none.cur.summary = { ...SUMMARY, sheet_rows_present: false };
    expect(render(none).text).toContain("Sheet data is not included yet");
    const partial = week();
    partial.cur.summary = { ...SUMMARY, last_run_status: "partial" };
    const p = render(partial).text;
    expect(p).toContain("did not finish every tab");
    expect(p).toContain("Latest service date in the sheet: Lab");
    const paused = week();
    paused.cur.summary = { ...SUMMARY, sync_paused: true };
    expect(render(paused).text).toContain("The sheet sync is paused");
  });
  it("ends with the stamp, the button and the fine print", () => {
    const out = render(week());
    expect(out.text).toContain(asOfLabel(new Date("2026-10-04T23:05:00Z")));
    expect(out.text).toContain("https://drmed.ph/staff/marketing/patients?from=2026-09-28&to=2026-10-04&grain=day&mode=new");
    expect(out.html).toContain("from=2026-09-28&amp;to=2026-10-04");
    expect(out.html).toContain("Open Patient Sources");
    expect(out.text).toContain("Confirmed counts are patient records.");
    expect(out.text).toContain("You get this as an admin; change it in Admin Tools › Email Alerts.");
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/lib/marketing/patient-sources-digest.test.ts` → FAIL (`renderPatientSourcesDigest` not exported).

- [ ] **Step 3: Implement.** Extend the top-of-file imports of `patient-sources-digest.ts`:

```ts
import {
  daysBetweenISO, isISODate, isoDateParts, isoWeekday, lastOfMonthISO, manilaDate, shiftISODate,
} from "@/lib/dates/manila";
import { emailButton, emailDetailBox, emailFinePrint, emailParagraph, escapeHtml, renderEmailShell } from "@/lib/notifications/branded-email";
import { formatPhp } from "./format";
import { PATIENT_SOURCES_MIN_DATE } from "./period";
import {
  asOfLabel, biggestMover, bucketLabel, channelDeltas, channelLabel, channelTable, comparisonPeriod, costPerNewPatient,
  formatNewCounts, lastCompletedMonth, lastCompletedWeek, previousMonth, previousWeek, sheetBanner, sheetDatesText,
  sundayObservation, type Period, type ReferrerRow, type RevenueRow, type SeriesRow, type SpendTotalRow, type SummaryRow,
} from "./patient-sources";
```
(replace the Task 6 import blocks with these) and append:

```ts
// ---------------------------------------------------------------------------
// Renderer — one list of blocks, rendered to html (inline styles) AND plain text
// ---------------------------------------------------------------------------

interface Block {
  html: string;
  text: string;
}

const NAVY = "#263F91";
const SOFT = "#6b7280";
const INK = "#1a2537";
const RULE = "#e5eaf2";
const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun (half day)"] as const;

const n = (x: number) => x.toLocaleString("en-PH");
const newTotal = (s: SummaryRow) => s.new_confirmed + s.new_unconfirmed;
const servedTotal = (s: SummaryRow) => s.served_confirmed + s.served_unconfirmed;
const signed = (x: number) => (x > 0 ? `+${n(x)}` : x < 0 ? `-${n(Math.abs(x))}` : "0");

function deltaText(now: number, before: number | null): string {
  if (before === null) return "no comparison";
  const change = now - before;
  return change === 0 ? "= no change" : `${change > 0 ? "▲" : "▼"} ${n(Math.abs(change))}`;
}
function moneyDelta(now: number, before: number): string {
  const change = now - before;
  return change === 0 ? "= no change" : `${change > 0 ? "▲" : "▼"} ${formatPhp(Math.abs(change))}`;
}

const heading = (title: string): Block => ({
  html: `<h3 style="margin:24px 0 6px;font-size:16px;color:${NAVY};">${escapeHtml(title)}</h3>`,
  text: `\n${title}`,
});
const para = (t: string): Block => ({ html: emailParagraph(escapeHtml(t)), text: t });
const fine = (t: string): Block => ({ html: emailFinePrint(escapeHtml(t)), text: t });
const detail = (rows: Array<{ label: string; value: string }>): Block => ({
  html: emailDetailBox(rows),
  text: rows.map((r) => `${r.label}: ${r.value}`).join("\n"),
});

function table(head: readonly string[], rows: readonly (readonly string[])[]): Block {
  const cell = (v: string, i: number, tag: "th" | "td") =>
    `<${tag} align="${i === 0 ? "left" : "right"}" style="padding:6px 8px;font-size:13px;border-bottom:1px solid ${RULE};${
      tag === "th" ? `color:${SOFT};font-weight:600;` : ""
    }">${escapeHtml(v)}</${tag}>`;
  const html =
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 14px;color:${INK};border-collapse:collapse;">` +
    `<tr>${head.map((h, i) => cell(h, i, "th")).join("")}</tr>` +
    rows.map((r) => `<tr>${r.map((v, i) => cell(v, i, "td")).join("")}</tr>`).join("") +
    `</table>`;
  return { html, text: [head, ...rows].map((r) => r.join(" | ")).join("\n") };
}

const sumDay = (rows: readonly SeriesRow[], day: string) =>
  rows.filter((r) => r.bucket_start === day).reduce((s, r) => s + Number(r.confirmed) + Number(r.unconfirmed), 0);

function revenueBlocks(cur: DigestPeriodData, prev: DigestPeriodData | null, unit: DigestKind): Block[] {
  const total = (rows: readonly RevenueRow[]) => rows.reduce((s, r) => s + Number(r.confirmed_php) + Number(r.unconfirmed_php), 0);
  const curTotal = total(cur.revenue);
  const prevTotal = prev ? total(prev.revenue) : null;
  if (curTotal === 0 && (prevTotal === null || prevTotal === 0)) return [];
  const out: Block[] = [heading("Revenue by channel")];
  const rows = cur.revenue
    .map((r) => ({ r, sum: Number(r.confirmed_php) + Number(r.unconfirmed_php) }))
    .filter((x) => x.sum > 0)
    .sort((a, b) => b.sum - a.sum || channelLabel(a.r.channel).localeCompare(channelLabel(b.r.channel)));
  const hasUnconfirmed = cur.revenue.some((r) => Number(r.unconfirmed_php) > 0);
  if (rows.length === 0) out.push(para(`No revenue by channel was recorded this ${unit}.`));
  else {
    out.push(
      table(
        hasUnconfirmed ? ["Channel", "Confirmed", "Unconfirmed"] : ["Channel", "Confirmed"],
        rows.map(({ r }) =>
          hasUnconfirmed
            ? [channelLabel(r.channel), formatPhp(Number(r.confirmed_php)), formatPhp(Number(r.unconfirmed_php))]
            : [channelLabel(r.channel), formatPhp(Number(r.confirmed_php))],
        ),
      ),
    );
  }
  out.push(
    para(
      `Total${hasUnconfirmed ? " (confirmed + unconfirmed)" : ""} ${formatPhp(curTotal)}` +
        (prevTotal === null ? " (no comparison)." : `, before ${formatPhp(prevTotal)} (${moneyDelta(curTotal, prevTotal)}).`),
    ),
  );
  return out;
}

function costBlocks(data: DigestData): Block[] {
  const unit = data.kind;
  const cur = costPerNewPatient(spendIn(data.spend, data.cur.period), data.cur.newByDay).filter((r) => r.days > 0);
  const out: Block[] = [heading("Cost per new patient")];
  if (cur.length === 0) {
    out.push(para(`No ad spend saved for this ${unit}.`));
    if (!data.spendEverSaved) out.push(fine("Ad spend is saved from Ad Performance → Save them to clinic records."));
    return out;
  }
  const before = data.prev
    ? new Map(costPerNewPatient(spendIn(data.spend, data.prev.period), data.prev.newByDay).map((r) => [r.platform, r]))
    : null;
  const cost = (r: { days: number; costPerNewPhp: number | null }) =>
    r.days === 0 ? "no spend saved" : r.costPerNewPhp === null ? "no new patients" : formatPhp(r.costPerNewPhp);
  out.push(
    table(
      data.prev ? ["Platform", "Spend", "New on spend days", "Cost per new", "Before"] : ["Platform", "Spend", "New on spend days", "Cost per new"],
      cur.map((r) => {
        const row = [r.label, formatPhp(r.spendPhp), n(r.newConfirmed + r.newUnconfirmed), cost(r)];
        if (data.prev) row.push(before!.get(r.platform) ? cost(before!.get(r.platform)!) : "no spend saved");
        return row;
      }),
    ),
  );
  return out;
}

/** "Patient sources, Wk of 28 Sep: 12 new (▲ 4)" — the change is left out when there is no comparison. */
export function digestSubject(data: DigestData): string {
  const label = bucketLabel(data.kind, data.cur.period.from);
  const now = newTotal(data.cur.summary);
  if (!data.prev) return `Patient sources, ${label}: ${n(now)} new`;
  const change = now - newTotal(data.prev.summary);
  return `Patient sources, ${label}: ${n(now)} new (${change > 0 ? "▲" : change < 0 ? "▼" : "="} ${n(Math.abs(change))})`;
}

export function renderPatientSourcesDigest(
  data: DigestData,
  opts: { appUrl: string },
): { subject: string; html: string; text: string } {
  const unit = data.kind;
  const { cur, prev } = data;
  const subject = digestSubject(data);
  const blocks: Block[] = [];

  blocks.push(
    para(
      `${manilaDate(cur.period.from)} to ${manilaDate(cur.period.to)}` +
        (prev ? `, compared with ${manilaDate(prev.period.from)} to ${manilaDate(prev.period.to)}.` : ". No comparison is available for this period."),
    ),
  );

  // Data health: the page's own banner condition and wording, the sheet dates under it.
  const banner = sheetBanner(cur.summary);
  if (banner) {
    blocks.push(para(banner));
    const dates = sheetDatesText(cur.summary).trim();
    if (dates) blocks.push(fine(dates));
  }

  // Headline.
  const newNow = newTotal(cur.summary);
  const newBefore = prev ? newTotal(prev.summary) : null;
  const newValue =
    newNow === 0 && (newBefore === null || newBefore === 0)
      ? `No new patients recorded this ${unit}`
      : `${n(newNow)} (${formatNewCounts(cur.summary.new_confirmed, cur.summary.new_unconfirmed)}) · ${deltaText(newNow, newBefore)}`;
  blocks.push(
    detail([
      { label: "New patients", value: newValue },
      { label: "Served", value: `${n(servedTotal(cur.summary))} · ${deltaText(servedTotal(cur.summary), prev ? servedTotal(prev.summary) : null)}` },
      {
        label: "Returning (first recorded)",
        value: `${n(cur.summary.returning_first_recorded)} · ${deltaText(cur.summary.returning_first_recorded, prev ? prev.summary.returning_first_recorded : null)}`,
      },
    ]),
  );

  if (prev) {
    const mover = biggestMover(channelDeltas(cur.newByDay, prev.newByDay));
    blocks.push(
      para(
        mover
          ? `Biggest mover: ${mover.label} ${mover.change > 0 ? "▲" : "▼"} ${n(Math.abs(mover.change))} (${n(mover.now)} now, ${n(mover.before)} before${
              mover.pct === null ? "" : `, ${mover.pct > 0 ? "+" : "-"}${Math.round(Math.abs(mover.pct) * 100)}%`
            }).`
          : "No channel moved by more than 2.",
      ),
    );
  }
  const sunday = sundayObservation(cur.servedByDay, prev ? prev.servedByDay : null, unit);
  if (sunday) blocks.push(para(sunday));

  // Weekly day row. Daily served counts are never summed into a total.
  if (data.kind === "week") {
    const days = Array.from({ length: 7 }, (_, i) => shiftISODate(cur.period.from, i));
    const newRow = days.map((d) => sumDay(cur.newByDay, d));
    const servedRow = days.map((d) => sumDay(cur.servedByDay, d));
    if ([...newRow, ...servedRow].some((v) => v > 0)) {
      blocks.push(heading("By day"));
      blocks.push(table(["", ...DAY_LABELS], [["New", ...newRow.map(n)], ["Served that day", ...servedRow.map(n)]]));
      blocks.push(fine("Daily served counts are not added up: the served total above counts a repeat visitor once."));
    }
  }

  // New by channel — every channel non-zero in either period, in channel-table order.
  const channels = channelTable(cur.newByDay, prev ? prev.newByDay : null).filter((r) => r.total > 0 || (r.previousTotal ?? 0) > 0);
  if (channels.length > 0) {
    blocks.push(heading("New patients by channel"));
    blocks.push(
      table(
        prev ? ["Channel", `This ${unit}`, "Before", "Change"] : ["Channel", `This ${unit}`],
        channels.map((r) =>
          prev ? [r.label, n(r.total), n(r.previousTotal ?? 0), signed(r.change ?? 0)] : [r.label, n(r.total)],
        ),
      ),
    );
  }

  blocks.push(...revenueBlocks(cur, prev, unit));

  // Top 5 referrers.
  blocks.push(heading("Top referring doctors"));
  const refs = cur.referrers
    .map((r) => ({ label: r.doctor_label, n: r.new_confirmed + r.new_unconfirmed }))
    .filter((r) => r.n > 0)
    .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label))
    .slice(0, 5);
  blocks.push(refs.length > 0 ? table(["Doctor", "New"], refs.map((r) => [r.label, n(r.n)])) : para(`No referring doctor recorded this ${unit}.`));

  blocks.push(...costBlocks(data));

  // Footer: stamp, button, fine print.
  const url =
    `${opts.appUrl.replace(/\/$/, "")}/staff/marketing/patients` +
    `?from=${cur.period.from}&to=${cur.period.to}&grain=day&mode=new`;
  blocks.push(fine(asOfLabel(data.readAt)));
  blocks.push({ html: emailButton("Open Patient Sources", url), text: `Open Patient Sources: ${url}` });
  blocks.push(fine("Confirmed counts are patient records. Unconfirmed counts are names in the reception sheet not yet matched to a patient record."));
  blocks.push(fine("You get this as an admin; change it in Admin Tools › Email Alerts."));

  return {
    subject,
    html: renderEmailShell({ heading: `Patient sources: ${bucketLabel(unit, cur.period.from)}`, contentHtml: blocks.map((b) => b.html).join("") }),
    text: [subject, ...blocks.map((b) => b.text)].join("\n\n"),
  };
}
```

- [ ] **Step 4: Run** `npx vitest run src/lib/marketing/patient-sources-digest.test.ts` → PASS. If an assertion on `formatPhp(...)` text differs by locale spacing, fix the test to build its expectation with `formatPhp` (never hard-code a ₱ string). Then `npx tsc --noEmit 2>&1 | head` and `npx eslint src/lib/marketing/patient-sources-digest.ts` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/marketing/patient-sources-digest.ts src/lib/marketing/patient-sources-digest.test.ts
git commit -m "feat(sources): owner-email renderer (html + plain text, per-section empty states)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 8: Data gathering — `loadPatientSourcesDigest`, spend paging, `buildPatientSourcesDigestEmail`

**Placement decision (the loader-module question).** The digest data module reads the report ONLY through `loadPatientSourcesReport` (imported from `@/lib/marketing/patient-sources.server`, the one module allowed to name the RPCs), so `patient-sources-surfaces.test.ts`'s "only the loader module names the report RPCs" scan stays untouched — it names no RPC at all, not even in a comment. It is added to the surfaces test's `SURFACES` map (so it is pinned to the shared loader) rather than to the `CALLERS` allow-list. The ad-spend read is a direct `.from("ad_spend_daily")` table read (a table, not an RPC).

**Files:** Create `src/lib/marketing/patient-sources-digest.server.ts`, `src/lib/marketing/patient-sources-digest.server.test.ts`; Modify `src/lib/marketing/patient-sources-surfaces.test.ts`.

- [ ] **Step 1: Write the failing tests** `src/lib/marketing/patient-sources-digest.server.test.ts`

```ts
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const loadReport = vi.hoisted(() => vi.fn());
vi.mock("@/lib/marketing/patient-sources.server", () => ({ loadPatientSourcesReport: loadReport }));

import { shiftISODate } from "@/lib/dates/manila";
import type { PatientSourcesReport, SummaryRow } from "./patient-sources";
import { buildPatientSourcesDigestEmail, loadPatientSourcesDigest, readSpend } from "./patient-sources-digest.server";

const SUMMARY: SummaryRow = {
  new_confirmed: 9, new_unconfirmed: 3, returning_first_recorded: 4, served_confirmed: 30, served_unconfirmed: 5,
  undated_registrations: 0, source_recorded: 40, source_total: 45, sheet_last_dates: {}, sync_paused: false,
  last_synced_at: null, sheet_rows_present: true, last_run_status: "succeeded",
};
const report = (): PatientSourcesReport => ({
  summary: { ...SUMMARY }, series: [], current: [], previous: null, new_by_day: [], revenue: [], overlaps: [], referrers: [],
});

interface Row { spend_date: string; platform: "meta" | "google"; campaign_key: string; ad_key: string; spend_php: number; cents: number }
interface Rec { orders: string[]; ranges: Array<[number, number]>; bounds: Array<[string, string]>; counts: number }

/** Just enough of the service-role client: select/gte/lte/order/range/returns, and head-count selects. */
function fakeAdmin(table: () => Row[]) {
  const rec: Rec = { orders: [], ranges: [], bounds: [], counts: 0 };
  const from = (name: string) => {
    if (name !== "ad_spend_daily") throw new Error(`unexpected table ${name}`);
    return {
      select(_cols: string, opts?: { count?: string; head?: boolean }) {
        let lo = "0000-00-00";
        let hi = "9999-99-99";
        const orders: string[] = [];
        let range: [number, number] | null = null;
        const run = () => {
          const rows = table().filter((r) => r.spend_date >= lo && r.spend_date <= hi);
          if (lo !== "0000-00-00") rec.bounds.push([lo, hi]);
          if (opts?.head) {
            rec.counts += 1;
            return { count: rows.length, data: null, error: null };
          }
          const sorted = [...rows].sort((a, b) => {
            for (const c of orders) {
              const x = String(a[c as keyof Row]);
              const y = String(b[c as keyof Row]);
              if (x !== y) return x < y ? -1 : 1;
            }
            return 0;
          });
          return { count: null, data: range ? sorted.slice(range[0], range[1] + 1) : sorted, error: null };
        };
        const b: Record<string, unknown> = {
          gte: (_c: string, v: string) => {
            lo = v;
            return b;
          },
          lte: (_c: string, v: string) => {
            hi = v;
            return b;
          },
          order: (c: string) => {
            orders.push(c);
            rec.orders.push(c);
            return b;
          },
          range: (a: number, z: number) => {
            range = [a, z];
            rec.ranges.push([a, z]);
            return b;
          },
          returns: () => b,
          then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad),
        };
        return b;
      },
    };
  };
  return { admin: { from } as never, rec };
}

/** 14 days × 2 platforms × 9 campaigns × 9 ads = 2,268 rows: repeated dates/platforms, distinct keys, > 2 pages. */
function bigSpend(): Row[] {
  const out: Row[] = [];
  let i = 0;
  for (let d = 0; d < 14; d++)
    for (const platform of ["meta", "google"] as const)
      for (let c = 0; c < 9; c++)
        for (let a = 0; a < 9; a++) {
          const cents = 1000 + (i % 7) * 37 + (i % 3);
          out.push({ spend_date: shiftISODate("2026-09-21", d), platform, campaign_key: `c${c}`, ad_key: `a${a}`, spend_php: cents / 100, cents });
          i++;
        }
  // a deterministic scramble, so a loader that forgot ORDER BY would page wrongly
  return out.map((r, k) => [(k * 7919) % out.length, r] as const).sort((x, y) => x[0] - y[0]).map(([, r]) => r);
}

beforeEach(() => {
  loadReport.mockReset();
});

describe("readSpend", () => {
  it("pages the table under a total order and totals exactly like the admin-only totals (per date × platform)", async () => {
    const rows = bigSpend();
    const { admin, rec } = fakeAdmin(() => rows);
    const out = await readSpend(admin, { from: "2026-09-21", to: "2026-10-04" });

    const ref = new Map<string, number>();
    for (const r of rows) ref.set(`${r.spend_date}|${r.platform}`, (ref.get(`${r.spend_date}|${r.platform}`) ?? 0) + r.cents);
    const expected = [...ref.entries()]
      .map(([k, cents]) => ({ spend_date: k.split("|")[0]!, platform: k.split("|")[1] as "meta" | "google", spend_php: cents / 100 }))
      .sort((a, b) => a.spend_date.localeCompare(b.spend_date) || a.platform.localeCompare(b.platform));
    expect(out).toEqual(expected);
    expect(out).toHaveLength(28);

    expect(rec.ranges.length).toBeGreaterThanOrEqual(3); // more than one 1,000-row page
    expect(rec.orders.length % 4).toBe(0);
    for (let i = 0; i < rec.orders.length; i += 4) {
      expect(rec.orders.slice(i, i + 4)).toEqual(["spend_date", "platform", "campaign_key", "ad_key"]); // the table's full unique key
    }
  });

  it("re-reads once when the row count moves during the read, and uses the stable second read", async () => {
    const a = bigSpend().slice(0, 100);
    const b = bigSpend().slice(0, 101);
    let runs = 0;
    const { admin } = fakeAdmin(() => (++runs <= 2 ? a : b)); // count, page, then the import lands before the second count
    const out = await readSpend(admin, { from: "2026-09-21", to: "2026-10-04" });
    expect(out.reduce((s, r) => s + Math.round(r.spend_php * 100), 0)).toBe(b.reduce((s, r) => s + r.cents, 0));
  });

  it("fails (never a partial number) when it still moves on the re-read", async () => {
    let runs = 0;
    const { admin } = fakeAdmin(() => bigSpend().slice(0, 100 + ++runs));
    await expect(readSpend(admin, { from: "2026-09-21", to: "2026-10-04" })).rejects.toThrow(/changed while it was being read/);
  });
});

describe("loadPatientSourcesDigest", () => {
  it("reads ONE report per period (day grain, served mode) and the spend across both periods", async () => {
    loadReport.mockResolvedValue({ ok: true, data: report() });
    const { admin, rec } = fakeAdmin(() => []);
    const readAt = new Date("2026-10-05T00:00:00Z");
    const out = await loadPatientSourcesDigest(admin, "week", "2026-10-05", () => readAt);

    expect(loadReport).toHaveBeenCalledTimes(2);
    expect(loadReport).toHaveBeenCalledWith(admin, { from: "2026-09-28", to: "2026-10-04", grain: "day", mode: "served", prev: null });
    expect(loadReport).toHaveBeenCalledWith(admin, { from: "2026-09-21", to: "2026-09-27", grain: "day", mode: "served", prev: null });
    expect(rec.bounds).toContainEqual(["2026-09-21", "2026-10-04"]);
    expect(out).toMatchObject({
      ok: true,
      kind: "data",
      data: { kind: "week", spend: [], spendEverSaved: false, readAt },
    });
    if (out.ok && out.kind === "data") {
      expect(out.data.cur.period).toEqual({ from: "2026-09-28", to: "2026-10-04" });
      expect(out.data.prev?.period).toEqual({ from: "2026-09-21", to: "2026-09-27" });
    }
  });

  it("tells 'nothing ever saved' from 'none this period'", async () => {
    loadReport.mockResolvedValue({ ok: true, data: report() });
    const old: Row = { spend_date: "2026-01-05", platform: "meta", campaign_key: "c", ad_key: "a", spend_php: 5, cents: 500 };
    const { admin } = fakeAdmin(() => [old]);
    const out = await loadPatientSourcesDigest(admin, "week", "2026-10-05");
    expect(out).toMatchObject({ ok: true, kind: "data", data: { spend: [], spendEverSaved: true } });
  });

  it("makes ONE report call when there is no comparison period", async () => {
    loadReport.mockResolvedValue({ ok: true, data: report() });
    const { admin } = fakeAdmin(() => []);
    const out = await loadPatientSourcesDigest(admin, "month", "2024-01-01"); // Dec 2023; Nov 2023 would start before the first date
    expect(loadReport).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ ok: true, kind: "data", data: { prev: null } });
  });

  it("is too_early (no report call at all) when the current period starts before the first date", async () => {
    const { admin } = fakeAdmin(() => []);
    expect(await loadPatientSourcesDigest(admin, "month", "2023-12-15")).toEqual({
      ok: true,
      kind: "too_early",
      period: { from: "2023-11-01", to: "2023-11-30" },
    });
    expect(loadReport).not.toHaveBeenCalled();
  });

  it("fails when either report fails, naming which", async () => {
    const { admin } = fakeAdmin(() => []);
    loadReport.mockResolvedValueOnce({ ok: true, data: report() }).mockResolvedValueOnce({ ok: false, kind: "error", message: "boom" });
    expect(await loadPatientSourcesDigest(admin, "week", "2026-10-05")).toEqual({ ok: false, message: "previous report: boom" });
    loadReport.mockReset();
    loadReport.mockResolvedValueOnce({ ok: false, kind: "error", message: "bad" }).mockResolvedValueOnce({ ok: true, data: report() });
    expect(await loadPatientSourcesDigest(admin, "week", "2026-10-05")).toEqual({ ok: false, message: "report: bad" });
  });

  it("fails (and sends nothing) when the spend read fails", async () => {
    loadReport.mockResolvedValue({ ok: true, data: report() });
    const failing = {
      from: () => {
        const b: Record<string, unknown> = {};
        for (const m of ["select", "gte", "lte", "order", "range", "returns"]) b[m] = () => b;
        b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ count: null, data: null, error: { message: "nope" } }).then(ok);
        return b;
      },
    } as never;
    const out = await loadPatientSourcesDigest(failing, "week", "2026-10-05");
    expect(out.ok).toBe(false);
    expect((out as { message: string }).message).toContain("nope");
  });
});

describe("buildPatientSourcesDigestEmail", () => {
  it("renders the email for the period", async () => {
    loadReport.mockResolvedValue({ ok: true, data: report() });
    const { admin } = fakeAdmin(() => []);
    const out = await buildPatientSourcesDigestEmail(admin, "week", "2026-10-05", "https://drmed.ph");
    expect(out).toMatchObject({ ok: true, kind: "email", period: { from: "2026-09-28", to: "2026-10-04" } });
    if (out.ok && out.kind === "email") {
      expect(out.subject).toBe("Patient sources, Wk of 28 Sep: 12 new (= 0)");
      expect(out.html).toContain("Open Patient Sources");
    }
  });
  it("passes a too_early period and a failure straight through", async () => {
    const { admin } = fakeAdmin(() => []);
    expect(await buildPatientSourcesDigestEmail(admin, "month", "2023-12-15", "https://drmed.ph")).toMatchObject({ ok: true, kind: "too_early" });
    loadReport.mockResolvedValue({ ok: false, kind: "error", message: "down" });
    expect(await buildPatientSourcesDigestEmail(admin, "week", "2026-10-05", "https://drmed.ph")).toMatchObject({ ok: false });
  });
});

describe("never-call list (a refused call crashes prod's Postgres image)", () => {
  const FORBIDDEN = [
    "patient_sources_revenue", "patient_sources_overlaps", "patient_sources_referrers", "patient_sources_people",
    "ad_spend_daily_totals", "ad_spend_coverage", "ad_spend_rows",
  ];
  it.each(["src/lib/marketing/patient-sources-digest.server.ts", "src/lib/marketing/patient-sources-digest.ts"])(
    "%s names none of the admin-only functions",
    (file) => {
      const src = readFileSync(file, "utf8");
      for (const name of FORBIDDEN) expect(src, `${file} names ${name}`).not.toContain(name);
    },
  );
  it("the data module makes no RPC call of its own (the report goes through the shared loader)", () => {
    expect(readFileSync("src/lib/marketing/patient-sources-digest.server.ts", "utf8")).not.toContain(".rpc(");
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/lib/marketing/patient-sources-digest.server.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** `src/lib/marketing/patient-sources-digest.server.ts`

```ts
/**
 * Patient Sources owner email — data gathering. Two report calls (one snapshot per
 * period), read THROUGH the shared loader, plus the saved ad spend read straight
 * from its table. The cron holds the service key, so this module must never call a
 * function that is admin-only inside its body: with the service key that is a
 * refused call, and on prod's current Postgres image a refused call crashes the
 * database. patient-sources-digest.server.test.ts pins that this source names none
 * of them.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { fetchAllRows, REPORT_EXPORT_MAX_ROWS } from "@/lib/reports/paging";
import { loadPatientSourcesReport } from "@/lib/marketing/patient-sources.server";
import type { PatientSourcesReport, Period, SpendTotalRow } from "./patient-sources";
import {
  aggregateSpend,
  digestPeriods,
  renderPatientSourcesDigest,
  type DigestData,
  type DigestKind,
  type DigestPeriodData,
  type RawSpendRow,
} from "./patient-sources-digest";

type Db = SupabaseClient<Database>;

export type DigestLoad =
  | { ok: true; kind: "data"; data: DigestData }
  | { ok: true; kind: "too_early"; period: Period }
  | { ok: false; message: string };

const periodData = (period: Period, r: PatientSourcesReport): DigestPeriodData => ({
  period,
  summary: r.summary,
  servedByDay: r.series,
  newByDay: r.new_by_day,
  revenue: r.revenue,
  referrers: r.referrers,
});

async function spendCount(admin: Db, range?: Period): Promise<number> {
  let q = admin.from("ad_spend_daily").select("id", { count: "exact", head: true });
  if (range) q = q.gte("spend_date", range.from).lte("spend_date", range.to);
  const { count, error } = await q;
  if (error || count === null) throw new Error(`ad spend count: ${error?.message ?? "no count"}`);
  return count;
}

async function spendRows(admin: Db, range: Period): Promise<RawSpendRow[]> {
  const { rows, truncated } = await fetchAllRows<RawSpendRow>(
    (a, b) =>
      admin
        .from("ad_spend_daily")
        .select("spend_date, platform, spend_php")
        .gte("spend_date", range.from)
        .lte("spend_date", range.to)
        // The table's full unique key (0189 ad_spend_daily_key): a TOTAL order, so .range() paging can
        // neither repeat nor drop a row.
        .order("spend_date")
        .order("platform")
        .order("campaign_key")
        .order("ad_key")
        .range(a, b)
        .returns<RawSpendRow[]>(),
    REPORT_EXPORT_MAX_ROWS,
  );
  if (truncated) throw new Error("ad spend: more rows than a digest will read");
  return rows;
}

/**
 * Saved spend per date × platform over `range`. The row count is taken before and
 * after the paging; if it moved (an import landed mid-read) or the rows do not add
 * up to it, read once more; if it still moves, fail — a partial spend read must
 * never become a number in an email.
 */
export async function readSpend(admin: Db, range: Period): Promise<SpendTotalRow[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = await spendCount(admin, range);
    const rows = await spendRows(admin, range);
    const after = await spendCount(admin, range);
    if (before === after && rows.length === after) return aggregateSpend(rows);
  }
  throw new Error("ad spend changed while it was being read");
}

/**
 * Everything one digest needs. `todayISO` is the day the digest is sent (a retry for
 * an earlier period passes the day after that period). Two report calls — one
 * snapshot each — then the spend over [previous.from ?? current.from, current.to].
 */
export async function loadPatientSourcesDigest(
  admin: Db,
  kind: DigestKind,
  todayISO: string,
  now: () => Date = () => new Date(),
): Promise<DigestLoad> {
  const { cur, prev, tooEarly } = digestPeriods(kind, todayISO);
  if (tooEarly) return { ok: true, kind: "too_early", period: cur };

  const reportFor = (p: Period) => loadPatientSourcesReport(admin, { ...p, grain: "day", mode: "served", prev: null });
  const [curRes, prevRes] = await Promise.all([reportFor(cur), prev ? reportFor(prev) : Promise.resolve(null)]);
  if (!curRes.ok) return { ok: false, message: `report: ${curRes.message}` };
  if (prevRes && !prevRes.ok) return { ok: false, message: `previous report: ${prevRes.message}` };

  let spend: SpendTotalRow[];
  let spendEverSaved: boolean;
  try {
    spend = await readSpend(admin, { from: prev?.from ?? cur.from, to: cur.to });
    spendEverSaved = spend.length > 0 || (await spendCount(admin)) > 0;
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "ad spend read failed" };
  }

  const readAt = now();
  return {
    ok: true,
    kind: "data",
    data: {
      kind,
      cur: periodData(cur, curRes.data),
      prev: prev && prevRes && prevRes.ok ? periodData(prev, prevRes.data) : null,
      spend,
      spendEverSaved,
      readAt,
    },
  };
}

export type DigestEmailBuild =
  | { ok: true; kind: "email"; period: Period; subject: string; html: string; text: string }
  | { ok: true; kind: "too_early"; period: Period }
  | { ok: false; message: string };

/** Load + render — what the cron, the preview button and `npm run email:preview` all call. */
export async function buildPatientSourcesDigestEmail(
  admin: Db,
  kind: DigestKind,
  todayISO: string,
  appUrl: string,
  now?: () => Date,
): Promise<DigestEmailBuild> {
  const loaded = await loadPatientSourcesDigest(admin, kind, todayISO, now);
  if (!loaded.ok) return loaded;
  if (loaded.kind === "too_early") return loaded;
  return { ok: true, kind: "email", period: loaded.data.cur.period, ...renderPatientSourcesDigest(loaded.data, { appUrl }) };
}
```

- [ ] **Step 4: Pin the module to the shared loader.** In `patient-sources-surfaces.test.ts` add to `SURFACES`:

```ts
  ["src/lib/marketing/patient-sources-digest.server.ts"]: "loadPatientSourcesReport",
```
(The existing "every summary surface reads through the shared loader" test then asserts the file contains `@/lib/marketing/patient-sources.server` and `loadPatientSourcesReport(` — both true above.)

- [ ] **Step 5: Run** `npx vitest run src/lib/marketing 2>&1 | tail -8` → PASS; `npx tsc --noEmit 2>&1 | head -5` → clean (the `.returns<RawSpendRow[]>()` and `admin.from("ad_spend_daily")` typing come from the regenerated `database.ts` in Task 4).

- [ ] **Step 6: Commit**

```bash
git add src/lib/marketing/patient-sources-digest.server.ts src/lib/marketing/patient-sources-digest.server.test.ts src/lib/marketing/patient-sources-surfaces.test.ts
git commit -m "feat(sources): owner-email data gathering — two report calls and a paged, re-checked spend read" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Cron module — claim, send, record, retry, audit — and the two routes

**Files:**
- Modify: `src/lib/marketing/patient-sources-digest.ts` (+ `parseDigestParams`), `src/lib/marketing/patient-sources-digest.test.ts`, `src/lib/notifications/alert-last-sent.ts` (+ `alertLastSentLine`), `src/lib/notifications/alert-last-sent.test.ts`
- Create: `src/lib/marketing/patient-sources-digest-cron.server.ts`, `src/lib/marketing/patient-sources-digest-cron.server.test.ts`, `src/app/api/cron/patient-sources-weekly/route.ts`, `src/app/api/cron/patient-sources-weekly/route.test.ts`, `src/app/api/cron/patient-sources-monthly/route.ts`

- [ ] **Step 1: Failing tests — query-string validation.** Append to `patient-sources-digest.test.ts` (import `parseDigestParams`):

```ts
describe("parseDigestParams", () => {
  const q = (s: string) => new URLSearchParams(s);
  it("no parameters = the latest completed period, no unknowns", () => {
    expect(parseDigestParams(q(""), "week", "2026-10-12")).toEqual({ ok: true, periodFrom: null, includeUnknown: false });
  });
  it("accepts a valid retry period and include_unknown=1 together", () => {
    expect(parseDigestParams(q("period_from=2026-10-05&include_unknown=1"), "week", "2026-10-12")).toEqual({
      ok: true, periodFrom: "2026-10-05", includeUnknown: true,
    });
  });
  it("only the literal 1 turns include_unknown on", () => {
    expect(parseDigestParams(q("period_from=2026-10-05&include_unknown=true"), "week", "2026-10-12")).toMatchObject({ includeUnknown: false });
  });
  it("refuses include_unknown without period_from (unknowns are an operator action on a named period)", () => {
    expect(parseDigestParams(q("include_unknown=1"), "week", "2026-10-12")).toEqual({
      ok: false, error: "include_unknown needs period_from.",
    });
  });
  it("refuses an invalid period_from with the reason", () => {
    expect(parseDigestParams(q("period_from=2026-10-07"), "week", "2026-10-12")).toMatchObject({ ok: false, error: expect.stringMatching(/Monday/) });
    expect(parseDigestParams(q("period_from=2026-10-12"), "week", "2026-10-12")).toMatchObject({ ok: false, error: expect.stringMatching(/not finished/) });
  });
});
```
Implement in `patient-sources-digest.ts` (append):

```ts
export type DigestParams = { ok: true; periodFrom: string | null; includeUnknown: boolean } | { ok: false; error: string };

/**
 * The cron routes' query string (CRON_SECRET callers only). `period_from` re-runs an
 * EARLIER period (Monday / 1st, finished, ≤ 62 days old); `include_unknown=1` — only
 * with `period_from`, after checking the Resend dashboard — re-sends rows left in
 * the `unknown` state. Nothing re-sends an unknown row automatically.
 */
export function parseDigestParams(search: URLSearchParams, kind: DigestKind, todayISO: string): DigestParams {
  const periodFrom = search.get("period_from");
  const includeUnknown = search.get("include_unknown") === "1";
  if (periodFrom === null) {
    return includeUnknown ? { ok: false, error: "include_unknown needs period_from." } : { ok: true, periodFrom: null, includeUnknown: false };
  }
  const problem = retryPeriodError(kind, periodFrom, todayISO);
  return problem ? { ok: false, error: problem } : { ok: true, periodFrom, includeUnknown };
}
```

- [ ] **Step 2: Failing test + impl — the "Last sent" wording.** Append to `alert-last-sent.test.ts` (import `alertLastSentLine`):

```ts
describe("alertLastSentLine", () => {
  it("is the Email Alerts wording: sent to X of Y, failures, then the reason in brackets", () => {
    expect(alertLastSentLine({ recipients: 4, sent: 3, failed: 1, skipped: null })).toBe("sent to 3 of 4, 1 failed");
    expect(alertLastSentLine({ recipients: 2, sent: 2, failed: 0, skipped: null })).toBe("sent to 2 of 2");
    expect(alertLastSentLine({ recipients: 0, sent: 0, failed: 0, skipped: "turned off in Email Alerts" })).toBe(
      "sent to 0 of 0 (turned off in Email Alerts)",
    );
  });
  it("reads a Patient Sources digest row: already-sent is a reason, not a failure", () => {
    const meta = {
      period_from: "2026-09-28", period_to: "2026-10-04", recipients: 3, sent: 0, failed: 0, unknown: 0, already_sent: 3,
      skipped: "already sent to everyone for this period",
    };
    expect(alertLastSentLine(normaliseAlertSentMetadata(meta))).toBe("sent to 0 of 3 (already sent to everyone for this period)");
  });
});
```
Implement in `alert-last-sent.ts`:

```ts
/** "sent to 3 of 4, 1 failed (reason)" — the Email Alerts "Last sent" wording, shared with its test. */
export function alertLastSentLine(s: AlertLastSentSummary): string {
  return `sent to ${s.sent} of ${s.recipients}${s.failed > 0 ? `, ${s.failed} failed` : ""}${s.skipped ? ` (${s.skipped})` : ""}`;
}
```
(A digest run with an `unknown` send shows as `sent to 2 of 3` here; the alarm for it is the failed cron monitor and the watchdog — see Step 5's `failed` flag.)

- [ ] **Step 3: Failing tests — the run module.** Create `src/lib/marketing/patient-sources-digest-cron.server.test.ts`

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/audit/log", () => ({ audit: async () => undefined }));
vi.mock("@/lib/observability/report-error", () => ({ reportError: async () => undefined }));
vi.mock("@/lib/notifications/email", () => ({ sendEmail: async () => ({ ok: true, id: "x" }) }));
vi.mock("@/lib/notifications/staff-alert-recipients", () => ({ resolveStaffAlertRecipients: async () => ({}) }));
vi.mock("@/lib/marketing/patient-sources-digest.server", () => ({ buildPatientSourcesDigestEmail: async () => ({ ok: false, message: "unused" }) }));

import { normaliseAlertSentMetadata, alertLastSentLine } from "@/lib/notifications/alert-last-sent";
import type { SendResult } from "@/lib/notifications/email";
import {
  runPatientSourcesDigest,
  supabaseDigestStore,
  type DigestRowStatus,
  type DigestRunDeps,
  type DigestSendStore,
} from "./patient-sources-digest-cron.server";

const PERIOD = { from: "2026-09-28", to: "2026-10-04" };
const NOW = new Date("2026-10-04T23:00:00Z"); // Monday 07:00 Manila, 2026-10-05

function setup(over: Partial<DigestRunDeps> = {}, preset: Record<string, DigestRowStatus> = {}) {
  const rows = new Map<string, { status: DigestRowStatus; attempts: number; error?: string | null }>(
    Object.entries(preset).map(([k, status]) => [k, { status, attempts: 1 }] as const),
  );
  const audits: Array<{ action: string; metadata: Record<string, unknown> }> = [];
  const sends: Array<{ to: string; subject: string; idempotencyKey?: string }> = [];
  const reported: string[] = [];
  const claims: Array<{ recipient: string; includeUnknown: boolean }> = [];
  let recordError: string | null = null;
  const store: DigestSendStore = {
    // Mirrors the SQL claim's contract; one synchronous read-modify-write, like the single statement.
    claim: async (_k, _f, _t, recipient, includeUnknown) => {
      claims.push({ recipient, includeUnknown });
      const row = rows.get(recipient);
      if (!row) {
        rows.set(recipient, { status: "sending", attempts: 1 });
        return { attempts: 1, error: null };
      }
      if (row.status === "failed" || (includeUnknown && row.status === "unknown")) {
        row.status = "sending";
        row.attempts += 1;
        return { attempts: row.attempts, error: null };
      }
      return { attempts: null, error: null };
    },
    statusOf: async (_k, _f, recipient) => rows.get(recipient)?.status ?? null,
    record: async (_k, _f, recipient, patch) => {
      const row = rows.get(recipient);
      if (row && !recordError) {
        row.status = patch.status;
        row.error = patch.error ?? null;
      }
      return recordError;
    },
  };
  const build = vi.fn(async (_kind: string, _anchor: string) => ({
    ok: true as const,
    kind: "email" as const,
    period: PERIOD,
    subject: "Patient sources, Wk of 28 Sep: 12 new (▲ 4)",
    html: "<p>h</p>",
    text: "t",
  }));
  const resolveRecipients = vi.fn(async () => ({
    enabled: true,
    emails: ["Owner@Example.com", "ops@example.com"],
    staffOn: [],
    staffWithoutEmail: [],
    loadError: null as string | null,
  }));
  let sendImpl: (to: string) => Promise<SendResult> = async () => ({ ok: true, id: "em_1" });
  const deps: DigestRunDeps = {
    now: () => NOW,
    resolveRecipients,
    build,
    store,
    send: async (input) => {
      sends.push({ to: input.to, subject: input.subject, idempotencyKey: input.idempotencyKey });
      return sendImpl(input.to);
    },
    audit: async (e) => void audits.push({ action: e.action, metadata: (e.metadata ?? {}) as Record<string, unknown> }),
    reportError: async (a) => void reported.push(a.scope),
    ...over,
  };
  return {
    deps, rows, audits, sends, reported, claims, build, resolveRecipients,
    setSend: (fn: (to: string) => Promise<SendResult>) => (sendImpl = fn),
    setRecordError: (e: string | null) => (recordError = e),
  };
}
const sentMeta = (audits: Array<{ action: string; metadata: Record<string, unknown> }>) =>
  audits.find((a) => a.action === "system.patient_sources_weekly.sent")!.metadata;

describe("runPatientSourcesDigest", () => {
  it("claims and sends once per recipient, with an idempotency key per attempt, then records and audits", async () => {
    const t = setup();
    const out = await runPatientSourcesDigest(t.deps, { kind: "week" });
    expect(out).toMatchObject({ status: 200, failed: false });
    expect(t.sends.map((s) => s.to)).toEqual(["Owner@Example.com", "ops@example.com"]);
    expect(t.sends[0]!.idempotencyKey).toBe("patient_sources_weekly:2026-09-28:owner@example.com:1");
    expect([...t.rows.values()].map((r) => r.status)).toEqual(["sent", "sent"]);
    expect(t.build).toHaveBeenCalledWith("week", "2026-10-05");
    expect(t.audits.map((a) => a.action)).toEqual(["system.patient_sources_weekly.sent", "system.patient_sources_weekly.completed"]);
    expect(sentMeta(t.audits)).toMatchObject({ period_from: "2026-09-28", period_to: "2026-10-04", recipients: 2, sent: 2, failed: 0, unknown: 0, already_sent: 0 });
    expect(sentMeta(t.audits)).not.toHaveProperty("skipped");
  });

  it("a switched-off / empty alert: no build, no send, still audited and completed (the heartbeat)", async () => {
    const t = setup();
    t.resolveRecipients.mockResolvedValue({ enabled: false, emails: [], staffOn: [], staffWithoutEmail: [], loadError: null });
    const out = await runPatientSourcesDigest(t.deps, { kind: "week" });
    expect(out).toMatchObject({ status: 200, failed: false });
    expect(t.build).not.toHaveBeenCalled();
    expect(t.sends).toHaveLength(0);
    expect(sentMeta(t.audits)).toMatchObject({ recipients: 0, sent: 0, skipped: "turned off in Email Alerts" });
    expect(t.audits.at(-1)!.action).toBe("system.patient_sources_weekly.completed");
  });

  it("reports an unreadable recipient list instead of 'nobody is switched on'", async () => {
    const t = setup();
    t.resolveRecipients.mockResolvedValue({ enabled: true, emails: [], staffOn: [], staffWithoutEmail: [], loadError: "staff list: down" });
    await runPatientSourcesDigest(t.deps, { kind: "week" });
    expect(sentMeta(t.audits).skipped).toMatch(/couldn't read who gets this alert/);
    expect(sentMeta(t.audits).recipients_error).toBe("staff list: down");
  });

  it("everyone already has it: nothing sent, a skipped REASON (not a failure), completed", async () => {
    const t = setup({}, { "owner@example.com": "sent", "ops@example.com": "sent" });
    const out = await runPatientSourcesDigest(t.deps, { kind: "week" });
    expect(out).toMatchObject({ status: 200, failed: false });
    expect(t.sends).toHaveLength(0);
    expect(sentMeta(t.audits)).toMatchObject({ recipients: 2, sent: 0, failed: 0, already_sent: 2, skipped: "already sent to everyone for this period" });
    expect(alertLastSentLine(normaliseAlertSentMetadata(sentMeta(t.audits)))).toBe("sent to 0 of 2 (already sent to everyone for this period)");
    expect(t.audits.at(-1)!.action).toBe("system.patient_sources_weekly.completed");
  });

  it("two overlapping invocations: each recipient is emailed exactly once", async () => {
    const t = setup();
    const [a, b] = await Promise.all([
      runPatientSourcesDigest(t.deps, { kind: "week" }),
      runPatientSourcesDigest(t.deps, { kind: "week" }),
    ]);
    expect(t.sends.map((s) => s.to).sort()).toEqual(["Owner@Example.com", "ops@example.com"]);
    expect([a.failed, b.failed]).toEqual([false, false]);
  });

  it("a DEFINITE failure is recorded failed, flags the monitor, and is retried on the next run; sent rows are not", async () => {
    const t = setup();
    t.setSend(async (to) => (to === "ops@example.com" ? { ok: false, kind: "error", error: "Resend 422: bad", definite: true } : { ok: true, id: "em_1" }));
    const first = await runPatientSourcesDigest(t.deps, { kind: "week" });
    expect(first.failed).toBe(true);
    expect(t.rows.get("ops@example.com")!.status).toBe("failed");
    expect(sentMeta(t.audits)).toMatchObject({ sent: 1, failed: 1, unknown: 0 });

    t.setSend(async () => ({ ok: true, id: "em_2" }));
    t.sends.length = 0;
    const second = await runPatientSourcesDigest(t.deps, { kind: "week" });
    expect(t.sends.map((s) => s.to)).toEqual(["ops@example.com"]);
    expect(t.sends[0]!.idempotencyKey).toBe("patient_sources_weekly:2026-09-28:ops@example.com:2");
    expect(second.failed).toBe(false);
  });

  it("an UNCERTAIN failure (fetch threw / unreadable reply) is recorded unknown and never re-sent automatically", async () => {
    const t = setup();
    t.setSend(async () => ({ ok: false, kind: "error", error: "socket hang up", definite: false }));
    const first = await runPatientSourcesDigest(t.deps, { kind: "week" });
    expect(first.failed).toBe(true);
    expect([...t.rows.values()].map((r) => r.status)).toEqual(["unknown", "unknown"]);
    expect(sentMeta(t.audits)).toMatchObject({ sent: 0, failed: 0, unknown: 2 });

    t.sends.length = 0;
    t.setSend(async () => ({ ok: true, id: "em_3" }));
    const second = await runPatientSourcesDigest(t.deps, { kind: "week" });
    expect(t.sends).toHaveLength(0); // nothing re-sends by itself
    expect(second.failed).toBe(true); // …and the unknown rows keep the monitor red until an operator looks
    expect(sentMeta(t.audits.slice(2))).toMatchObject({ unknown: 2, already_sent: 0 });
  });

  it("a missing `definite` flag counts as uncertain, and a thrown send does too", async () => {
    const t = setup();
    t.setSend(async (to) => {
      if (to === "ops@example.com") throw new Error("boom");
      return { ok: false, kind: "error", error: "no flag" };
    });
    await runPatientSourcesDigest(t.deps, { kind: "week" });
    expect([...t.rows.values()].map((r) => r.status)).toEqual(["unknown", "unknown"]);
  });

  it("an operator retry with include_unknown re-sends unknown rows (and only then)", async () => {
    const t = setup({}, { "owner@example.com": "unknown", "ops@example.com": "sent" });
    const out = await runPatientSourcesDigest(t.deps, { kind: "week", periodFrom: "2026-09-21", includeUnknown: true });
    expect(t.claims.every((c) => c.includeUnknown)).toBe(true);
    expect(t.sends.map((s) => s.to)).toEqual(["Owner@Example.com"]);
    expect(out.failed).toBe(false);
  });

  it("a SKIPPED send (not live / not configured) is a definite failure: row failed, reason surfaced, not blocking", async () => {
    const t = setup();
    t.setSend(async () => ({ ok: false, kind: "skipped", reason: "NOTIFICATIONS_LIVE not enabled in this environment" }));
    const out = await runPatientSourcesDigest(t.deps, { kind: "week" });
    expect(out.failed).toBe(true);
    expect([...t.rows.values()].map((r) => r.status)).toEqual(["failed", "failed"]);
    expect(sentMeta(t.audits)).toMatchObject({ sent: 0, failed: 2, skipped: "NOTIFICATIONS_LIVE not enabled in this environment" });
  });

  it("a claim that finds a row still in flight sends nothing and says so", async () => {
    const t = setup({}, { "owner@example.com": "sending", "ops@example.com": "sent" });
    const out = await runPatientSourcesDigest(t.deps, { kind: "week" });
    expect(t.sends).toHaveLength(0);
    expect(sentMeta(t.audits)).toMatchObject({ already_sent: 1, in_flight: 1 });
    expect(out.failed).toBe(false);
  });

  it("a record-write error after a send is reported and flags the monitor — never thrown", async () => {
    const t = setup();
    t.setRecordError("db down");
    const out = await runPatientSourcesDigest(t.deps, { kind: "week" });
    expect(out.failed).toBe(true);
    expect(t.reported).toContain("cron/patient-sources-digest");
    expect(t.audits.map((a) => a.action)).toContain("system.patient_sources_weekly.completed");
  });

  it("a claim error flags the monitor and sends nothing to that recipient", async () => {
    const t = setup();
    t.deps.store.claim = async () => ({ attempts: null, error: "rpc down" });
    const out = await runPatientSourcesDigest(t.deps, { kind: "week" });
    expect(out.failed).toBe(true);
    expect(t.sends).toHaveLength(0);
    expect(sentMeta(t.audits)).toMatchObject({ failed: 2, sent: 0 });
  });

  it("a report/spend failure: 500, nothing sent, the monitor fails, and NO heartbeat is written", async () => {
    const t = setup();
    t.build.mockResolvedValue({ ok: false, message: "report: boom" } as never);
    const out = await runPatientSourcesDigest(t.deps, { kind: "week" });
    expect(out).toMatchObject({ status: 500, failed: true });
    expect(t.sends).toHaveLength(0);
    expect(t.audits).toHaveLength(0);
    expect(t.reported).toContain("cron/patient-sources-digest");
  });

  it("too_early completes without sending (and says why on the Email Alerts line)", async () => {
    const t = setup();
    t.build.mockResolvedValue({ ok: true, kind: "too_early", period: { from: "2023-11-01", to: "2023-11-30" } } as never);
    const out = await runPatientSourcesDigest(t.deps, { kind: "week" });
    expect(out).toMatchObject({ status: 200, failed: false });
    expect(t.sends).toHaveLength(0);
    expect(sentMeta(t.audits).skipped).toMatch(/first date/);
    expect(t.audits.at(-1)!.action).toBe("system.patient_sources_weekly.completed");
  });

  it("?period_from= targets that period (a rollover cannot move it) and re-resolves recipients now", async () => {
    const t = setup();
    // The cron ran late: it is now Monday 2026-10-12 Manila, but the retry names the week of 2026-09-28.
    t.deps.now = () => new Date("2026-10-11T23:00:00Z");
    await runPatientSourcesDigest(t.deps, { kind: "week", periodFrom: "2026-09-28" });
    expect(t.build).toHaveBeenCalledWith("week", "2026-10-05"); // the day AFTER that week → the builder derives Sep 28–Oct 4
    expect(t.resolveRecipients).toHaveBeenCalledTimes(1);
    expect(sentMeta(t.audits)).toMatchObject({ period_from: "2026-09-28", period_to: "2026-10-04" });
  });

  it("monthly uses its own key, audit actions and period", async () => {
    const t = setup();
    t.build.mockResolvedValue({ ok: true as const, kind: "email" as const, period: { from: "2026-09-01", to: "2026-09-30" }, subject: "S", html: "h", text: "t" });
    await runPatientSourcesDigest(t.deps, { kind: "month" });
    expect(t.audits.map((a) => a.action)).toEqual(["system.patient_sources_monthly.sent", "system.patient_sources_monthly.completed"]);
    expect(t.sends[0]!.idempotencyKey).toBe("patient_sources_monthly:2026-09-01:owner@example.com:1");
  });
});

describe("supabaseDigestStore", () => {
  function fakeAdmin(o: { rpc?: { data: unknown; error: { message: string } | null }; status?: string | null; update?: { data: unknown; error: { message: string } | null } }) {
    const calls: Array<[string, unknown[]]> = [];
    const chain = (result: unknown) => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in"]) {
        b[m] = (...a: unknown[]) => {
          calls.push([m, a]);
          return b;
        };
      }
      b.maybeSingle = async () => result;
      b.then = (ok: (v: unknown) => unknown) => Promise.resolve(result).then(ok);
      return b;
    };
    const admin = {
      rpc: async (fn: string, args: unknown) => {
        calls.push(["rpc", [fn, args]]);
        return o.rpc ?? { data: 1, error: null };
      },
      from: (t: string) => {
        calls.push(["from", [t]]);
        return {
          select: (...a: unknown[]) => {
            calls.push(["select", a]);
            return chain({ data: o.status === undefined ? null : { status: o.status }, error: null });
          },
          update: (...a: unknown[]) => {
            calls.push(["update", a]);
            return chain(o.update ?? { data: [{ recipient: "x" }], error: null });
          },
        };
      },
    } as never;
    return { admin, calls };
  }

  it("claim maps the attempt number, NULL (not claimed) and an error", async () => {
    const ok = fakeAdmin({ rpc: { data: 2, error: null } });
    expect(await supabaseDigestStore(ok.admin).claim("patient_sources_weekly", "2026-09-28", "2026-10-04", "a@x.com", true)).toEqual({ attempts: 2, error: null });
    expect(ok.calls[0]).toEqual([
      "rpc",
      ["_ps_digest_claim", { p_key: "patient_sources_weekly", p_from: "2026-09-28", p_to: "2026-10-04", p_recipient: "a@x.com", p_include_unknown: true }],
    ]);
    expect(await supabaseDigestStore(fakeAdmin({ rpc: { data: null, error: null } }).admin).claim("patient_sources_weekly", "a", "b", "r", false)).toEqual({ attempts: null, error: null });
    expect(await supabaseDigestStore(fakeAdmin({ rpc: { data: null, error: { message: "nope" } } }).admin).claim("patient_sources_weekly", "a", "b", "r", false)).toEqual({ attempts: null, error: "nope" });
  });
  it("statusOf reads the row's status or null", async () => {
    expect(await supabaseDigestStore(fakeAdmin({ status: "unknown" }).admin).statusOf("patient_sources_weekly", "2026-09-28", "a@x.com")).toBe("unknown");
    expect(await supabaseDigestStore(fakeAdmin({ status: null }).admin).statusOf("patient_sources_weekly", "2026-09-28", "a@x.com")).toBeNull();
  });
  it("record updates only a row this run claimed (sending) or an operator re-opened (unknown)", async () => {
    const f = fakeAdmin({});
    expect(await supabaseDigestStore(f.admin).record("patient_sources_weekly", "2026-09-28", "a@x.com", { status: "sent", providerId: "em_1" })).toBeNull();
    const update = f.calls.find(([m]) => m === "update")![1][0] as Record<string, unknown>;
    expect(update).toMatchObject({ status: "sent", provider_id: "em_1", last_error: null });
    expect(f.calls).toContainEqual(["in", ["status", ["sending", "unknown"]]]);
  });
  it("record reports an error, and a missing row", async () => {
    expect(await supabaseDigestStore(fakeAdmin({ update: { data: null, error: { message: "db down" } } }).admin).record("patient_sources_weekly", "a", "r", { status: "failed", error: "x" })).toBe("db down");
    expect(await supabaseDigestStore(fakeAdmin({ update: { data: [], error: null } }).admin).record("patient_sources_weekly", "a", "r", { status: "sent" })).toMatch(/no claimed row/);
  });
});

describe("module guard", () => {
  it("names none of the admin-only functions", () => {
    const src = readFileSync("src/lib/marketing/patient-sources-digest-cron.server.ts", "utf8");
    for (const name of ["patient_sources_revenue", "patient_sources_overlaps", "patient_sources_referrers", "patient_sources_people", "ad_spend_daily_totals", "ad_spend_coverage", "ad_spend_rows", "patient_sources_report"]) {
      expect(src, name).not.toContain(name);
    }
  });
});
```

- [ ] **Step 4: Run** `npx vitest run src/lib/marketing/patient-sources-digest-cron.server.test.ts src/lib/marketing/patient-sources-digest.test.ts src/lib/notifications/alert-last-sent.test.ts` → FAIL (modules/functions missing).

- [ ] **Step 5: Implement** `src/lib/marketing/patient-sources-digest-cron.server.ts`

```ts
/**
 * The weekly / monthly Patient Sources owner email — the cron's brain.
 *
 * DELIVERY RULE: at most once, automatically. Per recipient: CLAIM the send in SQL
 * (`_ps_digest_claim`, one atomic statement), SEND with an idempotency key, RECORD
 * the outcome. When delivery is uncertain nothing re-sends by itself — the row goes
 * `unknown` and the monitor goes red until an operator checks Resend and retries
 * with `?period_from=…&include_unknown=1`.
 *
 * Statuses: sending → sent | failed (definite: Resend refused, or the send was
 * skipped) | unknown (the request may have reached Resend). A record-write error is
 * reported and flags the monitor but is never thrown after a send; the row stays
 * `sending` and becomes `unknown` when stale (15 min, in the claim).
 *
 * Injected deps keep this unit-testable; `runDigestCron` wires the real ones.
 * Like patient-sources-digest.server.ts it never names an admin-only function.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/types/database";
import { audit, type AuditEntry } from "@/lib/audit/log";
import { manilaISODate, shiftISODate } from "@/lib/dates/manila";
import { reportError } from "@/lib/observability/report-error";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail, type SendEmailInput, type SendResult } from "@/lib/notifications/email";
import { resolveStaffAlertRecipients, type ResolvedAlertRecipients } from "@/lib/notifications/staff-alert-recipients";
import { alertSkipReason, STAFF_ALERTS } from "@/lib/notifications/staff-alerts";
import { buildPatientSourcesDigestEmail, type DigestEmailBuild } from "./patient-sources-digest.server";
import { DIGEST_ALERT_KEY, digestPeriods, periodEnd, type DigestAlertKey, type DigestKind } from "./patient-sources-digest";

type Db = SupabaseClient<Database>;

export type DigestRowStatus = "sending" | "sent" | "failed" | "unknown";

export interface DigestSendStore {
  /** The atomic claim: the new attempt number, or null when this call did not claim (sent / in flight / unknown). */
  claim(
    key: DigestAlertKey, from: string, to: string, recipient: string, includeUnknown: boolean,
  ): Promise<{ attempts: number | null; error: string | null }>;
  statusOf(key: DigestAlertKey, from: string, recipient: string): Promise<DigestRowStatus | null>;
  /** Writes the outcome of a send this run claimed. Returns an error message, or null. */
  record(
    key: DigestAlertKey, from: string, recipient: string,
    patch: { status: "sent" | "failed" | "unknown"; providerId?: string | null; error?: string | null },
  ): Promise<string | null>;
}

export function supabaseDigestStore(admin: Db): DigestSendStore {
  return {
    async claim(key, from, to, recipient, includeUnknown) {
      const { data, error } = await admin.rpc("_ps_digest_claim", {
        p_key: key, p_from: from, p_to: to, p_recipient: recipient, p_include_unknown: includeUnknown,
      });
      if (error) return { attempts: null, error: error.message };
      return { attempts: typeof data === "number" ? data : null, error: null };
    },
    async statusOf(key, from, recipient) {
      const { data } = await admin
        .from("patient_sources_digest_sends")
        .select("status")
        .eq("alert_key", key)
        .eq("period_from", from)
        .eq("recipient", recipient)
        .maybeSingle();
      return (data?.status as DigestRowStatus | undefined) ?? null;
    },
    async record(key, from, recipient, patch) {
      const { data, error } = await admin
        .from("patient_sources_digest_sends")
        .update({
          status: patch.status,
          provider_id: patch.providerId ?? null,
          last_error: patch.error ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq("alert_key", key)
        .eq("period_from", from)
        .eq("recipient", recipient)
        // Only a row this run claimed, or one an operator re-opened — never a row someone else finished.
        .in("status", ["sending", "unknown"])
        .select("recipient");
      if (error) return error.message;
      return (data?.length ?? 0) === 0 ? "no claimed row to update" : null;
    },
  };
}

export interface DigestRunDeps {
  now: () => Date;
  resolveRecipients: (key: DigestAlertKey) => Promise<ResolvedAlertRecipients>;
  build: (kind: DigestKind, anchorISO: string) => Promise<DigestEmailBuild>;
  store: DigestSendStore;
  send: (input: SendEmailInput) => Promise<SendResult>;
  audit: (entry: AuditEntry) => Promise<void>;
  reportError: (a: { scope: string; error: unknown; metadata?: Record<string, unknown> }) => Promise<void>;
}

export interface DigestRunOptions {
  kind: DigestKind;
  /** A validated earlier period start (parseDigestParams) — re-targets the run. */
  periodFrom?: string | null;
  includeUnknown?: boolean;
}

export interface DigestRunResult {
  status: number;
  body: Record<string, unknown>;
  /** Mark the cron monitor failed (partial / uncertain delivery, or the digest could not be built). */
  failed: boolean;
}

interface Counts {
  recipients: number;
  sent: number;
  failed: number;
  unknown: number;
  alreadySent: number;
  inFlight: number;
  skippedSends: number;
}
const ZERO: Counts = { recipients: 0, sent: 0, failed: 0, unknown: 0, alreadySent: 0, inFlight: 0, skippedSends: 0 };

const SCOPE = "cron/patient-sources-digest";

/** The reason shown after "sent to X of Y" when a run sent nothing — a string only (normaliseAlertSentMetadata). */
function deliveryNote(c: Counts, sendSkipReason: string | null): string | undefined {
  if (c.sent > 0) return undefined;
  if (c.recipients > 0 && c.alreadySent === c.recipients) return "already sent to everyone for this period";
  if (sendSkipReason && c.failed > 0 && c.failed === c.skippedSends) return sendSkipReason;
  return undefined;
}

export async function runPatientSourcesDigest(deps: DigestRunDeps, opts: DigestRunOptions): Promise<DigestRunResult> {
  const { kind } = opts;
  const key = DIGEST_ALERT_KEY[kind];
  const includeUnknown = opts.includeUnknown === true;
  const todayISO = manilaISODate(deps.now())!;
  // A retry re-targets an earlier period by passing the day AFTER it, so a week/month
  // rollover between the failure and the retry cannot move the target.
  const anchor = opts.periodFrom ? shiftISODate(periodEnd(kind, opts.periodFrom), 1) : todayISO;
  const planned = digestPeriods(kind, anchor).cur;

  // Who gets it — resolved NOW, so someone switched off since a failed run is not emailed.
  const alert = await deps.resolveRecipients(key);
  const recipientSkip = alertSkipReason(alert);

  let trouble = false;
  const finish = async (c: Counts, skipped: string | undefined, period = planned): Promise<DigestRunResult> => {
    const base = {
      period_from: period.from,
      period_to: period.to,
      recipients: c.recipients,
      sent: c.sent,
      failed: c.failed,
      unknown: c.unknown,
      already_sent: c.alreadySent,
    };
    await deps.audit({
      actor_id: null,
      actor_type: "system",
      action: STAFF_ALERTS[key].sentAction,
      metadata: {
        ...base,
        ...(c.inFlight > 0 ? { in_flight: c.inFlight } : {}),
        ...(skipped ? { skipped } : {}),
        ...(alert.loadError ? { recipients_error: alert.loadError } : {}),
      } as Json,
    });
    // The heartbeat the watchdog reads — on EVERY non-failing path.
    await deps.audit({ actor_id: null, actor_type: "system", action: `system.${key}.completed`, metadata: base as Json });
    return {
      status: 200,
      body: { ...base, ...(skipped ? { skipped } : {}) },
      failed: c.failed > 0 || c.unknown > 0 || trouble,
    };
  };

  if (recipientSkip) return finish(ZERO, recipientSkip);

  const built = await deps.build(kind, anchor);
  if (!built.ok) {
    await deps.reportError({ scope: SCOPE, error: new Error(built.message), metadata: { alert_key: key } });
    return { status: 500, body: { error: "failed" }, failed: true };
  }
  if (built.kind === "too_early") {
    return finish(ZERO, "that period starts before Patient Sources' first date (1 December 2023)", built.period);
  }

  const c: Counts = { ...ZERO, recipients: alert.emails.length };
  let sendSkipReason: string | null = null;

  for (const to of alert.emails) {
    const recipient = to.trim().toLowerCase();
    const claim = await deps.store.claim(key, built.period.from, built.period.to, recipient, includeUnknown);
    if (claim.error) {
      c.failed += 1;
      trouble = true;
      await deps.reportError({ scope: SCOPE, error: new Error(`claim: ${claim.error}`), metadata: { alert_key: key } });
      continue;
    }
    if (claim.attempts === null) {
      // Not claimed: say why, because "unknown" must keep the monitor red until an operator looks.
      const status = await deps.store.statusOf(key, built.period.from, recipient);
      if (status === "sent") c.alreadySent += 1;
      else if (status === "unknown") c.unknown += 1;
      else c.inFlight += 1;
      continue;
    }

    let result: SendResult;
    try {
      result = await deps.send({
        to,
        subject: built.subject,
        text: built.text,
        html: built.html,
        idempotencyKey: `${key}:${built.period.from}:${recipient}:${claim.attempts}`,
      });
    } catch (e) {
      result = { ok: false, kind: "error", error: e instanceof Error ? e.message : "unknown", definite: false };
    }

    let recordError: string | null;
    if (result.ok) {
      c.sent += 1;
      recordError = await deps.store.record(key, built.period.from, recipient, { status: "sent", providerId: result.id });
    } else if (result.kind === "skipped") {
      c.failed += 1;
      c.skippedSends += 1;
      sendSkipReason = sendSkipReason ?? result.reason;
      recordError = await deps.store.record(key, built.period.from, recipient, { status: "failed", error: result.reason });
    } else if (result.definite === true) {
      c.failed += 1;
      recordError = await deps.store.record(key, built.period.from, recipient, { status: "failed", error: result.error });
    } else {
      c.unknown += 1;
      recordError = await deps.store.record(key, built.period.from, recipient, { status: "unknown", error: result.error });
    }
    if (recordError) {
      trouble = true;
      await deps.reportError({ scope: SCOPE, error: new Error(`record: ${recordError}`), metadata: { alert_key: key } });
    }
  }

  return finish(c, deliveryNote(c, sendSkipReason), built.period);
}

/** The real wiring, called by the two cron routes AFTER CRON_SECRET and query validation. */
export async function runDigestCron(
  kind: DigestKind,
  params: { periodFrom: string | null; includeUnknown: boolean },
  markFailed: () => void,
): Promise<Response> {
  const admin = createAdminClient();
  const appUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://drmed.ph";
  try {
    const result = await runPatientSourcesDigest(
      {
        now: () => new Date(),
        resolveRecipients: (k) => resolveStaffAlertRecipients(k, admin),
        build: (k, anchor) => buildPatientSourcesDigestEmail(admin, k, anchor, appUrl),
        store: supabaseDigestStore(admin),
        send: sendEmail,
        audit,
        reportError,
      },
      { kind, periodFrom: params.periodFrom, includeUnknown: params.includeUnknown },
    );
    if (result.failed) markFailed();
    return Response.json(result.body, { status: result.status });
  } catch (error) {
    await reportError({ scope: `cron/patient-sources-${kind === "week" ? "weekly" : "monthly"}`, error });
    return Response.json({ error: "failed" }, { status: 500 });
  }
}
```

- [ ] **Step 6: Routes.** `src/app/api/cron/patient-sources-weekly/route.ts`:

```ts
import { withCronMonitor } from "@/lib/ops/cron-monitor";
import { manilaISODate } from "@/lib/dates/manila";
import { parseDigestParams } from "@/lib/marketing/patient-sources-digest";
import { runDigestCron } from "@/lib/marketing/patient-sources-digest-cron.server";

export const dynamic = "force-dynamic";

// Vercel Cron sends GET. Sunday 23:00 UTC = Monday 07:00 Manila, before the 8am opening:
// emails the owners last week's Patient Sources digest (Admin Tools › Email Alerts, key
// patient_sources_weekly). CRON_SECRET callers only may add ?period_from=YYYY-MM-DD (a
// finished Monday, ≤ 62 days old) to re-run an earlier week and &include_unknown=1 to
// re-send rows left uncertain — see the guide's admin notes.
export async function GET(request: Request) {
  const auth = request.headers.get("authorization") ?? "";
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  // A typo in a hand-typed retry must not turn the Sentry monitor red: validate before it starts.
  const params = parseDigestParams(new URL(request.url).searchParams, "week", manilaISODate(new Date())!);
  if (!params.ok) return Response.json({ error: params.error }, { status: 400 });
  return withCronMonitor("patient-sources-weekly", (markFailed) => runDigestCron("week", params, markFailed));
}
```
`…/patient-sources-monthly/route.ts` is identical with `"month"`, `"patient-sources-monthly"`, the comment `0 0 1 * * UTC = the 1st, 08:00 Manila … last month's digest (key patient_sources_monthly) … a finished 1st-of-month period`.

- [ ] **Step 7: Route test** `src/app/api/cron/patient-sources-weekly/route.test.ts`

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const monitor = vi.hoisted(() => vi.fn(async (_key: string, run: (f: () => void) => Promise<Response>) => run(() => undefined)));
const cron = vi.hoisted(() => vi.fn(async () => Response.json({ ok: true })));
vi.mock("@/lib/ops/cron-monitor", () => ({ withCronMonitor: monitor }));
vi.mock("@/lib/marketing/patient-sources-digest-cron.server", () => ({ runDigestCron: cron }));

import { GET } from "./route";

const req = (qs = "", auth: string | null = "Bearer s3cret") =>
  new Request(`https://drmed.ph/api/cron/patient-sources-weekly${qs}`, { headers: auth ? { authorization: auth } : {} });

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "s3cret");
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-11T23:00:00Z")); // Monday 2026-10-12, 07:00 Manila
  monitor.mockClear();
  cron.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("GET /api/cron/patient-sources-weekly", () => {
  it("is 401 without the secret, before anything runs", async () => {
    expect((await GET(req("", null))).status).toBe(401);
    expect((await GET(req("", "Bearer wrong"))).status).toBe(401);
    vi.stubEnv("CRON_SECRET", "");
    expect((await GET(req("", "Bearer "))).status).toBe(401);
    expect(monitor).not.toHaveBeenCalled();
    expect(cron).not.toHaveBeenCalled();
  });

  it("runs the digest under the weekly monitor with no parameters", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(monitor).toHaveBeenCalledWith("patient-sources-weekly", expect.any(Function));
    expect(cron).toHaveBeenCalledWith("week", { ok: true, periodFrom: null, includeUnknown: false }, expect.any(Function));
  });

  it("passes a valid retry period and include_unknown through", async () => {
    await GET(req("?period_from=2026-10-05&include_unknown=1"));
    expect(cron).toHaveBeenCalledWith("week", { ok: true, periodFrom: "2026-10-05", includeUnknown: true }, expect.any(Function));
  });

  it("answers 400 for a bad retry WITHOUT starting the monitor", async () => {
    const res = await GET(req("?period_from=2026-10-07"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: expect.stringMatching(/Monday/) });
    expect(monitor).not.toHaveBeenCalled();
    expect(cron).not.toHaveBeenCalled();
  });
});
```
and the monthly route gets a 2-test file `patient-sources-monthly/route.test.ts` (same mocks; asserts 401, and `monitor` called with `"patient-sources-monthly"` and `cron` with `"month"`; one bad `period_from=2026-10-05` → 400 mentioning `1st`; system time `2026-11-01T00:00:00Z`).

- [ ] **Step 8: Run** `npx vitest run src/lib/marketing src/lib/notifications src/app/api/cron 2>&1 | tail -10` → PASS; `npx tsc --noEmit 2>&1 | head` and `npx eslint src/lib/marketing src/app/api/cron` → clean.

- [ ] **Step 9: Commit**

```bash
git add src/lib/marketing src/lib/notifications/alert-last-sent.ts src/lib/notifications/alert-last-sent.test.ts src/app/api/cron/patient-sources-weekly src/app/api/cron/patient-sources-monthly
git commit -m "feat(cron): weekly and monthly Patient Sources emails — per-recipient claims, at-most-once sends, retry" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 10: "Send me a preview" Server Action

**Files:** Create `src/app/(staff)/staff/(dashboard)/admin/settings/alerts/preview-actions.ts`, `…/alerts/preview-actions.test.ts`.

The action lives beside `actions.ts` (not inside it) so the 400-line file stays untouched. It is modelled on `sendTestAlertAction` (`actions.ts:341-399`): `requireAdminStaff()` (the **effective**-role gate — a View-as admin never reaches it, the same as every action on this page), zod-validated input, `createAdminClient()` for the data read, `ipAndAgent()` + `audit()` for the log row. It emails the **caller only**, never touches `patient_sources_digest_sends` or the `.sent` audit action, and has no rate limit (matching the sibling).

- [ ] **Step 1: Write the failing test** `preview-actions.test.ts`

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const fx = vi.hoisted(() => ({
  admin: {} as Record<string, unknown>, // any .from()/.rpc() on it would throw: the action must not touch the database itself
  requireAdmin: vi.fn(),
  build: vi.fn(),
  send: vi.fn(),
  audits: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/auth/require-admin", () => ({ requireAdminStaff: fx.requireAdmin }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fx.admin }));
vi.mock("@/lib/audit/log", () => ({ audit: async (e: Record<string, unknown>) => void fx.audits.push(e) }));
vi.mock("@/lib/server/action-helpers", () => ({ ipAndAgent: async () => ({ ip: "203.0.113.9", ua: "vitest" }) }));
vi.mock("@/lib/notifications/email", () => ({ sendEmail: fx.send }));
vi.mock("@/lib/marketing/patient-sources-digest.server", () => ({ buildPatientSourcesDigestEmail: fx.build }));

import { sendPatientSourcesPreviewAction } from "./preview-actions";

const ADMIN = { user_id: "admin-1", email: "owner@drmed.ph", full_name: "Ian Jamila", role: "admin" };
const EMAIL = { ok: true, kind: "email", period: { from: "2026-09-28", to: "2026-10-04" }, subject: "Patient sources, Wk of 28 Sep: 12 new (▲ 4)", html: "<p>h</p>", text: "t" };

beforeEach(() => {
  fx.requireAdmin.mockReset().mockResolvedValue(ADMIN);
  fx.build.mockReset().mockResolvedValue(EMAIL);
  fx.send.mockReset().mockResolvedValue({ ok: true, id: "em_1" });
  fx.audits.length = 0;
  delete process.env.NEXT_PUBLIC_SITE_URL;
});

describe("sendPatientSourcesPreviewAction", () => {
  it("refuses a non-admin: nothing is built, sent or logged", async () => {
    fx.requireAdmin.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(sendPatientSourcesPreviewAction("week")).rejects.toThrow("NEXT_REDIRECT");
    expect(fx.build).not.toHaveBeenCalled();
    expect(fx.send).not.toHaveBeenCalled();
    expect(fx.audits).toHaveLength(0);
  });

  it("sends the digest to the caller only, subject prefixed [Preview], no idempotency key", async () => {
    const res = await sendPatientSourcesPreviewAction("week");
    expect(res).toEqual({ ok: true, data: { sentTo: "owner@drmed.ph", periodFrom: "2026-09-28" } });
    expect(fx.build).toHaveBeenCalledWith(fx.admin, "week", expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), "https://drmed.ph");
    expect(fx.send).toHaveBeenCalledTimes(1);
    expect(fx.send.mock.calls[0]![0]).toEqual({
      to: "owner@drmed.ph",
      subject: "[Preview] Patient sources, Wk of 28 Sep: 12 new (▲ 4)",
      text: "t",
      html: "<p>h</p>",
    });
  });

  it("audits staff_alert.preview_sent as the staff member, and writes nothing else (no claim, no .sent)", async () => {
    await sendPatientSourcesPreviewAction("month");
    expect(fx.audits).toHaveLength(1);
    expect(fx.audits[0]).toMatchObject({
      actor_id: "admin-1",
      actor_type: "staff",
      action: "staff_alert.preview_sent",
      metadata: { alert_key: "patient_sources_monthly", period_from: "2026-09-28" },
      ip_address: "203.0.113.9",
    });
    expect(fx.build).toHaveBeenCalledWith(fx.admin, "month", expect.any(String), "https://drmed.ph");
  });

  it("surfaces a skipped send's reason (the shared emailStatus wording) and is not a success; nothing is logged", async () => {
    fx.send.mockResolvedValue({ ok: false, kind: "skipped", reason: "NOTIFICATIONS_LIVE not enabled in this environment" });
    expect(await sendPatientSourcesPreviewAction("week")).toEqual({ ok: false, error: "NOTIFICATIONS_LIVE not enabled in this environment" });
    expect(fx.audits).toHaveLength(0);
  });

  it("a send error is a plain failure", async () => {
    fx.send.mockResolvedValue({ ok: false, kind: "error", error: "Resend 500", definite: true });
    expect(await sendPatientSourcesPreviewAction("week")).toMatchObject({ ok: false, error: expect.stringMatching(/did not accept/) });
    expect(fx.audits).toHaveLength(0);
  });

  it("a digest that cannot be built, or is too early, sends nothing", async () => {
    fx.build.mockResolvedValue({ ok: false, message: "report: down" });
    expect(await sendPatientSourcesPreviewAction("week")).toMatchObject({ ok: false });
    fx.build.mockResolvedValue({ ok: true, kind: "too_early", period: { from: "2023-11-01", to: "2023-11-30" } });
    expect(await sendPatientSourcesPreviewAction("month")).toMatchObject({ ok: false, error: expect.stringMatching(/first date/) });
    expect(fx.send).not.toHaveBeenCalled();
  });

  it("refuses an admin with no email address, and any kind other than week/month", async () => {
    fx.requireAdmin.mockResolvedValue({ ...ADMIN, email: "" });
    expect(await sendPatientSourcesPreviewAction("week")).toMatchObject({ ok: false, error: expect.stringMatching(/no email address/) });
    fx.requireAdmin.mockResolvedValue(ADMIN);
    expect(await sendPatientSourcesPreviewAction("year" as never)).toMatchObject({ ok: false });
    expect(fx.build).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run** `npx vitest run "src/app/(staff)/staff/(dashboard)/admin/settings/alerts"` → FAIL (module missing).

- [ ] **Step 3: Implement** `preview-actions.ts`

```ts
"use server";

// Admin Tools › Email Alerts — "Send me a preview" for the two Patient Sources emails.
// Modelled on sendTestAlertAction (actions.ts): requireAdminStaff() is the EFFECTIVE-role
// gate every action on this page uses; the input is validated; the service-role client is
// used only to read the numbers. It emails ONLY the signed-in admin, never the alert's
// recipients, and never touches the send-claim table or the `.sent` audit row — a preview
// can neither count as the real send nor block it.

import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { audit } from "@/lib/audit/log";
import { ipAndAgent } from "@/lib/server/action-helpers";
import { todayManilaISODate } from "@/lib/dates/manila";
import { sendEmail } from "@/lib/notifications/email";
import { DIGEST_ALERT_KEY, type DigestKind } from "@/lib/marketing/patient-sources-digest";
import { buildPatientSourcesDigestEmail } from "@/lib/marketing/patient-sources-digest.server";

type ActionDataResult<T> = { ok: true; data: T } | { ok: false; error: string };

const KindSchema = z.enum(["week", "month"]);

export async function sendPatientSourcesPreviewAction(
  kind: DigestKind,
): Promise<ActionDataResult<{ sentTo: string; periodFrom: string }>> {
  const session = await requireAdminStaff();
  const parsed = KindSchema.safeParse(kind);
  if (!parsed.success) return { ok: false, error: "Could not read which email to preview." };
  if (!session.email) {
    return { ok: false, error: "Your account has no email address on file, so there is nowhere to send a preview." };
  }

  const built = await buildPatientSourcesDigestEmail(
    createAdminClient(),
    parsed.data,
    todayManilaISODate(),
    process.env.NEXT_PUBLIC_SITE_URL ?? "https://drmed.ph",
  );
  if (!built.ok) return { ok: false, error: "Couldn't build the preview from the numbers right now — try again in a minute." };
  if (built.kind === "too_early") {
    return { ok: false, error: "There is nothing to preview yet: that period starts before Patient Sources' first date." };
  }

  const result = await sendEmail({ to: session.email, subject: `[Preview] ${built.subject}`, text: built.text, html: built.html });
  if (!result.ok) {
    // A skipped send carries emailStatus()'s own wording ("NOTIFICATIONS_LIVE not enabled…", "…not configured").
    return { ok: false, error: result.kind === "skipped" ? result.reason : "The email service did not accept the preview — try again." };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "staff_alert.preview_sent",
    resource_type: "staff_alert_settings",
    resource_id: null,
    metadata: { alert_key: DIGEST_ALERT_KEY[parsed.data], period_from: built.period.from },
    ip_address: ip,
    user_agent: ua,
  });
  return { ok: true, data: { sentTo: session.email, periodFrom: built.period.from } };
}
```

- [ ] **Step 4: Run** the folder's tests → PASS; `npx tsc --noEmit 2>&1 | head -5`; `npx eslint "src/app/(staff)/staff/(dashboard)/admin/settings/alerts"` → clean.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/admin/settings/alerts/preview-actions.ts" "src/app/(staff)/staff/(dashboard)/admin/settings/alerts/preview-actions.test.ts"
git commit -m "feat(alerts): send-me-a-preview action for the Patient Sources emails" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Email Alerts card — the preview button and the shared Last-sent line (**controller edits directly**)

Sonnet implementers stalled editing big page/client files; the controller makes these four edits to `src/app/(staff)/staff/(dashboard)/admin/settings/alerts/client.tsx` by hand. Match the existing pattern for the test-alert feedback (`testing` / `testResult` / `testError`, `startTransition`, green `text-xs text-green-700` / red `text-xs text-red-600` spans) — do not invent a new one.

**Files:** Modify `…/alerts/client.tsx` (no new test file: the action and the wording are tested in Tasks 9–10; the browser smoke in Task 14 covers the button).

- [ ] **Step 1: Imports and the kind map.** Replace `import type { AlertLastSentSummary } from "@/lib/notifications/alert-last-sent";` with:

```tsx
import { alertLastSentLine, type AlertLastSentSummary } from "@/lib/notifications/alert-last-sent";
```
and after the `./actions` import block add:

```tsx
import { sendPatientSourcesPreviewAction } from "./preview-actions";

// The two Patient Sources emails get a "Send me a preview" button; the other alerts do not.
const PREVIEW_KIND: Partial<Record<StaffAlertKey, "week" | "month">> = {
  patient_sources_weekly: "week",
  patient_sources_monthly: "month",
};
```

- [ ] **Step 2: State and handler.** After `const [testError, setTestError] = useState<string | null>(null);` add:

```tsx
  const [previewing, setPreviewing] = useState(false);
  const [previewResult, setPreviewResult] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewKind = PREVIEW_KIND[alertKey];
```
and after the `sendTest` function add:

```tsx
  function sendPreview() {
    if (!previewKind) return;
    setPreviewError(null);
    setPreviewResult(null);
    setPreviewing(true);
    startTransition(async () => {
      const res = await sendPatientSourcesPreviewAction(previewKind);
      startTransition(() => {
        setPreviewing(false);
        if (res.ok) setPreviewResult(`Preview sent to ${res.data.sentTo}.`);
        else setPreviewError(res.error);
      });
    });
  }
```

- [ ] **Step 3: The Last-sent line.** Replace the three lines

```tsx
            {manilaDateTime(lastSent.at)} — sent to {lastSent.sent} of {lastSent.recipients}
            {lastSent.failed > 0 ? `, ${lastSent.failed} failed` : ""}
            {lastSent.skipped ? ` (${lastSent.skipped})` : ""}
```
with

```tsx
            {manilaDateTime(lastSent.at)} — {alertLastSentLine(lastSent)}
```
(the same words, now unit-tested; a digest run that found everyone already emailed reads `sent to 0 of 3 (already sent to everyone for this period)`).

- [ ] **Step 4: The button.** Immediately after the `{testError && …}` span, still inside the "Send a test" `<div>`, add:

```tsx
        {previewKind && (
          <button
            type="button"
            onClick={sendPreview}
            disabled={previewing}
            className="min-h-9 rounded-md border border-[color:var(--color-brand-navy)] px-3 py-1.5 text-sm font-semibold text-[color:var(--color-brand-navy)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {previewing ? "Sending…" : "Send me a preview"}
          </button>
        )}
        {previewResult && <span className="text-xs text-green-700">{previewResult}</span>}
        {previewError && <span className="text-xs text-red-600">{previewError}</span>}
```

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit 2>&1 | head -5; npx eslint "src/app/(staff)/staff/(dashboard)/admin/settings/alerts"; npx vitest run "src/app/(staff)/staff/(dashboard)/admin/settings" 2>&1 | tail -4`
Expected: no output from tsc/eslint; tests PASS. Also `git grep -n "seven\b" -- "src/app/(staff)/staff/(dashboard)/admin/settings/alerts"` → no stale "seven alerts" copy on the page.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/admin/settings/alerts/client.tsx"
git commit -m "feat(alerts): Send me a preview on the Patient Sources cards; one tested Last-sent line" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: `npm run email:preview`

**Files:** Create `scripts/lib/email-preview-args.ts`, `scripts/lib/email-preview-args.test.ts`, `scripts/email-preview.mts`; Modify `package.json`.

Follows `scripts/first-night-check.ts` + `scripts/lib/first-night-args.ts` exactly: `load-env` first, `requireLocalOrExplicitProd` before any client (read-only), lazy `await import(...)` of `src` modules, `--prod`/`--yes` owned by `env-guard`. `.mts` is covered by `guard-coverage.test.ts` (`/\.(ts|mts|mjs|js)$/`). Imports of `src` use relative paths, as `first-night-args.ts` does.

- [ ] **Step 1: Failing test** `scripts/lib/email-preview-args.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { EXIT_USAGE, parseEmailPreviewArgs, previewFileBase } from "./email-preview-args";

describe("parseEmailPreviewArgs", () => {
  it("defaults to the weekly Patient Sources email for the real today", () => {
    expect(parseEmailPreviewArgs(["patient-sources"])).toEqual({ ok: true, email: "patient-sources", kind: "week", today: null });
  });
  it("--month picks the monthly email; --today overrides the date (both = and space forms)", () => {
    expect(parseEmailPreviewArgs(["patient-sources", "--month", "--today", "2026-10-01"])).toEqual({
      ok: true, email: "patient-sources", kind: "month", today: "2026-10-01",
    });
    expect(parseEmailPreviewArgs(["patient-sources", "--today=2026-10-05"])).toMatchObject({ ok: true, today: "2026-10-05" });
  });
  it("ignores the runner flags env-guard owns (--prod, --yes)", () => {
    expect(parseEmailPreviewArgs(["patient-sources", "--prod", "--yes"])).toMatchObject({ ok: true, kind: "week" });
  });
  it("refuses a missing or unknown email name, extra words, unknown flags and bad dates", () => {
    expect(parseEmailPreviewArgs([])).toMatchObject({ ok: false });
    expect(parseEmailPreviewArgs(["receipts"])).toMatchObject({ ok: false, errors: [expect.stringMatching(/patient-sources/)] });
    expect(parseEmailPreviewArgs(["patient-sources", "extra"])).toMatchObject({ ok: false });
    expect(parseEmailPreviewArgs(["patient-sources", "--send"])).toMatchObject({ ok: false, errors: [expect.stringMatching(/--send/)] });
    expect(parseEmailPreviewArgs(["patient-sources", "--today"])).toMatchObject({ ok: false });
    expect(parseEmailPreviewArgs(["patient-sources", "--today", "2026-02-31"])).toMatchObject({ ok: false });
    expect(parseEmailPreviewArgs(["patient-sources", "--today", "tomorrow"])).toMatchObject({ ok: false });
  });
  it("names the output files by period", () => {
    expect(previewFileBase("week", "2026-09-28")).toBe("patient-sources-week-2026-09-28");
    expect(previewFileBase("month", "2026-09-01")).toBe("patient-sources-month-2026-09-01");
    expect(EXIT_USAGE).toBe(64);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run scripts/lib/email-preview-args.test.ts` → FAIL.

- [ ] **Step 3: Implement** `scripts/lib/email-preview-args.ts`

```ts
/**
 * Argument parsing for `scripts/email-preview.mts`. Pure (no env, no clients), so it
 * can be unit-tested. Runner flags owned by env-guard (`--prod`, `--yes`) are ignored.
 */
import { shiftISODate } from "../../src/lib/dates/manila";

export type EmailPreviewArgs =
  | { ok: true; email: "patient-sources"; kind: "week" | "month"; today: string | null }
  | { ok: false; errors: string[] };

/** sysexits EX_USAGE — a bad flag or value (nothing was read). */
export const EXIT_USAGE = 64;

export function parseEmailPreviewArgs(argv: readonly string[]): EmailPreviewArgs {
  const errors: string[] = [];
  const words: string[] = [];
  let kind: "week" | "month" = "week";
  let today: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      words.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (name === "prod" || name === "yes") continue;
    if (name === "month") {
      kind = "month";
      continue;
    }
    if (name === "today") {
      const value = eq !== -1 ? arg.slice(eq + 1) : i + 1 < argv.length && !argv[i + 1]!.startsWith("--") ? argv[++i]! : undefined;
      if (value === undefined) errors.push("--today needs a value like 2026-10-05.");
      else if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || shiftISODate(value, 0) !== value) errors.push(`--today must be a real date like 2026-10-05 (got “${value}”).`);
      else today = value;
      continue;
    }
    errors.push(`Unknown option --${name}.`);
  }

  if (words.length === 0) errors.push("Say which email: patient-sources.");
  else if (words[0] !== "patient-sources") errors.push(`Unknown email “${words[0]}” — the only one is patient-sources.`);
  else if (words.length > 1) errors.push(`Unexpected argument “${words[1]}”.`);

  return errors.length > 0 ? { ok: false, errors } : { ok: true, email: "patient-sources", kind, today };
}

export function previewFileBase(kind: "week" | "month", fromISO: string): string {
  return `patient-sources-${kind}-${fromISO}`;
}
```

- [ ] **Step 4: The runner** `scripts/email-preview.mts`

```ts
/**
 * Email preview — renders an owner email to files so you can look at it without
 * sending anything. Read-only: it never sends, never claims a send, never writes an
 * audit row; the only output is two files.
 *
 *   npm run email:preview -- patient-sources                     weekly, LOCAL database
 *   npm run email:preview -- patient-sources --month
 *   npm run email:preview -- patient-sources --today 2026-10-05  as if sent that day
 *   npm run email:preview -- patient-sources --prod --yes        the live numbers (read-only)
 *
 * Writes tmp/email-preview/patient-sources-{week|month}-{from}.html + .txt and prints
 * the paths. A period that starts before Patient Sources' first date prints a message
 * and exits 0. Exit codes: 0 ok / nothing to preview · 1 could not build · 64 bad flags.
 */
import "./lib/load-env";
import { requireLocalOrExplicitProd } from "./lib/env-guard";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT_USAGE, parseEmailPreviewArgs, previewFileBase } from "./lib/email-preview-args";

async function main() {
  // Read-only: still guarded (the report reads real patients' counts), banner says "will read".
  requireLocalOrExplicitProd("email:preview", {
    readOnly: true,
    writes: "nothing in the database — it reads Patient Sources numbers and writes two files under tmp/email-preview/",
  });

  const args = parseEmailPreviewArgs(process.argv.slice(2));
  if (!args.ok) {
    for (const e of args.errors) console.error(e);
    console.error("Usage: email:preview patient-sources [--month] [--today YYYY-MM-DD] [--prod --yes]");
    process.exit(EXIT_USAGE);
  }

  const { todayManilaISODate } = await import("../src/lib/dates/manila");
  const { createClient } = await import("@supabase/supabase-js");
  const { buildPatientSourcesDigestEmail } = await import("../src/lib/marketing/patient-sources-digest.server");

  const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const today = args.today ?? todayManilaISODate();
  const built = await buildPatientSourcesDigestEmail(client as never, args.kind, today, process.env.NEXT_PUBLIC_SITE_URL ?? "https://drmed.ph");

  if (!built.ok) {
    console.error(`Could not build the digest: ${built.message}`);
    process.exit(1);
  }
  if (built.kind === "too_early") {
    console.log(`Nothing to preview: the ${args.kind} ending ${built.period.to} starts before Patient Sources' first date (1 December 2023).`);
    process.exit(0);
  }

  const dir = join(process.cwd(), "tmp", "email-preview");
  mkdirSync(dir, { recursive: true });
  const base = join(dir, previewFileBase(args.kind, built.period.from));
  writeFileSync(`${base}.html`, built.html);
  writeFileSync(`${base}.txt`, `${built.subject}\n\n${built.text}\n`);
  console.log(`Subject: ${built.subject}`);
  console.log(`Period:  ${built.period.from} to ${built.period.to} (as if sent ${today})`);
  console.log(`Wrote ${base}.html`);
  console.log(`Wrote ${base}.txt`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
```

- [ ] **Step 5: npm script.** In `package.json` add next to `first-night:check`: `"email:preview": "tsx --require ./scripts/lib/server-only-shim.cjs scripts/email-preview.mts",`.

- [ ] **Step 6: Run the tests and the guard**

Run: `npx vitest run scripts/lib 2>&1 | tail -6` → PASS, including `guard-coverage.test.ts` (the `.mts` calls `requireLocalOrExplicitProd` before `createClient`, and imports `./lib/load-env` first).

- [ ] **Step 7: Run it against the isolated stack** (empty data, so the numbers are zeros — this proves the wiring, `@/` alias resolution under tsx, the shim and the files)

```bash
export NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:56421
export SUPABASE_SERVICE_ROLE_KEY=$(npx supabase status --workdir $SP -o env | sed -n 's/^SERVICE_ROLE_KEY="\(.*\)"$/\1/p')
npm run -s email:preview -- patient-sources --today 2026-10-05; echo "exit=$?"
npm run -s email:preview -- patient-sources --month --today 2026-10-01; echo "exit=$?"
npm run -s email:preview -- patient-sources --month --today 2023-12-15; echo "exit=$?"
npm run -s email:preview -- patient-sources --send; echo "exit=$?"
ls -l tmp/email-preview; head -12 tmp/email-preview/patient-sources-week-2026-09-28.txt
```
Expected: `Subject: Patient sources, Wk of 28 Sep: 0 new (= 0)` + two `Wrote` lines + `exit=0`; the monthly run writes `patient-sources-month-2026-09-01.*`; the Dec-2023 run prints `Nothing to preview…` and `exit=0`; the bad flag prints `Unknown option --send.` and `exit=64`. The text file shows `No new patients recorded this week`, `No ad spend saved for this week.` and the Ad Performance hint. If tsx reports `Cannot find module '@/…'`, pass the repo tsconfig explicitly in the npm script (`tsx --tsconfig tsconfig.json …`) and re-run. `unset NEXT_PUBLIC_SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY` afterwards. Open the `.html` in a browser (`open tmp/email-preview/patient-sources-week-2026-09-28.html`) and eyeball the layout once.

- [ ] **Step 8: Commit**

```bash
git add scripts/lib/email-preview-args.ts scripts/lib/email-preview-args.test.ts scripts/email-preview.mts package.json
git commit -m "feat(scripts): npm run email:preview renders the Patient Sources email to files, read-only" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Docs — CLAUDE.md, the user guide, and the page's shared sheet-dates wording (guide **version bump is NOT here**)

**Files:** Modify `CLAUDE.md`, `docs/drmed-user-guide.html`, `src/app/(staff)/staff/(dashboard)/marketing/patients/page.tsx` (**controller edits directly**).

- [ ] **Step 1: Page uses the shared wording (controller).** In `marketing/patients/page.tsx`: delete the `SHEET_TABS` constant (line ~25); delete the three declarations `const lastDates = …`, `const serviceDates = …`, `const registrationDate = …` (lines ~95–97); replace the two JSX expressions that build "Latest service date in the sheet…" and "Latest registration date in the sheet…" (lines ~150–155) with one `{sheetDatesText(s)}`; add `sheetDatesText` to the `@/lib/marketing/patient-sources` import. Then `npx eslint "src/app/(staff)/staff/(dashboard)/marketing/patients/page.tsx"` — remove `manilaDate` from the manila import only if eslint reports it unused (`manilaDateTime` is still used by the "Last sync" line). Run `npx vitest run src/lib/marketing 2>&1 | tail -4` and `npx tsc --noEmit 2>&1 | head -3` → clean. The rendered text is byte-identical to before (Task 1's `sheetDatesText` test pins the wording).

- [ ] **Step 2: CLAUDE.md.**
  - In the migration-ledger paragraph (line ~30) put at the very front, before `**0208**`: ``**<N>** (`patient_sources_digest`, Patient Sources 5b — the weekly + monthly owner emails: `staff_alert_settings_key_check` re-created with `patient_sources_weekly` / `patient_sources_monthly` (+ seed rows), service-role-only claim table `patient_sources_digest_sends` (RLS on, no policy, re-revoked in `seed.sql`, allow-listed in the 0151 smoke), closed claim function `_ps_digest_claim` (SECURITY INVOKER, EXECUTE service_role only — proven by `npm run ps-digest-claim:concurrency-proof -- --control`), `service_role` SELECT on `ad_spend_daily`; pushed <date>, verified by object) over `` and fix the prod-head sentence to `prod head = <N>`.
  - Append to the Patient Sources row of the file/subsystem table (line ~272), before the closing `|`-column: ``; owner emails: pure `patient-sources-digest.ts` (periods, retry validation, spend roll-up, renderer), `patient-sources-digest.server.ts` (two report calls through the shared loader + a paged, count-re-checked `ad_spend_daily` read — never the admin-only RPCs: a service-key call to them is a refused call and crashes prod's current Postgres image), `patient-sources-digest-cron.server.ts` (per-recipient claim → send → record, at most once; `unknown` is never re-sent automatically), crons `/api/cron/patient-sources-weekly` (Sun 23:00 UTC = Mon 07:00 Manila) and `-monthly` (1st 00:00 UTC), "Send me a preview" (`admin/settings/alerts/preview-actions.ts`), `npm run email:preview` ``.
  - Add two rows to the Commands table (after `npm run merge:concurrency-proof`):

```
| `npm run ps-digest-claim:concurrency-proof [-- --control]` | Two-session races for the Patient Sources owner-email claim `_ps_digest_claim` (<N>) — 5 scenarios (fresh / failed / free race / stale `sending` / `include_unknown`) + 2 mutant controls. Local or isolated stack only |
| `npm run email:preview -- patient-sources [--month] [--today YYYY-MM-DD] [--prod --yes]` | Renders the weekly/monthly Patient Sources email to `tmp/email-preview/*.html` + `.txt`. Read-only: never sends, claims or audits. Local stack by default; `--prod --yes` reads the live numbers |
```

- [ ] **Step 3: The guide** (`docs/drmed-user-guide.html`; the version line stays at its current number until Task 15).
  - **5.2 intro** (`<p class="intro">`): after `result-template problems and possible duplicate patients` insert `, and the weekly and monthly patient sources emails`.
  - Change `<p>One card per alert — seven in all:</p>` to `<p>One card per alert — nine in all:</p>`.
  - After the `<dt>Possible duplicate patients</dt><dd>…</dd>` pair add:

```html
      <dt>Weekly patient sources</dt><dd>Sent every Monday at 7:00 AM, before the clinic opens: last week's (Monday to Sunday) new patients by channel, customers served, returning customers, revenue by channel, the top five referring doctors and the cost per new patient, each set against the week before, with the channel that moved the most called out. Sunday is labelled <q>Sun (half day)</q>. It ends with <q>Numbers as of …</q> and a button to Patient Sources; it never shows a patient's name or contact details. If no ad spend has been saved it says <q>No ad spend saved for this week</q> instead of ₱0 — save spend from Ad Performance with <kbd class="ui">Save them to clinic records</kbd>. Goes by default to <b>Admin</b>.</dd>
      <dt>Monthly patient sources</dt><dd>Sent on the 1st of the month at 8:00 AM: the same for last month against the month before. Goes by default to <b>Admin</b>.</dd>
```
  - After the `<kbd class="ui">Send a test</kbd>` paragraph add:

```html
    <p><kbd class="ui">Send me a preview</kbd> (on the two patient sources cards only) emails <b>you alone</b> — never the other recipients — that period's digest, built from today's numbers, with <q>[Preview]</q> at the start of the subject. A preview never counts as the real send and never stops it. If this site can't send email (it isn't the live site), the line beside the button says why instead of <q>Preview sent to …</q>.</p>
    <div class="note why"><span class="k">If a patient sources email didn't arrive</span><div><p>Each recipient gets each week's and month's email at most once. If the system can't be sure an email left (for example the connection dropped mid-send) it does <b>not</b> send it again by itself, and Cron Health shows the task as failing. Check the Resend dashboard for that recipient. If it really didn't leave, an administrator re-sends that one period with the cron secret: <code>curl -H "Authorization: Bearer $CRON_SECRET" "https://drmed.ph/api/cron/patient-sources-weekly?period_from=2026-10-05&amp;include_unknown=1"</code>. <code>period_from</code> must be the Monday of a finished week (the 1st of a finished month for <code>patient-sources-monthly</code>), at most 62 days back; leave out <code>include_unknown=1</code> to retry only emails Resend definitely refused. Anyone switched off in Email Alerts since is not emailed. The card's <b>Last sent</b> reads <q>sent to 0 of 3 (already sent to everyone for this period)</q> when a run found everyone already emailed.</p></div></div>
```
  - In the Patient Sources paragraph (line ~1208, after the sentence ending the banner explanation) add: ` Admins also get this report by email — <b>Weekly patient sources</b> every Monday and <b>Monthly patient sources</b> on the 1st — see 5.2.`
  - In the footer line (`drmed.ph User Guide · v2.63 · …Matches the production release at migration 0186, plus 0196 (…`) add `<N> (Patient Sources weekly and monthly owner emails)` to the list of migrations — number only; the version number and date wait for Task 15.

- [ ] **Step 4: Verify** `npx vitest run 2>&1 | tail -6` is deferred to Task 14; here just `git diff --stat` shows only the three files plus CLAUDE.md, and `grep -c "nine in all" docs/drmed-user-guide.html` → `1`.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/drmed-user-guide.html "src/app/(staff)/staff/(dashboard)/marketing/patients/page.tsx"
git commit -m "docs(guide): weekly and monthly patient sources emails, preview button, retry note" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: Gate, full replay, browser smoke

**Files:** none (fixes go in the task that owns the file).

- [ ] **Step 1: The full gate**

```bash
npm test > $SCRATCH/test-5b.log 2>&1; echo test=$?; tail -8 $SCRATCH/test-5b.log
npm run typecheck > $SCRATCH/tsc-5b.log 2>&1; echo tsc=$?
npm run lint > $SCRATCH/lint-5b.log 2>&1; echo lint=$?
npm run build > $SCRATCH/build-5b.log 2>&1; echo build=$?; tail -5 $SCRATCH/build-5b.log
```
Expected: `test=0` (all files pass; includes `seed-grant-parity`, `staff-alerts`, `concurrency-proof-guard`, `cron-heartbeats`, `cron-schedule`, `guard-coverage`, `patient-sources-surfaces`, `date-render-surfaces` and `manila-usage` — the digest uses `bucketLabel` / `manilaDate` / `asOfLabel` only and a fixed weekday-label array, never an inline date format), `tsc=0`, `lint=0`, `build=0` with both new routes listed (`ƒ /api/cron/patient-sources-weekly`, `ƒ /api/cron/patient-sources-monthly`). A `manila-usage` failure means a hand-rolled date crept in: use `manilaISODate` / `shiftISODate`, or add an allow-list entry with a `why` only if it is genuinely a weekday helper.

- [ ] **Step 2: Re-prove the database from scratch** (migrations + seed on the isolated stack, then everything DB-side)

```bash
rsync -a --delete supabase/migrations/ $SP/supabase/migrations/ && rsync -a supabase/seed.sql $SP/supabase/seed.sql
npx supabase db reset --workdir $SP > $SP/reset2.log 2>&1; echo reset=$?
$PSQL $DB -v ON_ERROR_STOP=1 -f supabase/tests/<N>_patient_sources_digest_smoke.sql 2>&1 | tail -2
$PSQL $DB -v ON_ERROR_STOP=1 -f supabase/tests/0151_rls_initplan_smoke.sql 2>&1 | tail -4
SUPABASE_DB_URL=$DB npm run -s ps-digest-claim:concurrency-proof -- --control 2>&1 | tail -8
SUPABASE_DB_URL=$DB npm run -s patient-sources:db-proof 2>&1 | tail -2
npm run db:types -- --workdir $SP && git diff --stat src/types/database.ts
```
Expected: `reset=0`; the smoke prints its OK notice; 0151 prints its three notices; the proof ends `5/5 scenarios passed.` + both controls ok; `patient-sources:db-proof` still `N/N checks passed.` (0206's report functions are untouched); the types diff is empty (already committed in Task 4).

- [ ] **Step 3: Browser smoke (Playwright MCP, not claude-in-chrome).** Start the dev server with the isolated stack's URL/keys in its env (port **4000**, the only localhost callback in Supabase's redirect allowlist; the isolated stack's auth will not know the real admin, so use the cookie-injection recipe — memory `feedback_authed_playwright_session_injection` — against a seeded admin on the isolated stack, or sign in as Ian Jamila (admin) on a dev server pointed at the shared local stack if the 0155 settings rows exist there). Verify with TEXT first (`browser_snapshot`, `browser_evaluate`), one screenshot at most:
  1. `/staff/admin/settings/alerts` lists **nine** cards; `Weekly patient sources` and `Monthly patient sources` each show **Send me a preview** (the other seven do not), and **Never sent yet.**
  2. Click **Send me a preview** on the weekly card: the button reads `Sending…`, then the red line shows the non-production reason (`NOTIFICATIONS_LIVE not enabled in this environment`) — not `Preview sent`. (With `NOTIFICATIONS_LIVE=true` plus a throwaway Resend key unset the line reads the "not configured" wording; do not send real mail from a dev box.)
  3. `/staff/marketing/patients` still shows `Latest service date in the sheet: …` unchanged (Task 13 Step 1).
  4. A signed-in **non-admin** (reception) cannot reach the page (redirected), and calling the action as one is refused (Task 10's test covers the logic).
  Record the observations in the PR body.

- [ ] **Step 4: Commit any fixes** (each in the task that owns the file, `fix(...)` messages) and re-run Step 1 until green.

---

### Task 15: Ship — prod migration, merge, guide version, first-run check

Ordering rule (CLAUDE.md "apply to prod BEFORE merging"): the Vercel production deploy of this code must never run ahead of its migration. The new cron routes read the claim table and call `_ps_digest_claim`; the Email Alerts page lists the two new keys — both break against a prod without `<N>`.

- [ ] **Step 1: Pre-flight.** `git fetch -q origin`; confirm PR #292 (5a) has merged (else this PR stays stacked and merges after it); `git merge origin/main` if needed and re-run Task 14 Step 1. `npm run claim -- list` shows `<N>` held by this branch and no collision; re-check the prod ledger is still headed by `0208` (read-only MCP `list_migrations`, or `select max(version) from supabase_migrations.schema_migrations`). Confirm the `activeFrom` dates from Task 5 are still after the deploy (recompute with the Task 5 one-liner if the merge slipped past Sunday 2026-10-04 23:00 UTC).

- [ ] **Step 2: Dry-run against prod from this worktree**

```bash
cp ~/Claude/DRMed/supabase/.temp/{project-ref,linked-project.json,pooler-url} supabase/.temp/ 2>/dev/null || (mkdir -p supabase/.temp && cp ~/Claude/DRMed/supabase/.temp/{project-ref,linked-project.json,pooler-url} supabase/.temp/)
/opt/homebrew/bin/supabase db push --dry-run
```
Expected: exactly one pending migration, `<N>_patient_sources_digest.sql`, and nothing else (a second name means another branch's migration is unapplied — stop and reconcile, never push it blind). The dry-run's "up to date" with a pending file means a duplicate number (memory `supabase-db-push-remote-only-migration`): stop.

- [ ] **Step 3: Push (the user approves the permission prompt)**

Run: `/opt/homebrew/bin/supabase db push` (add `--include-all` only if the dry-run listed `<N>` below an already-applied higher number). It stamps the real `<N>` ledger version; never MCP `apply_migration`.

- [ ] **Step 4: Verify by object** (read-only MCP `execute_sql`; if the classifier blocks a read, ask the user to run the SELECT in the Supabase SQL editor)

```sql
select version from supabase_migrations.schema_migrations where version = '<N>';
select pg_get_constraintdef(oid) like '%patient_sources_weekly%' and pg_get_constraintdef(oid) like '%patient_sources_monthly%' and pg_get_constraintdef(oid) like '%result_released%' as keys_ok
  from pg_constraint where conname = 'staff_alert_settings_key_check';
select alert_key, enabled from public.staff_alert_settings where alert_key like 'patient_sources_%' order by 1;
select c.relrowsecurity, (select count(*) from pg_policy p where p.polrelid = c.oid) as policies, c.relacl::text
  from pg_class c where c.oid = 'public.patient_sources_digest_sends'::regclass;
select p.prosecdef, p.proacl::text from pg_proc p where p.oid = 'public._ps_digest_claim(text,date,date,text,boolean)'::regprocedure;
select has_table_privilege('service_role', 'public.ad_spend_daily', 'SELECT') as spend_read,
       has_function_privilege('anon', 'public._ps_digest_claim(text,date,date,text,boolean)', 'execute') as anon_exec,
       has_function_privilege('authenticated', 'public._ps_digest_claim(text,date,date,text,boolean)', 'execute') as auth_exec;
```
Expected: one ledger row; `keys_ok = true`; two rows both `enabled = true`; RLS `true`, `0` policies, an ACL naming only `postgres` and `service_role`; `prosecdef = false` with an ACL naming only `postgres` and `service_role`; `spend_read = true`, `anon_exec = false`, `auth_exec = false`. Run nothing against `_ps_digest_claim` itself on prod.

- [ ] **Step 5: Guide version bump (at merge time only).** Read the current number (`grep -n "User guide · v" docs/drmed-user-guide.html`; it was v2.63 when this plan was written), bump the minor in all three places — the `toc-tag` (`User guide · vX.YY`), the `<strong>Version</strong>X.YY · <date>` line, and the footer sentence — set the date to the merge day, and keep the `<N>` mention added in Task 13. Commit `docs(guide): vX.YY — patient sources emails`.

- [ ] **Step 6: Open the PR and merge.** Body: the plain-English "what was done" bullets, the Task 4 proof outputs (the `5/5` runs, both `control … ok` lines, the 100-round run), the isolated-stack replay result, the browser-smoke observations, and the prod-verification output. Merge via the repo's merge flow; confirm the Vercel production deploy is READY. (Only after the merge does Vercel register the two new crons.)

- [ ] **Step 7: Post-deploy checks.**
  1. `curl -s -o /dev/null -w "%{http_code}\n" https://drmed.ph/api/cron/patient-sources-weekly` → `401` (never call it with the secret outside a real retry: it emails the admins).
  2. Ask the owner for an explicit OK, then `npm run email:preview -- patient-sources --prod --yes --today <the next Monday>` and compare the printed headline numbers with Patient Sources for that week (same snapshot logic, so they must agree). Read-only.
  3. On Email Alerts (live site) click **Send me a preview** on each card: a real `[Preview]` email arrives in the signed-in admin's inbox only; the audit log shows `staff_alert.preview_sent`.
  4. After the first scheduled run (Monday 07:00 Manila): the card's **Last sent** reads `… — sent to N of N`; `select status, count(*) from public.patient_sources_digest_sends group by 1;` shows only `sent`; Cron Health shows `Patient sources email (weekly)` healthy. After the first monthly run (1st, 08:00 Manila) the same for the monthly card.
  5. A `failed` or `unknown` row, or a red monitor, follows the guide's retry note — never a blind re-run.

- [ ] **Step 8: Rollback / follow-ups.** Rollback is: switch both alert keys off in Email Alerts (nothing else depends on them); a forward migration may drop the claim table later. Update memory `drmed-sheet-sync` (5b merged, `<N>` on prod, NEXT = 5c) and tear the isolated stack down with `npx supabase stop --workdir $SP --no-backup` (this stops only `drmed-ps5b`; confirm with `docker ps | grep drmed-ps5b` → none and that the shared `supabase_db_DRMed` is still up).

---

## Suggestions to prune (out of scope — owner decides)

Cheap: the same "Send me a preview" button on the other alerts; a plain "this week at a glance" first line in the subject for the monthly email; the 8-week sparkline from the dashboard card embedded as an inline image. Medium: attach the Patient Sources CSV to the monthly email; a channel-drop alert (>50% two weeks running, already in the spec's follow-ups); a "recipients and their last delivery" table on Email Alerts reading `patient_sources_digest_sends`. Larger: a small operator button on Cron Health to retry a failed period (calls the same `?period_from=` path with an admin session instead of `curl` + the cron secret); update the public site's opening hours to include Sunday 8–12 (spec §7).
