#!/usr/bin/env tsx
// Smoke-test every staff print surface in REAL Chrome.
//
// Why real Chrome: the staff shell once wrapped every slip in a scroll box
// that printed clipped, with its scrollbar drawn in, and dropped whatever
// fell past page one — but only on a Mac showing scroll bars. Playwright's
// bundled headless shell hides scrollbars and never reproduced it, so this
// launches the installed Google Chrome with scrollbars left ON.
//
// What it does, against the LOCAL stack only:
//   1. Seeds one throwaway set of rows: a patient, a package visit (package +
//      8 included tests + an X-ray, part-paid, in a visit group), a doctor
//      payout of 30 fees, and an end-of-day cash close.
//   2. Signs a temporary admin in through the real login form.
//   3. For each print page: checks the print-media DOM (no scroll box or
//      clip around the sheet, no repeating <tfoot>, the text the paper must
//      carry), prints it to PDF with the page's own @page size, and checks
//      the page count (a stray blank page or a spill shows up there).
//   4. Deletes everything it made — including the journal entries the GL
//      bridges post for the payment, payout and cash close — even on failure.
//
// Usage (local stack + dev server running):
//   npm run dev                       # any port; pass it as APP_BASE
//   APP_BASE=http://localhost:3000 npm run smoke:print
// Needs Google Chrome installed (or CHROME_PATH). PDFs are kept for a look;
// the run prints where. Exit code 1 on any failed check.

import "./lib/load-env";
import { requireLocalOrExplicitProd, hostOf, isLocalHost } from "./lib/env-guard";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { PDFDocument } from "pdf-lib";
import { chromium, type Page } from "playwright-core";

requireLocalOrExplicitProd("smoke:print", {
  writes:
    "creates and then deletes a temporary admin, patient, visits, payment, doctor payout and cash close (and the journal entries they post)",
});

// Seeding fires the GL bridges, so this must never touch a real ledger —
// refuse a remote target outright, even with the prod opt-in above.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DB_URL =
  process.env.SMOKE_PRINT_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
if (!isLocalHost(hostOf(SUPABASE_URL)) || !isLocalHost(hostOf(DB_URL))) {
  console.error("smoke:print seeds and posts journal entries — it runs against the LOCAL stack only.");
  process.exit(1);
}
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const APP_BASE = (process.env.APP_BASE ?? "http://localhost:3000").replace(/\/$/, "");

interface Target {
  name: string;
  path: string;
  /** The printed sheet; the ancestor check walks up from it. */
  sheet: string;
  mustContain: string[];
  minPages: number;
  maxPages: number;
}

interface Seed {
  staffId: string;
  email: string;
  password: string;
  patientId: string;
  visitId: string;
  consultVisitId: string;
  groupId: string;
  disbursementId: string;
  eodId: string;
  shiftId: string;
  physicianId: string;
  serviceIds: string[];
  paymentId: string;
}

async function createAuthUser(email: string, password: string): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY!,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const body = (await res.json()) as { id?: string; msg?: string };
  if (!res.ok || !body.id) throw new Error(`auth user create failed: ${res.status} ${body.msg ?? ""}`);
  return body.id;
}

async function deleteAuthUser(id: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, {
    method: "DELETE",
    headers: { apikey: SERVICE_KEY!, Authorization: `Bearer ${SERVICE_KEY}` },
  });
}

