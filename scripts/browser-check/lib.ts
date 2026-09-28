/**
 * Guarded helpers for signed-in, local, headless-Chrome checks of staff pages.
 * Local-only: refuses any non-local database or APP_BASE (refuseNonLocal).
 * Needs a dev server with the LOCAL env (e.g. `PORT=3007 npm run dev` in a
 * worktree whose .env.local points at 127.0.0.1) and
 * `npm run seed:test && npm run seed:hmo && npm run seed:bulk-fixtures`.
 */
import "../lib/load-env";
import { chromium, type Browser, type Page } from "playwright-core";
import { Client } from "pg";
import { refuseNonLocal, requireLocalOrExplicitProd } from "../lib/env-guard";

export const APP_BASE = process.env.APP_BASE ?? "http://localhost:3007";

export interface CheckContext {
  browser: Browser;
  db: Client;
  sql: (q: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;
  expect: (label: string, ok: boolean, detail?: unknown) => void;
  finish: () => Promise<never>;
}

export async function startCheck(name: string): Promise<CheckContext> {
  requireLocalOrExplicitProd(name, {
    writes: "changes inactive@drmed.ph's role and runs bulk actions on the BSQ fixtures (local stack only)",
  });
  refuseNonLocal(name, { APP_BASE });
  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) throw new Error("SUPABASE_DB_URL is not set");
  const db = new Client({ connectionString: dbUrl });
  await db.connect();
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const failures: string[] = [];
  let passed = 0;
  return {
    browser,
    db,
    sql: async (q, params) => (await db.query(q, params as unknown[])).rows,
    expect(label, ok, detail) {
      if (ok) passed += 1;
      else failures.push(label);
      console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
    },
    async finish() {
      await browser.close();
      await db.end();
      console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? `:\n  - ${failures.join("\n  - ")}` : ""}`);
      process.exit(failures.length ? 1 : 0);
    },
  };
}

export async function signIn(
  browser: Browser,
  email: string,
  password: string,
  viewport = { width: 1280, height: 800 },
): Promise<Page & { dialogs: string[] }> {
  const ctx = await browser.newContext({ viewport });
  const page = (await ctx.newPage()) as Page & { dialogs: string[] };
  page.dialogs = [];
  page.on("dialog", async (d) => {
    page.dialogs.push(d.message());
    await d.accept();
  });
  await page.goto(`${APP_BASE}/staff/login`);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 30_000 }),
    page.click('button[type="submit"]'),
  ]);
  return page;
}

export const BAR = '[aria-label="Selected rows"]';
export const VISIT_BAR = '[aria-label="Bulk actions"]';
export const OUTCOME = '[role="status"]:has(button:has-text("Dismiss"))';
export const rowBoxes = (p: Page) => p.locator('tbody input[type="checkbox"]');
export const headerBox = (p: Page) => p.locator('thead input[type="checkbox"]').first();
export async function barText(p: Page, selector = BAR): Promise<string | null> {
  const bar = p.locator(selector);
  return (await bar.count()) ? (await bar.innerText()).replace(/\s+/g, " ") : null;
}
export async function outcomeText(p: Page): Promise<string | null> {
  const o = p.locator(OUTCOME);
  return (await o.count()) ? (await o.first().innerText()).replace(/\s+/g, " ") : null;
}
/** Is `selector` pinned to the viewport bottom (fixed, not sticky)? */
export async function pinnedBottom(p: Page, selector: string) {
  return p.locator(selector).first().evaluate((el) => {
    let n: HTMLElement | null = el as HTMLElement;
    while (n && getComputedStyle(n).position !== "fixed") n = n.parentElement;
    const r = el.getBoundingClientRect();
    return { fixed: !!n, bottomGap: Math.round(innerHeight - r.bottom) };
  });
}

/** Set inactive@drmed.ph's role/active flag for the section about to run. */
export async function setInactiveRole(
  sql: CheckContext["sql"],
  role: "reception" | "medtech" | "xray_technician" | "pathologist" | "admin",
): Promise<void> {
  await sql(
    "update staff_profiles set is_active = true, role = $1 where id = (select id from auth.users where email = 'inactive@drmed.ph')",
    [role],
  );
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}
