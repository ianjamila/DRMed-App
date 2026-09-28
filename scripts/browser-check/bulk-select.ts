/**
 * Guarded, local-only, signed-in headless-Chrome checklist for every
 * bulk-select behaviour this PR (bulk-select follow-ups) added: fixed bars,
 * keyboard jump, named outcomes, dated callbacks, chemistry panels, Undo,
 * and the audit-log bulk filter. Every check ASSERTS via c.expect — it never
 * just logs.
 *
 *   npm run check:bulk-select
 *
 * Needs: local Supabase up, a dev server on the LOCAL env at APP_BASE
 * (default http://localhost:3007 — see README in scripts/browser-check/lib.ts),
 * and `npm run seed:test && npm run seed:hmo` already run once. This script
 * re-seeds the BSQ fixtures (scripts/seed/bulk-select-fixtures.sql) itself, at
 * the start and again between sections whose state the next section can't
 * tolerate — never `db reset`.
 *
 * Each check is its own try/catch (via the `check()` helper) so one broken
 * check never hides the rest.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import {
  APP_BASE,
  BAR,
  VISIT_BAR,
  barText,
  headerBox,
  newPageFromState,
  outcomeText,
  pinnedBottom,
  rowBoxes,
  setInactiveRole,
  signIn,
  sleep,
  startCheck,
  waitForCount,
  type CheckContext,
  type StorageState,
} from "./lib";

const FIXTURE_SQL = readFileSync(
  join(__dirname, "..", "seed", "bulk-select-fixtures.sql"),
  "utf8",
);

const ADMIN = { email: "admin@drmed.ph", password: "AdminPass123!" };
// Seeded as an active medtech by `npm run seed:bulk-fixtures -- --as=medtech`
// (run once before this script, or by this script's own reseed — the fixture
// SQL itself never touches staff_profiles.role, so the role set at seed time
// sticks across every reseed in this run).
const MED = { email: "inactive@drmed.ph", password: "InactivePass123!" };

async function reseed(c: CheckContext): Promise<void> {
  await c.sql(FIXTURE_SQL);
}

async function goto(page: Page, url: string): Promise<void> {
  await page.goto(url);
  // Static HTML is server-rendered; give client components a beat to
  // hydrate before the first interaction.
  await sleep(400);
}

interface CheckResult {
  ok: boolean;
  detail?: unknown;
}

async function check(
  c: CheckContext,
  label: string,
  fn: () => Promise<CheckResult>,
): Promise<void> {
  try {
    const r = await fn();
    c.expect(label, r.ok, r.detail);
  } catch (err) {
    c.expect(label, false, err instanceof Error ? err.message : String(err));
  }
}

async function evalInBar(page: Page, barSelector: string) {
  return page.evaluate((sel) => {
    const bar = document.querySelector(sel);
    const el = document.activeElement;
    const inActions = !!(el && el.closest("[data-bar-actions]"));
    return {
      inBar: !!(bar && el && bar.contains(el)),
      inActions,
      tag: el?.tagName ?? null,
      text: el instanceof HTMLElement ? el.textContent?.trim() : null,
    };
  }, barSelector);
}

// ---------------------------------------------------------------------------
// Fixed bars (item 1)
// ---------------------------------------------------------------------------
async function sectionFixedBars(c: CheckContext, med: Page, admin: Page): Promise<void> {
  await check(c, "F1 queue bar is fixed at the viewport bottom", async () => {
    await goto(med, `${APP_BASE}/staff/queue?q=BSQ`);
    await rowBoxes(med).first().check();
    await med.waitForSelector(BAR, { timeout: 10_000 });
    const pos = await pinnedBottom(med, BAR);
    return { ok: pos.fixed && pos.bottomGap <= 16, detail: pos };
  });

  await check(c, "F2 visit Tests bar is fixed", async () => {
    const [v] = await c.sql("select id from visits where visit_number = '9101'");
    const [glu] = await c.sql("select id from services where code = 'BSQ-CBC'");
    // Deliberate one-off fixture tweak, local scope only: the visit page's own
    // selection bar only offers a checkbox on ready_for_release/released rows
    // (release/unrelease), and every BSQ fixture test starts at "requested".
    await c.sql(
      "update test_requests set status = 'ready_for_release' where visit_id = $1 and service_id = $2",
      [v.id, glu.id],
    );
    await goto(admin, `${APP_BASE}/staff/visits/${v.id}`);
    const box = admin.locator('tbody input[type="checkbox"][aria-label^="Select"]').first();
    await box.check();
    await admin.waitForSelector(VISIT_BAR, { timeout: 10_000 });
    const pos = await pinnedBottom(admin, VISIT_BAR);
    return { ok: pos.fixed && pos.bottomGap <= 16, detail: pos };
  });

  await check(c, "F3 HMO new-batch footer is fixed", async () => {
    await goto(admin, `${APP_BASE}/staff/admin/accounting/hmo-claims/batches/new`);
    const saveBtn = admin.locator(
      'button:has-text("Create draft batch"), button:has-text("Add") ',
    ).first();
    await saveBtn.waitFor({ timeout: 10_000 });
    // Tie the check to the Save button's own footer, not the first
    // shadow-lg div on the page (fragile if another panel adds one).
    const handle = await saveBtn.evaluateHandle((btn) => btn.closest('div[class*="shadow-lg"]'));
    const found = await handle.evaluate((el) => el !== null);
    if (!found) return { ok: false, detail: "no shadow-lg ancestor of the Save/Create button" };
    const pos = await handle.evaluate((el) => {
      const box = el as HTMLElement;
      let n: HTMLElement | null = box;
      while (n && getComputedStyle(n).position !== "fixed") n = n.parentElement;
      const r = box.getBoundingClientRect();
      return { fixed: !!n, bottomGap: Math.round(innerHeight - r.bottom) };
    });
    return { ok: pos.fixed && pos.bottomGap <= 16, detail: pos };
  });

  await check(c, "F4 no sticky bottom element inside <main>", async () => {
    await goto(med, `${APP_BASE}/staff/queue`);
    const offenders = await med.evaluate(() => {
      const main = document.querySelector("main");
      if (!main) return null;
      const bad: string[] = [];
      for (const el of main.querySelectorAll<HTMLElement>("*")) {
        const s = getComputedStyle(el);
        if (s.position === "sticky" && s.bottom !== "auto") {
          bad.push(el.tagName + (el.className ? `.${String(el.className).split(" ")[0]}` : ""));
        }
      }
      return bad;
    });
    return { ok: Array.isArray(offenders) && offenders.length === 0, detail: offenders };
  });
}

// ---------------------------------------------------------------------------
// Keyboard jump (item 7) — each check is self-contained (fresh selection).
// ---------------------------------------------------------------------------
async function sectionKeyboard(c: CheckContext, med: Page): Promise<void> {
  await check(c, "K1 Enter on a row checkbox focuses the first bar action, not Clear", async () => {
    await goto(med, `${APP_BASE}/staff/queue?q=BSQ`);
    const box = rowBoxes(med).first();
    await box.focus();
    await box.press("Space");
    await med.waitForSelector(BAR, { timeout: 10_000 });
    await box.press("Enter");
    await sleep(300);
    const info = await evalInBar(med, BAR);
    return {
      ok: info.inBar && info.inActions && info.tag === "BUTTON" && info.text !== "Clear",
      detail: info,
    };
  });

  await check(c, "K2 Alt+B jumps from anywhere, to the first bar action, not Clear", async () => {
    await goto(med, `${APP_BASE}/staff/queue?q=BSQ`);
    const box = rowBoxes(med).first();
    await box.check();
    await med.waitForSelector(BAR, { timeout: 10_000 });
    await med.locator('button:has-text("Apply")').focus();
    await med.keyboard.press("Alt+B");
    await sleep(300);
    const info = await evalInBar(med, BAR);
    return {
      ok: info.inBar && info.inActions && info.tag === "BUTTON" && info.text !== "Clear",
      detail: info,
    };
  });

  await check(c, "K3 Escape in the bar clears and returns focus to the checkbox", async () => {
    await goto(med, `${APP_BASE}/staff/queue?q=BSQ`);
    const box = rowBoxes(med).first();
    await box.focus();
    await box.press("Space");
    await med.waitForSelector(BAR, { timeout: 10_000 });
    await box.press("Enter");
    await sleep(300);
    await med.keyboard.press("Escape");
    await sleep(300);
    const barGone = (await med.locator(BAR).count()) === 0;
    const focusIsBox = await box.evaluate((el) => el === document.activeElement);
    return { ok: barGone && focusIsBox, detail: { barGone, focusIsBox } };
  });

  await check(c, "K4 Alt+B ignored while typing", async () => {
    await goto(med, `${APP_BASE}/staff/queue?q=BSQ`);
    const box = rowBoxes(med).first();
    await box.check();
    await med.waitForSelector(BAR, { timeout: 10_000 });
    await med.locator("#q").focus();
    await med.keyboard.press("Alt+B");
    await sleep(300);
    const stillQ = await med.evaluate(
      () => document.activeElement === document.querySelector("#q"),
    );
    return { ok: stillQ, detail: { stillQ } };
  });
}

// ---------------------------------------------------------------------------
// Named outcome (item 2)
// ---------------------------------------------------------------------------
async function sectionNamedOutcome(c: CheckContext, admin: Page): Promise<void> {
  await check(c, "N1 appointments: every unchanged booking is named", async () => {
    await goto(admin, `${APP_BASE}/staff/appointments`);
    const walkBox = admin.locator('input[aria-label*="BSQ Walk-in Today"]');
    const bravoBox = admin.locator('input[aria-label*="Bravo"]');
    await walkBox.check();
    await bravoBox.check();
    await c.sql(
      "update appointments set status = 'cancelled' where notes = 'bsq-fixture' and walk_in_name = 'BSQ Walk-in Today'",
    );
    await admin.locator(BAR).locator("button", { hasText: "Mark arrived" }).click();
    await sleep(800);
    const text = await outcomeText(admin);
    const ok =
      !!text &&
      text.includes("Marked 1 of 2 bookings arrived.") &&
      text.includes("BSQ Walk-in Today: had already changed");
    return { ok, detail: text };
  });

  await check(c, "N2 mixed selection keeps the outcome", async () => {
    await goto(admin, `${APP_BASE}/staff/appointments`);
    // BSQ Walk-in Today is now "arrived" (from N1) — revert-eligible, not
    // arrive-eligible, so pick a fresh confirmed booking for the arrive leg.
    const untimedBox = admin.locator('input[aria-label*="BSQ Untimed"]');
    const callbackBox = admin.locator('input[aria-label*="BSQ Callback Undated"]');
    await untimedBox.check();
    await callbackBox.check();
    await admin.locator(BAR).locator("button", { hasText: "Mark arrived" }).click();
    await sleep(800);
    // The callback booking was never arrive-eligible, so it was never SENT —
    // it stays selected, the bar stays mounted, and the outcome renders
    // INLINE inside it (not as the standalone count===0 panel).
    const barHasOutcome = await admin
      .locator(BAR)
      .locator('[role="status"]')
      .count();
    const inlineText = barHasOutcome
      ? (await admin.locator(BAR).locator('[role="status"]').first().innerText()).replace(/\s+/g, " ")
      : null;
    const stillOneSelected = (await admin.locator(BAR).innerText()).includes("1 booking");
    if (!barHasOutcome || !inlineText?.includes("Marked 1 booking arrived.") || !stillOneSelected) {
      return { ok: false, detail: { barHasOutcome, inlineText, stillOneSelected } };
    }
    // Ticking another row is a deliberate edit — it must drop the outcome.
    const charlieBox = admin.locator('input[aria-label*="Bsqfixture, Charlie"]');
    await charlieBox.check();
    await sleep(300);
    const afterCount = await admin.locator(BAR).locator('[role="status"]').count();
    return { ok: afterCount === 0, detail: { afterCount } };
  });
}

// ---------------------------------------------------------------------------
// Dated callbacks (item 6)
// ---------------------------------------------------------------------------
async function sectionDatedCallbacks(c: CheckContext, admin: Page): Promise<void> {
  await check(c, "C1 dated pending callback shows once", async () => {
    await goto(admin, `${APP_BASE}/staff/appointments`);
    const alphaEverywhere = admin.locator("tr", { hasText: "Bsqfixture, Alpha" });
    const alphaTotal = await alphaEverywhere.count();
    const alphaInToday = admin.locator("#today tr", { hasText: "Bsqfixture, Alpha" });
    const alphaInTodayCount = await alphaInToday.count();
    const tagCount = await alphaInToday.locator("text=Callback needed").count();
    // The shared local DB can hold OTHER dated pending-callback bookings
    // outside the BSQ fixture (other sessions' leftover data) — the count
    // that gets folded in isn't ours to assert exactly, only that it's >= 1
    // (Alpha is always in it).
    const pendingDescCount = await admin.locator("text=/\\+\\d+ more with a date/").count();
    const undatedCount = await admin.locator("tr", { hasText: "BSQ Callback Undated" }).count();
    const ok =
      alphaTotal === 1 && alphaInTodayCount === 1 && tagCount > 0 && pendingDescCount > 0 && undatedCount === 1;
    return { ok, detail: { alphaTotal, alphaInTodayCount, tagCount, pendingDescCount, undatedCount } };
  });
}

// ---------------------------------------------------------------------------
// Chemistry panels (item 10)
// ---------------------------------------------------------------------------
async function sectionPanels(c: CheckContext, med: Page): Promise<void> {
  await check(c, "P1 panel card has a checkbox and the true count", async () => {
    await goto(med, `${APP_BASE}/staff/queue?visit=9105`);
    const box = med.locator('input[aria-label*="panel"][aria-label*="Echo"]');
    const boxCount = await box.count();
    const countText = await med.locator("td", { hasText: "(3 tests)" }).count();
    return { ok: boxCount === 1 && countText > 0, detail: { boxCount, countText } };
  });

  await check(c, "P2 split panel shows its true count and acts on every member", async () => {
    const N = 5; // smallest PAGE_SIZES entry (src/lib/ui/table-params.ts)
    const [v] = await c.sql("select id from visits where visit_number = '9106'");
    const [glu] = await c.sql("select id from services where code = 'BSQ-GLU'");
    const [chol] = await c.sql("select id from services where code = 'BSQ-CHOL'");
    const [esr] = await c.sql("select id from services where code = 'BSQ-ESR'");
    const [adminUser] = await c.sql("select id from auth.users where email = 'admin@drmed.ph'");
    const [{ now: t0 }] = await c.sql("select now() as now");
    await c.sql("update test_requests set requested_at = $1 where visit_id = $2 and service_id = $3", [
      t0,
      v.id,
      glu.id,
    ]);
    for (let i = 1; i <= N; i++) {
      await c.sql(
        `insert into test_requests (visit_id, service_id, requested_by, final_price_php, requested_at)
         values ($1, $2, $3, 100, $4::timestamptz + ($5 || ' seconds')::interval)`,
        [v.id, esr.id, adminUser.id, t0, String(i)],
      );
    }
    await c.sql(
      "update test_requests set requested_at = $1::timestamptz + interval '6 seconds' where visit_id = $2 and service_id = $3",
      [t0, v.id, chol.id],
    );

    await goto(med, `${APP_BASE}/staff/queue?visit=9106&sort=requested_at&dir=asc&size=${N}`);
    const noteLoc = med.locator("text=/on another page/");
    const noteCount = await noteLoc.count();
    const noteText = noteCount ? (await noteLoc.first().innerText()).replace(/\s+/g, " ") : "";
    const box = med.locator('input[aria-label*="panel"][aria-label*="Foxtrot"]');
    const boxCount = await box.count();
    if (boxCount === 0) return { ok: false, detail: { noteCount, noteText, boxCount } };
    await box.check();
    await med.locator(BAR).locator("button", { hasText: /^Claim/ }).click();
    await sleep(900);
    const rows = await c.sql(
      `select s.code, tr.status, tr.assigned_to from test_requests tr
       join services s on s.id = tr.service_id
       where tr.visit_id = $1 and s.code in ('BSQ-GLU', 'BSQ-CHOL')`,
      [v.id],
    );
    const [medUser] = await c.sql("select id from auth.users where email = 'inactive@drmed.ph'");
    const ok =
      rows.length === 2 &&
      rows.every((r) => r.status === "in_progress" && r.assigned_to === medUser.id) &&
      noteCount > 0 &&
      /2 tests in this panel/.test(noteText) &&
      /1 on another page/.test(noteText);
    return { ok, detail: { noteText, rows } };
  });

  await check(c, "P3 panel claim is all-or-nothing", async () => {
    // 9105 is untouched by P1/P2 (they only read it / act on 9106).
    await goto(med, `${APP_BASE}/staff/queue?visit=9105`);
    const box = med.locator('input[aria-label*="panel"][aria-label*="Echo"]');
    await box.check();
    const [v] = await c.sql("select id from visits where visit_number = '9105'");
    const [glu] = await c.sql("select id from services where code = 'BSQ-GLU'");
    const [adminUser] = await c.sql("select id from auth.users where email = 'admin@drmed.ph'");
    await c.sql(
      "update test_requests set status = 'in_progress', assigned_to = $1, started_at = now() where visit_id = $2 and service_id = $3",
      [adminUser.id, v.id, glu.id],
    );
    await med.locator(BAR).locator("button", { hasText: /^Claim/ }).click();
    await sleep(900);
    const text = await outcomeText(med);
    const rows = await c.sql(
      `select s.code, tr.status, tr.assigned_to from test_requests tr
       join services s on s.id = tr.service_id
       where tr.visit_id = $1 and s.code in ('BSQ-CHOL', 'BSQ-TRIG')`,
      [v.id],
    );
    const ok =
      !!text &&
      text.includes("already claimed") &&
      rows.length === 2 &&
      rows.every((r) => r.status === "requested" && r.assigned_to === null);
    return { ok, detail: { text, rows } };
  });
}

// State U6/A2 read across checks in the same section — see the doc comments
// on U6 and A2 for why (a check in isolation can't otherwise prove "existed
// before" or "this is a batch we actually undid").
let u6UndoSeenBefore = false;
let u4UndoneBatchId: string | undefined;

/** Most recent bulk_batch_id for `action` that isn't itself an Undo — read right after the original action, before it's clicked Undo. */
async function latestBatchId(c: CheckContext, action: string): Promise<string | undefined> {
  const rows = await c.sql(
    `select metadata->>'bulk_batch_id' as batch_id from audit_log
     where action = $1 and metadata->>'via' is distinct from 'bulk_undo'
     order by created_at desc limit 1`,
    [action],
  );
  return rows[0]?.batch_id as string | undefined;
}