async function seed(db: pg.Client, staffId: string, email: string, password: string): Promise<Seed> {
  // Service codes are unique, so each run suffixes real-looking codes with a
  // short tag. Keep it short: a long synthetic prefix wraps every code cell
  // and makes the receipt spill where a real one would not.
  const tag = randomBytes(2).toString("hex").toUpperCase();
  const s: Seed = {
    staffId,
    email,
    password,
    patientId: randomUUID(),
    visitId: randomUUID(),
    consultVisitId: randomUUID(),
    groupId: randomUUID(),
    disbursementId: randomUUID(),
    eodId: randomUUID(),
    shiftId: randomUUID(),
    physicianId: randomUUID(),
    serviceIds: [],
    paymentId: randomUUID(),
  };
  const q = (sql: string, params: unknown[] = []) => db.query(sql, params);

  await q("begin");
  await q(
    "insert into staff_profiles (id, full_name, role, is_active) values ($1, 'Print Smoke', 'admin', true)",
    [staffId],
  );
  await q("insert into patients (id, first_name, last_name, birthdate) values ($1, 'Print', 'Smoke', '1980-01-15')", [s.patientId]);
  await q(
    "insert into physicians (id, slug, full_name, specialty) values ($1, $2, 'Dr. Print Smoke', 'General Medicine')",
    [s.physicianId, `smoke-print-${tag.toLowerCase()}`],
  );
  await q("insert into cash_shifts (id, code, label) values ($1, $2, 'Print smoke shift')", [
    s.shiftId,
    `smoke-print-${tag.toLowerCase()}`,
  ]);

  // Services: a long-coded package, the 8 tests it includes, an X-ray and a
  // consultation. Real-length names so the table wraps the way prod does.
  const svc = async (code: string, name: string, price: number, kind: string, section: string) => {
    const id = randomUUID();
    s.serviceIds.push(id);
    await q(
      "insert into services (id, code, name, price_php, kind, section) values ($1, $2, $3, $4, $5, $6)",
      [id, `${code}${tag}`, name, price, kind, section],
    );
    return id;
  };
  const pkg = await svc("EXECUTIVE_PACKAGE_STANDARD", "EXECUTIVE PACKAGE - STANDARD", 5888, "lab_package", "package");
  const included = [
    ["CBC", "Complete Blood Count (CBC)", "hematology"],
    ["URINALYSIS", "Urinalysis", "urinalysis"],
    ["FBS", "Fasting Blood Sugar (FBS)", "chemistry"],
    ["CREA", "Creatinine", "chemistry"],
    ["SGPT", "SGPT (ALT)", "chemistry"],
    ["SGOT", "SGOT (AST)", "chemistry"],
    ["HBSAG", "Hepatitis B Surface Antigen (HBsAg)", "immunology"],
    ["ECG", "12-Lead ECG", "imaging_ecg"],
  ] as const;
  const includedIds: string[] = [];
  for (const [i, [code, name, section]] of included.entries()) {
    const id = await svc(code, name, 300, "lab_test", section);
    includedIds.push(id);
    await q(
      "insert into package_components (package_service_id, component_service_id, sort_order) values ($1, $2, $3)",
      [pkg, id, i + 1],
    );
  }
  const xray = await svc("XRAYCHEST", "Chest X-Ray (Digital)", 550, "lab_test", "imaging_xray");
  const consult = await svc("CONSULT", "Consultation", 800, "doctor_consultation", "consultation");

  // The package visit: header before components (0040), plus a standalone.
  await q("insert into visits (id, patient_id, visit_group_id) values ($1, $2, $3)", [
    s.visitId,
    s.patientId,
    s.groupId,
  ]);
  const headerId = randomUUID();
  await q(
    `insert into test_requests (id, visit_id, service_id, requested_by, base_price_php, final_price_php, is_package_header)
     values ($1, $2, $3, $4, 5888, 5888, true)`,
    [headerId, s.visitId, pkg, staffId],
  );
  for (const id of includedIds) {
    await q(
      `insert into test_requests (visit_id, service_id, requested_by, base_price_php, final_price_php, parent_id)
       values ($1, $2, $3, 0, 0, $4)`,
      [s.visitId, id, staffId, headerId],
    );
  }
  await q(
    `insert into test_requests (visit_id, service_id, requested_by, base_price_php, final_price_php)
     values ($1, $2, $3, 550, 550)`,
    [s.visitId, xray, staffId],
  );
  await q(
    "insert into payments (id, visit_id, amount_php, method, received_by) values ($1, $2, 3000, 'cash', $3)",
    [s.paymentId, s.visitId, staffId],
  );

  // A doctor payout of 30 fees — two copies that each run onto a 2nd page.
  await q("insert into visits (id, patient_id) values ($1, $2)", [s.consultVisitId, s.patientId]);
  await q(
    `insert into test_requests (visit_id, service_id, requested_by, base_price_php, final_price_php)
     select $1, $2, $3, 800, 800 from generate_series(1, 30)`,
    [s.consultVisitId, consult, staffId],
  );
  await q(
    `insert into doctor_pf_disbursements (id, batch_number, physician_id, posted_date, method, total_php, recorded_by)
     values ($1, (select coalesce(max(batch_number), 0) + 1 from doctor_pf_disbursements), $2,
             (now() at time zone 'Asia/Manila')::date, 'cash', 15000, $3)`,
    [s.disbursementId, s.physicianId, staffId],
  );
  await q(
    `insert into doctor_pf_entries (test_request_id, physician_id, pf_php, recognition_basis, disbursement_id)
     select id, $2, 500, 'cash_at_release', $3 from test_requests where visit_id = $1`,
    [s.consultVisitId, s.physicianId, s.disbursementId],
  );

  // An end-of-day close on its own shift, with a breakdown that ties (P0048).
  await q(
    `insert into eod_close_records
       (id, business_date, shift_id, opening_float_php, cash_payments_php, cash_payouts_php,
        expected_cash_php, counted_cash_php, variance_php, variance_reason, closed_by, counted_denominations)
     values ($1, (now() at time zone 'Asia/Manila')::date, $2, 2000, 16438, 0, 18438, 18437.25, -0.75,
             'Short 75 centavos', $3,
             '{"bill_1000":18,"bill_200":2,"bill_20":1,"coin_10":1,"coin_5":1,"coin_1":2,"coin_0.25":1}'::jsonb)`,
    [s.eodId, s.shiftId, staffId],
  );
  await q("commit");
  return s;
}

async function cleanup(db: pg.Client, s: Partial<Seed> & { staffId: string }): Promise<void> {
  const q = (sql: string, params: unknown[] = []) => db.query(sql, params);
  await q("rollback").catch(() => undefined);
  await q("begin");
  // The GL bridges' own guards (a posted entry must keep its lines) exist to
  // protect real books; these rows are this run's alone, so skip triggers for
  // the teardown. Local only — the host check at the top guarantees it.
  await q("set local session_replication_role = replica");
  const visitIds = [s.visitId, s.consultVisitId].filter(Boolean);
  const sourceIds = [s.paymentId, s.eodId, s.disbursementId].filter(Boolean);
  await q(
    `create temp table smoke_je on commit drop as
       select id from journal_entries
        where created_by = $1
           or source_id = any($2::uuid[])
           or source_id in (select id from test_requests where visit_id = any($3::uuid[]))
           or source_id in (select id from doctor_pf_entries where disbursement_id = $4)`,
    [s.staffId, sourceIds, visitIds, s.disbursementId ?? null],
  );
  await q("delete from journal_lines where entry_id in (select id from smoke_je)");
  await q("delete from journal_entries where id in (select id from smoke_je)");
  if (s.disbursementId) {
    await q("delete from doctor_pf_entries where disbursement_id = $1", [s.disbursementId]);
    await q("delete from doctor_pf_disbursements where id = $1", [s.disbursementId]);
  }
  if (s.eodId) await q("delete from eod_close_records where id = $1", [s.eodId]);
  await q("delete from payments where visit_id = any($1::uuid[])", [visitIds]);
  await q("delete from test_requests where visit_id = any($1::uuid[])", [visitIds]);
  await q("delete from visits where id = any($1::uuid[])", [visitIds]);
  if (s.serviceIds?.length) {
    await q("delete from package_components where package_service_id = any($1::uuid[])", [s.serviceIds]);
    await q("delete from services where id = any($1::uuid[])", [s.serviceIds]);
  }
  if (s.physicianId) await q("delete from physicians where id = $1", [s.physicianId]);
  if (s.shiftId) await q("delete from cash_shifts where id = $1", [s.shiftId]);
  if (s.patientId) await q("delete from patients where id = $1", [s.patientId]);
  await q("delete from audit_log where actor_id = $1", [s.staffId]);
  await q("delete from rate_limit_attempts where identifier = $1", [`email:${s.email ?? ""}`]);
  await q("delete from staff_profiles where id = $1", [s.staffId]);
  await q("commit");
  await deleteAuthUser(s.staffId);
}

/**
 * Print-media problems visible in the DOM around one sheet.
 *
 * Kept as plain JavaScript source: tsx compiles with keepNames, which wraps
 * named inner functions in a `__name` helper that does not exist inside the
 * page, so a TypeScript callback passed to page.evaluate throws there.
 */
const DOM_CHECK = `(({ sheet, mustContain }) => {
  const problems = [];
  const el = document.querySelector(sheet);
  if (!el) return ["no " + sheet + " on the page"];
  const label = (n) =>
    "<" + n.tagName.toLowerCase() + " class=\\"" + String(n.getAttribute("class") || "").slice(0, 60) + "\\">";
  // A scroll box or clip around the sheet prints clipped (with its scrollbar
  // drawn in on a Mac showing scroll bars) and loses page 2 onwards.
  for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
    const cs = getComputedStyle(n);
    for (const axis of ["overflowX", "overflowY"]) {
      if (["auto", "scroll", "hidden"].includes(cs[axis])) {
        problems.push(label(n) + " around the sheet has " + axis + ": " + cs[axis]);
      }
    }
  }
  // A table footer repeats on every printed page.
  for (const tf of document.querySelectorAll("tfoot")) {
    if (getComputedStyle(tf).display === "table-footer-group") {
      problems.push("a <tfoot> prints as table-footer-group (its totals repeat on every page)");
    }
  }
  // innerText applies CSS text-transform, so compare case-insensitively.
  const text = el.innerText.toLowerCase();
  for (const needle of mustContain) {
    if (!text.includes(needle.toLowerCase())) problems.push("sheet is missing \\"" + needle + "\\"");
  }
  return problems;
})`;

async function domProblems(page: Page, t: Target): Promise<string[]> {
  const args = JSON.stringify({ sheet: t.sheet, mustContain: t.mustContain });
  return page.evaluate(`${DOM_CHECK}(${args})`) as Promise<string[]>;
}