/** How many `bulk_undo` audit rows exist for a given original batch — ground truth for "was this batch actually undone". */
async function undoRowCount(c: CheckContext, batchId: string): Promise<number> {
  const rows = await c.sql(
    "select count(*)::int as n from audit_log where metadata->>'via' = 'bulk_undo' and metadata->>'undo_of_batch' = $1",
    [batchId],
  );
  return Number(rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Server-checked 10-minute Undo (item 9)
// ---------------------------------------------------------------------------
// `allBatchIds` / `undoneBatchIds` are populated as the section runs, then
// handed to U7 (mismatch scope) and to A2 (a real batch this run undid) —
// never guessed from whatever the audit page happens to show first, since
// the shared local DB can hold other sessions' bulk rows too.
async function sectionUndo(
  c: CheckContext,
  med: Page,
  admin: Page,
): Promise<{ allBatchIds: string[]; undoneBatchIds: string[] }> {
  const allBatchIds: string[] = [];
  const undoneBatchIds: string[] = [];

  await check(c, "U1 appointments Cancel -> Undo restores prior statuses", async () => {
    // Realism: run as RECEPTION, not admin — bulkTransitionAction/Cancel
    // accepts either, but this is reception's own screen day to day.
    // No fresh sign-in: flip the role via SQL and reuse `med`'s ALREADY
    // signed-in session — the role is read fresh from staff_profiles on
    // every request (requireActiveStaff), so a reload is all a role change
    // needs. Signing in again here would burn a second attempt against
    // local GoTrue's per-IP sign-in rate limit for the SAME account.
    await setInactiveRole(c.sql, "reception");
    // try/finally: every later section (Panels, Undo's own queue checks,
    // Regression) needs `med` back to medtech. A thrown assertion here must
    // never leave the account stuck as reception for the rest of the run —
    // that happened once already and cascaded into F1/K1-4/P1-3 failing on
    // an unrelated later run, since the flip-back was a plain statement
    // after the part that threw.
    let noDeleteButton = false;
    let hadUndo = false;
    let batchId: string | undefined;
    try {
      await goto(med, `${APP_BASE}/staff/appointments`);
      const charlieBox = med.locator('input[aria-label*="Bsqfixture, Charlie"]');
      const deltaBox = med.locator('input[aria-label*="Bsqfixture, Delta"]');
      await charlieBox.check();
      await deltaBox.check();
      // Reception is not admin — the bar must not offer bulk Delete at all.
      noDeleteButton = (await med.locator(BAR).locator('button:has-text("Delete")').count()) === 0;

      await med.locator(BAR).locator("button", { hasText: "Cancel" }).click();
      await sleep(900);
      batchId = await latestBatchId(c, "appointment.cancelled");
      const undoBtn = med.locator('button:has-text("↶ Undo")').first();
      hadUndo = (await waitForCount(undoBtn)) > 0;
      if (hadUndo) await undoBtn.click();
      await sleep(900);
    } finally {
      // Flip back before the queue sections resume, which need medtech —
      // even if the block above threw.
      await setInactiveRole(c.sql, "medtech");
    }

    const rows = await c.sql(
      `select p.first_name, a.status from appointments a
       join patients p on p.id = a.patient_id
       where p.last_name = 'Bsqfixture' and p.first_name in ('Charlie', 'Delta')`,
    );
    const charlie = rows.find((r) => r.first_name === "Charlie");
    const delta = rows.find((r) => r.first_name === "Delta");
    let auditCount = 0;
    if (batchId) {
      allBatchIds.push(batchId);
      auditCount = await undoRowCount(c, batchId);
      if (auditCount > 0) undoneBatchIds.push(batchId);
    }
    const ok =
      noDeleteButton &&
      hadUndo &&
      charlie?.status === "arrived" &&
      delta?.status === "confirmed" &&
      auditCount > 0;
    return { ok, detail: { noDeleteButton, hadUndo, rows, batchId, auditCount } };
  });

  await check(c, "U2 queue Claim -> Undo unclaims", async () => {
    const [v] = await c.sql("select id from visits where visit_number = '9101'");
    await goto(med, `${APP_BASE}/staff/queue?visit=9101`);
    await headerBox(med).check();
    await med.locator(BAR).locator("button", { hasText: /^Claim/ }).click();
    await sleep(900);
    const afterClaim = await c.sql("select status, assigned_to from test_requests where visit_id = $1", [v.id]);
    const batchId = await latestBatchId(c, "test_request.claimed");
    const undoBtn = med.locator('button:has-text("↶ Undo")').first();
    const hadUndoBeforeClick = (await waitForCount(undoBtn)) > 0;
    u6UndoSeenBefore = hadUndoBeforeClick;
    if (hadUndoBeforeClick) await undoBtn.click();
    await sleep(900);
    const afterUndo = await c.sql("select status, assigned_to from test_requests where visit_id = $1", [v.id]);
    if (batchId) {
      allBatchIds.push(batchId);
      if ((await undoRowCount(c, batchId)) > 0) undoneBatchIds.push(batchId);
    }
    const ok =
      hadUndoBeforeClick &&
      afterClaim.every((r) => r.status === "in_progress") &&
      afterUndo.length === afterClaim.length &&
      afterUndo.every((r) => r.status === "requested" && r.assigned_to === null);
    return { ok, detail: { afterClaim, afterUndo, batchId } };
  });

  await check(c, "U6 Undo button disappears after a successful Undo", async () => {
    // Vacuous if it only checked "gone now" — that also passes when Undo
    // never rendered. Assert both halves: U2 recorded that it existed
    // (count >= 1) BEFORE the click; this checks it's gone after.
    const stillThere = await med.locator('button:has-text("↶ Undo")').count();
    return { ok: u6UndoSeenBefore && stillThere === 0, detail: { hadUndoBeforeClick: u6UndoSeenBefore, stillThere } };
  });

  await check(c, "U3 queue Unclaim (admin) -> Undo hands back to the medtech", async () => {
    const [v] = await c.sql("select id from visits where visit_number = '9101'");
    const [medUser] = await c.sql("select id from auth.users where email = 'inactive@drmed.ph'");
    await goto(med, `${APP_BASE}/staff/queue?visit=9101`);
    const cbcBoxMed = med.locator('input[aria-label*="Complete Blood Count"]');
    await cbcBoxMed.check();
    await med.locator(BAR).locator("button", { hasText: /^Claim/ }).click();
    await sleep(900);

    await goto(admin, `${APP_BASE}/staff/queue?visit=9101`);
    const cbcBoxAdmin = admin.locator('input[aria-label*="Complete Blood Count"]');
    await cbcBoxAdmin.check();
    await admin.locator(BAR).locator("button", { hasText: /^Unclaim/ }).click();
    await sleep(300);
    await admin.locator('button:has-text("Confirm unclaim")').click();
    await sleep(900);
    const batchId = await latestBatchId(c, "test_request.unclaimed");
    const undoBtn = admin.locator('button:has-text("↶ Undo")').first();
    const hasUndo = (await waitForCount(undoBtn)) > 0;
    if (hasUndo) await undoBtn.click();
    await sleep(900);
    const rows = await c.sql(
      `select tr.status, tr.assigned_to from test_requests tr
       join services s on s.id = tr.service_id
       where tr.visit_id = $1 and s.code = 'BSQ-CBC'`,
      [v.id],
    );
    let auditCount = 0;
    if (batchId) {
      allBatchIds.push(batchId);
      auditCount = await undoRowCount(c, batchId);
      if (auditCount > 0) undoneBatchIds.push(batchId);
    }
    const audit = await c.sql(
      "select count(*)::int as n from audit_log where action = 'test_request.reassigned' and metadata->>'via' = 'bulk_undo' and metadata->>'to' = $1 and metadata->>'undo_of_batch' = $2",
      [medUser.id, batchId ?? null],
    );
    const ok =
      hasUndo &&
      rows.length === 1 &&
      rows[0]?.status === "in_progress" &&
      rows[0]?.assigned_to === medUser.id &&
      auditCount > 0 &&
      Number(audit[0]?.n ?? 0) > 0;
    return { ok, detail: { rows, batchId, auditCount, audit: audit[0] } };
  });

  await check(c, "U4 queue Delete -> Undo restores", async () => {
    const [v] = await c.sql("select id from visits where visit_number = '9103'");
    await goto(admin, `${APP_BASE}/staff/queue?visit=9103`);
    const uaBox = admin.locator('input[aria-label*="Urinalysis"]');
    await uaBox.check();
    await admin.locator(BAR).locator("button", { hasText: /^Delete/ }).click();
    await sleep(300);
    await admin.locator('textarea[aria-label="Reason for deleting"]').fill("bulk test delete");
    await admin.locator('button:has-text("Confirm delete")').click();
    await sleep(900);
    const batchId = await latestBatchId(c, "test_request.deleted");
    const undoBtn = admin.locator('button:has-text("↶ Undo")').first();
    const hasUndo = (await waitForCount(undoBtn)) > 0;
    if (hasUndo) await undoBtn.click();
    await sleep(900);
    const rows = await c.sql(
      `select tr.deleted_at from test_requests tr
       join services s on s.id = tr.service_id
       where tr.visit_id = $1 and s.code = 'BSQ-UA'`,
      [v.id],
    );
    let auditCount = 0;
    if (batchId) {
      allBatchIds.push(batchId);
      auditCount = await undoRowCount(c, batchId);
      if (auditCount > 0) undoneBatchIds.push(batchId);
    }
    // Captured for A2 (a batch this run actually undid) — assign after the
    // ok check so A2 always has a candidate when U4 itself succeeded.
    if (hasUndo && auditCount > 0 && batchId) u4UndoneBatchId = batchId;
    const ok = hasUndo && rows.length === 1 && rows[0]?.deleted_at === null && auditCount > 0;
    return { ok, detail: { rows, batchId, auditCount } };
  });

  await check(c, "U5 Undo refused after the window", async () => {
    const [v] = await c.sql("select id from visits where visit_number = '9101'");
    await goto(med, `${APP_BASE}/staff/queue?visit=9101`);
    const esrBox = med.locator('input[aria-label*="ESR"]');
    const uaBox = med.locator('input[aria-label*="Urinalysis"]');
    await esrBox.check();
    await uaBox.check();
    await med.locator(BAR).locator("button", { hasText: /^Claim/ }).click();
    await sleep(900);
    const batchId = await latestBatchId(c, "test_request.claimed");
    if (!batchId) return { ok: false, detail: "no claim audit row found" };
    allBatchIds.push(batchId);
    await c.sql(
      "update audit_log set created_at = created_at - interval '11 minutes' where metadata->>'bulk_batch_id' = $1",
      [batchId],
    );
    const undoBtn = med.locator('button:has-text("↶ Undo")').first();
    await undoBtn.click();
    await sleep(900);
    const text = await outcomeText(med);
    const rows = await c.sql(
      `select tr.status from test_requests tr
       join services s on s.id = tr.service_id
       where tr.visit_id = $1 and s.code in ('BSQ-ESR', 'BSQ-UA')`,
      [v.id],
    );
    const ok =
      !!text && text.includes("Undo is no longer available") && rows.every((r) => r.status === "in_progress");
    return { ok, detail: { text, rows } };
  });

  await check(c, "U7 every Undo was done by the batch's own actor", async () => {
    if (allBatchIds.length === 0) return { ok: false, detail: "no batch ids captured this run" };
    const totals = await c.sql(
      `select count(*)::int as rows, count(distinct metadata->>'undo_of_batch')::int as batches
       from audit_log
       where metadata->>'via' = 'bulk_undo' and metadata->>'undo_of_batch' = any($1)`,
      [allBatchIds],
    );
    const mismatches = await c.sql(
      `select count(*)::int as n from audit_log u
       join audit_log o on o.metadata->>'bulk_batch_id' = u.metadata->>'undo_of_batch'
       where u.metadata->>'via' = 'bulk_undo'
         and u.metadata->>'undo_of_batch' = any($1)
         and u.actor_id <> o.actor_id`,
      [allBatchIds],
    );
    const rows = Number(totals[0]?.rows ?? 0);
    const batches = Number(totals[0]?.batches ?? 0);
    const n = Number(mismatches[0]?.n ?? 0);
    // "at least the number of Undos this run performed": every batch we
    // confirmed was undone (undoneBatchIds) must show up here.
    const ok = rows > 0 && undoneBatchIds.length > 0 && batches === undoneBatchIds.length && n === 0;
    return { ok, detail: { rows, batches, expectedBatches: undoneBatchIds.length, mismatches: n } };
  });

  return { allBatchIds, undoneBatchIds };
}

// ---------------------------------------------------------------------------
// Audit-log bulk filter (item 8) — relies on the bulk rows Undo just made.
// ---------------------------------------------------------------------------
async function sectionAuditFilter(c: CheckContext, admin: Page): Promise<void> {
  await check(c, "A1 Bulk actions chip filters to bulk rows", async () => {
    await goto(admin, `${APP_BASE}/staff/audit?bulk=1`);
    const labelText = await admin.locator('nav[aria-label="Pagination"] p').innerText();
    const m = /of\s+([\d,]+)/.exec(labelText);
    const shown = m ? parseInt(m[1]!.replace(/,/g, ""), 10) : NaN;
    const rows = await c.sql(
      `select count(*)::int as n from audit_log
       where coalesce((metadata->>'bulk_batch_size')::numeric, 0) > 1
          or coalesce((metadata->>'bulk_booking_count')::numeric, 0) > 1
          or metadata->>'bulk_batch_id' is not null`,
    );
    const ok = !Number.isNaN(shown) && shown === rows[0]?.n && shown > 0;
    return { ok, detail: { shown, sql: rows[0] } };
  });

  await check(c, "A2 Whole batch link shows one batch and its Undo", async () => {
    // Use a batch THIS RUN actually undid (U4's queue delete — captured
    // there) rather than clicking whatever "Whole batch" link happens to
    // sort first on a shared DB, which could belong to another session and
    // carry no Undo at all.
    const batchId = u4UndoneBatchId;
    if (!batchId) return { ok: false, detail: "no undone batch id captured (U4 did not run/succeed)" };
    await goto(admin, `${APP_BASE}/staff/audit?batch=${batchId}`);
    const statusText = await admin.locator('[role="status"]', { hasText: "Showing one bulk action" }).count();
    const codes = await admin.locator("table tbody code").allTextContents();
    const hasUndoRow = codes.some((t) => t.includes(`"undo_of_batch":"${batchId}"`) && t.includes('"via":"bulk_undo"'));
    const everyRowBelongs = codes.length > 0 && codes.every((t) => t.includes(batchId));
    const ok = statusText > 0 && hasUndoRow && everyRowBelongs;
    return { ok, detail: { batchId, statusText, hasUndoRow, everyRowBelongs, codes } };
  });
}

// ---------------------------------------------------------------------------
// Regression (PR 2 checklist, kept) — ported from tmp/bsq-check.mjs.
// ---------------------------------------------------------------------------
async function sectionRegression(c: CheckContext, med: Page, medState: StorageState): Promise<void> {
  await check(c, "R1 selection resets on sort / tab / search", async () => {
    await goto(med, `${APP_BASE}/staff/queue`);
    await rowBoxes(med).nth(0).check();
    await rowBoxes(med).nth(1).check();
    const before = await barText(med);
    await med.click('thead a:has-text("Status")');
    await med.waitForURL(/sort=status/, { timeout: 10_000 });
    const afterSort = await barText(med);
    await rowBoxes(med).nth(0).check();
    await med.click('nav[aria-label="Queue filter"] a:has-text("Unclaimed")');
    await med.waitForURL(/filter=unclaimed/, { timeout: 10_000 });
    const afterTab = await barText(med);
    await goto(med, `${APP_BASE}/staff/queue`);
    await rowBoxes(med).nth(0).check();
    await med.fill("#q", "BSQ");
    await Promise.all([med.waitForURL(/q=BSQ/, { timeout: 10_000 }), med.click('button:has-text("Apply")')]);
    const afterSearch = await barText(med);
    const ok = before !== null && afterSort === null && afterTab === null && afterSearch === null;
    return { ok, detail: { before, afterSort, afterTab, afterSearch } };
  });

  await check(c, "R2 390px: no horizontal scroll, bar inside viewport", async () => {
    // Reuse `med`'s already-authenticated session (storageState) for the
    // narrow viewport — a fresh signIn() here is a second login for the
    // SAME account, unnecessary and one more hit against GoTrue's rate limit.
    const med390 = await newPageFromState(c.browser, medState, { width: 390, height: 844 });
    await goto(med390, `${APP_BASE}/staff/queue`);
    await rowBoxes(med390).first().check();
    await med390.waitForSelector(BAR, { timeout: 10_000 });
    const m = await med390.evaluate((sel) => {
      const bar = document.querySelector(sel)!;
      const r = bar.getBoundingClientRect();
      return {
        scrollW: document.documentElement.scrollWidth,
        innerW: innerWidth,
        barLeft: r.left,
        barRight: r.right,
        innerH: innerHeight,
        barBottom: r.bottom,
      };
    }, BAR);
    await med390.screenshot({ path: "tmp/bulk-select-390.png" }).catch(() => {});
    const ok =
      m.scrollW <= m.innerW + 1 && m.barLeft >= -1 && m.barRight <= m.innerW + 1 && m.barBottom <= m.innerH + 1;
    return { ok, detail: m };
  });
}

async function main(): Promise<void> {
  const c = await startCheck("check:bulk-select");
  await reseed(c);
  // Defensive: a prior run that threw between U1's role flips (before the
  // try/finally fix) can leave inactive@ stuck as reception. Force it back
  // to medtech before anything else reads it — the fixture SQL itself never
  // touches staff_profiles.role.
  await setInactiveRole(c.sql, "medtech");

  // Each account signs in exactly ONCE per run (local GoTrue's per-IP
  // sign-in rate limit — see newPageFromState's doc comment). Every other
  // page for the same account (U1's role flip, R2's 390px viewport) reuses
  // this session via storageState rather than logging in again.
  const admin = await signIn(c.browser, ADMIN.email, ADMIN.password);
  const med = await signIn(c.browser, MED.email, MED.password);
  const medState = await med.context().storageState();

  await sectionFixedBars(c, med, admin);
  await sectionKeyboard(c, med);
  await sectionNamedOutcome(c, admin);
  await sectionDatedCallbacks(c, admin);

  await reseed(c);
  await sectionPanels(c, med);

  await reseed(c);
  await sectionUndo(c, med, admin);
  await sectionAuditFilter(c, admin);

  await reseed(c);
  await sectionRegression(c, med, medState);

  await med.screenshot({ path: "tmp/bulk-select-desktop.png" }).catch(() => {});

  await c.finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