async function main(): Promise<void> {
  try {
    const res = await fetch(`${APP_BASE}/staff/login`);
    if (!res.ok) throw new Error(`status ${res.status}`);
  } catch (e) {
    console.error(`No app at ${APP_BASE} (${String(e)}). Start \`npm run dev\` and pass APP_BASE.`);
    process.exit(1);
  }

  const db = new pg.Client({ connectionString: DB_URL });
  await db.connect();
  const email = `smoke-print-${randomBytes(4).toString("hex")}@drmed.local`;
  const password = `Smoke-${randomBytes(9).toString("base64url")}!`;
  const staffId = await createAuthUser(email, password);
  let seeded: Partial<Seed> & { staffId: string; email: string } = { staffId, email };
  const outDir = mkdtempSync(join(tmpdir(), "drmed-smoke-print-"));
  let failures = 0;

  const browser = await chromium.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }),
    headless: true,
    // Keep scrollbars: a clipped scroll box only shows when they are drawn.
    ignoreDefaultArgs: ["--hide-scrollbars"],
  });
  try {
    const s = await seed(db, staffId, email, password);
    seeded = s;
    const targets: Target[] = [
      {
        name: "receipt",
        path: `/staff/visits/${s.visitId}/receipt`,
        sheet: "article.receipt-sheet",
        mustContain: ["Includes 8 tests", "Total Due", "Patient Portal Access"],
        minPages: 1,
        maxPages: 2,
      },
      {
        name: "group-receipt",
        path: `/staff/visits/group/${s.groupId}/receipt`,
        sheet: "article.receipt-sheet",
        mustContain: ["Includes 8 tests", "Total Due"],
        minPages: 1,
        maxPages: 2,
      },
      {
        name: "statement",
        path: `/staff/visits/${s.visitId}/statement`,
        sheet: "article.receipt-sheet",
        mustContain: ["Statement of account", "Payments received", "Balance due", "not an official receipt"],
        minPages: 1,
        maxPages: 2,
      },
      {
        name: "count-sheet",
        path: `/staff/payments/eod/${s.eodId}/count-sheet`,
        sheet: ".cash-count-sheet",
        mustContain: ["End-of-day cash count"],
        minPages: 1,
        maxPages: 1,
      },
      {
        name: "pf-payout-slip",
        path: `/staff/admin/accounting/pf-payouts/${s.disbursementId}/slip`,
        sheet: ".payout-slip-sheet",
        mustContain: ["PROFESSIONAL FEE PAYOUT ACKNOWLEDGMENT"],
        minPages: 2,
        maxPages: 4,
      },
      {
        name: "consent-patient",
        path: `/staff/patients/${s.patientId}/consent/print`,
        sheet: ".consent-sheet",
        mustContain: ["Data Privacy Consent"],
        minPages: 1,
        maxPages: 1,
      },
      {
        name: "consent-blank",
        path: "/staff/patients/consent/print",
        sheet: ".consent-sheet",
        mustContain: ["Data Privacy Consent"],
        minPages: 1,
        maxPages: 1,
      },
    ];

    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${APP_BASE}/staff/login`);
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    await Promise.all([
      page.waitForURL((u) => !u.pathname.endsWith("/login"), { timeout: 60_000 }),
      page.click('button[type="submit"]'),
    ]);

    for (const t of targets) {
      const problems: string[] = [];
      try {
        await page.emulateMedia({ media: "screen" });
        await page.goto(APP_BASE + t.path, { timeout: 180_000 });
        await page.waitForSelector(t.sheet, { timeout: 180_000 });
        await page.waitForFunction(() => [...document.images].every((i) => i.complete));
        await page.emulateMedia({ media: "print" });
        problems.push(...(await domProblems(page, t)));
        const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
        const file = join(outDir, `${t.name}.pdf`);
        writeFileSync(file, pdf);
        const pages = (await PDFDocument.load(pdf)).getPageCount();
        if (pages < t.minPages || pages > t.maxPages) {
          problems.push(
            `printed ${pages} page(s), expected ${t.minPages === t.maxPages ? t.maxPages : `${t.minPages}–${t.maxPages}`} (a spill or a stray blank page)`,
          );
        }
        console.log(`${problems.length ? "✗" : "✓"} ${t.name}: ${pages} page(s)`);
      } catch (e) {
        problems.push(`could not print: ${String((e as Error).message).split("\n")[0]}`);
        console.log(`✗ ${t.name}`);
      }
      for (const p of problems) console.log(`    - ${p}`);
      if (problems.length) failures++;
    }
  } finally {
    await browser.close();
    await cleanup(db, seeded).catch((e) => {
      console.error("cleanup failed — remove the smoke rows by hand:", e);
      failures++;
    });
    await db.end();
  }

  console.log(`\nPDFs: ${outDir}`);
  if (failures) {
    console.error(`${failures} print surface(s) failed.`);
    process.exit(1);
  }
  console.log("All print surfaces passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
