/**
 * 12.B history import — EXPENSES tab, AP-bill path.
 *
 *   npm run import:history:expenses-ap -- --year=2026                          # dry-run
 *   npm run import:history:expenses-ap -- --year=2026 --commit --confirm="I-mean-it"
 *
 * Sister script to expenses.ts. Picks up the blank-MOP rows that expenses.ts
 * skips (the ones flagged "requires AP-bill creation"). Looks up or creates
 * a vendor per row, then calls ap_create_bill_and_post — the 12.4 AP bridge
 * trigger generates the underlying JE (DR expense / CR 2100 AP-Trade).
 *
 * Idempotency via bills.vendor_invoice_number = `HIST-EXP-r{N}` (unique per
 * xlsx row). Existing rows are skipped.
 *
 * Skips categories that are inherently NOT vendor-AP (Salaries & Wages,
 * Doctors Payroll, Benefits, Past HMO of Doctors) — those route through
 * expenses.ts as direct JEs against Cash on Hand.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../../src/types/database";
import { requireLocalOrExplicitProd } from "../lib/env-guard";

const XLSX_PATH_DEFAULT = `${process.env.HOME ?? ""}/Downloads/DR MED MASTERSHEET.xlsx`;

// staff_profiles.id (= auth.users.id) used as p_actor_id when calling the
// ap_create_bill_and_post RPC. Override via --actor=<uuid>.
const DEFAULT_ACTOR_LOCAL = "11111111-aaaa-bbbb-cccc-111111111111";

// Categories that are NOT vendor-AP — these go through expenses.ts cash path.
const SKIP_CATEGORIES = new Set<string>([
  "Salaries & Wages",
  "Doctors Payroll",
  "Benefits",
  "Past HMO of Doctors",
  "Out of Pocket Expense",
  "Payment by Shareholders",
  "For Reimbursement",
]);

const CATEGORY_TO_COA: Record<string, string> = {
  Rent: "6200",
  Utilities: "6210",
  "Telecommunication / Internet": "6220",
  "Maintenance & Repair": "6310",
  "Office Supplies": "6400",
  "Lab Supplies": "6410",
  "Send Out": "6420",
  "Marketing: Ads & Promotion": "6500",
  Permits: "6600",
  "Legal & Regulatory": "6610",
  Insurance: "6620",
  Travel: "6700",
  APE: "6710",
};

interface Args {
  xlsx: string;
  year: number;
  commit: boolean;
  confirmed: boolean;
  actor: string;
  mapping: string | null;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const xlsx = argv.find((a) => a.startsWith("--xlsx="))?.substring(7) ?? XLSX_PATH_DEFAULT;
  const yearArg = argv.find((a) => a.startsWith("--year="))?.substring(7);
  if (!yearArg) {
    console.error("ERROR: --year=YYYY is required.");
    process.exit(2);
  }
  const year = Number(yearArg);
  if (!Number.isInteger(year) || year < 2023 || year > 2030) {
    console.error(`ERROR: --year must be integer 2023-2030, got ${yearArg}`);
    process.exit(2);
  }
  const commit = argv.includes("--commit");
  const confirmed =
    argv.includes('--confirm="I-mean-it"') ||
    argv.includes("--confirm=I-mean-it");
  const actor =
    argv.find((a) => a.startsWith("--actor="))?.substring(8) ?? DEFAULT_ACTOR_LOCAL;
  const mapping = argv.find((a) => a.startsWith("--mapping="))?.substring(10) ?? null;
  return { xlsx, year, commit, confirmed, actor, mapping };
}

// ---------------------------------------------------------------------------
// Vendor heuristics (used to seed the mapping CSV)
// ---------------------------------------------------------------------------

type VendorAction = "ap" | "cash";

function proposeMapping(rawName: string): { canonical: string; action: VendorAction } {
  const n = rawName.trim();
  if (!n) return { canonical: "(blank)", action: "cash" };

  // Hi Precision: HP, "HP:", "HP "
  if (/^hp(\s|:|$)/i.test(n) || /^hi\s*precision/i.test(n))
    return { canonical: "Hi Precision", action: "ap" };
  // Micromedic
  if (/micro/i.test(n)) return { canonical: "Micromedic", action: "ap" };
  // LBC
  if (/^lbc(\s|:|$)/i.test(n)) return { canonical: "LBC", action: "ap" };
  // Veritas
  if (/veritas/i.test(n)) return { canonical: "Veritas Pay", action: "ap" };
  // Circle J
  if (/circle\s*j/i.test(n)) return { canonical: "Circle J", action: "ap" };
  // Government statutory (SSS, PhilHealth, Pag-IBIG, BIR)
  if (/^sss\b/i.test(n)) return { canonical: "SSS", action: "ap" };
  if (/^philhealth\b/i.test(n)) return { canonical: "PhilHealth", action: "ap" };
  if (/^pag.?ibig\b/i.test(n)) return { canonical: "Pag-IBIG", action: "ap" };
  if (/^bir\b/i.test(n)) return { canonical: "BIR", action: "ap" };
  // National (book store)
  if (/^national(\s|:|$)/i.test(n)) return { canonical: "National Book Store", action: "ap" };
  // Wilcon
  if (/wilcon/i.test(n)) return { canonical: "Wilcon", action: "ap" };
  // Home service / transpo / one-off consumables — not vendors
  if (/home\s*service|transpo|distilled\s*water|drinking\s*water|water\s*pantry/i.test(n))
    return { canonical: n, action: "cash" };
  // Default: keep raw, mark cash — user can promote to AP if real vendor
  return { canonical: n, action: "cash" };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function excelSerialToISO(serial: number): string {
  const base = Date.UTC(1899, 11, 30);
  return new Date(base + serial * 86400 * 1000).toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object" && "richText" in v && Array.isArray(v.richText)) {
    return v.richText.map((r) => r.text ?? "").join("");
  }
  if (typeof v === "object" && "text" in v) return String((v as { text: unknown }).text);
  if (typeof v === "object" && "result" in v) return cellText((v as { result: ExcelJS.CellValue }).result);
  return String(v);
}

function normaliseVendorName(raw: string): string {
  // Trim, collapse internal whitespace, preserve case (vendors lookup is
  // case-insensitive via lower-unique index).
  return raw.trim().replace(/\s+/g, " ");
}

// ---------------------------------------------------------------------------
// Reader + filter
// ---------------------------------------------------------------------------

interface RawRow {
  row_number: number;
  posting_date: string;
  category: string;
  cost: number;
  expense: string;
  description: string;
}

async function loadCandidates(xlsxPath: string, year: number): Promise<{
  candidates: RawRow[];
  skipped: { row_number: number; reason: string }[];
}> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);
  const ws = wb.getWorksheet("EXPENSES");
  if (!ws) throw new Error(`EXPENSES sheet not found in ${xlsxPath}`);

  const candidates: RawRow[] = [];
  const skipped: { row_number: number; reason: string }[] = [];

  ws.eachRow({ includeEmpty: false }, (row, rn) => {
    if (rn <= 2) return;
    if (rn >= 3 && rn <= 11) {
      // FB Ads summary block — skip.
      const c = cellText(row.getCell(3).value).trim();
      if (c === "FB Ads") return;
    }

    const dateRaw = row.getCell(2).value;
    const category = cellText(row.getCell(3).value).trim();
    const cost = Number(cellText(row.getCell(4).value)) || 0;
    const expense = cellText(row.getCell(5).value).trim();
    const description = cellText(row.getCell(6).value).trim();
    const mop = cellText(row.getCell(7).value).trim();

    if (mop) return; // not blank-MOP — direct JE path handles it

    let postingDate = "";
    if (typeof dateRaw === "number") postingDate = excelSerialToISO(dateRaw);
    else if (dateRaw instanceof Date) postingDate = dateRaw.toISOString().slice(0, 10);
    else if (typeof dateRaw === "string" && /^\d+(\.\d+)?$/.test(dateRaw.trim()))
      postingDate = excelSerialToISO(Number(dateRaw));
    if (!postingDate) return;

    if (postingDate.slice(0, 4) !== String(year)) return;
    if (cost <= 0) {
      skipped.push({ row_number: rn, reason: `cost=${cost}` });
      return;
    }
    if (!category) {
      skipped.push({ row_number: rn, reason: "missing category" });
      return;
    }
    if (SKIP_CATEGORIES.has(category)) {
      // Handled by expenses.ts cash path — not an AP bill.
      return;
    }
    if (!(category in CATEGORY_TO_COA)) {
      skipped.push({ row_number: rn, reason: `category not mapped to AP: ${category}` });
      return;
    }

    candidates.push({
      row_number: rn,
      posting_date: postingDate,
      category,
      cost,
      expense,
      description,
    });
  });

  return { candidates, skipped };
}

// ---------------------------------------------------------------------------
// Dry-run report
// ---------------------------------------------------------------------------

function summarise(year: number, candidates: RawRow[], skipped: { row_number: number; reason: string }[]): void {
  console.log(`\n=== EXPENSES-AP dry-run report (year ${year}) ===`);
  console.log(`Postable AP bills:  ${candidates.length}`);
  console.log(`Skipped:            ${skipped.length}`);

  const byCat = new Map<string, { n: number; total: number }>();
  for (const c of candidates) {
    const cur = byCat.get(c.category) ?? { n: 0, total: 0 };
    cur.n += 1;
    cur.total += c.cost;
    byCat.set(c.category, cur);
  }
  console.log("\nBy category:");
  for (const [k, v] of [...byCat.entries()].sort()) {
    console.log(`  ${v.n.toString().padStart(4)}  ₱${v.total.toFixed(2).padStart(14)}  ${k}`);
  }

  const byVendor = new Map<string, { n: number; total: number }>();
  for (const c of candidates) {
    const v = normaliseVendorName(c.expense) || "(blank)";
    const cur = byVendor.get(v) ?? { n: 0, total: 0 };
    cur.n += 1;
    cur.total += c.cost;
    byVendor.set(v, cur);
  }
  console.log(`\nTop 20 vendors (of ${byVendor.size} distinct):`);
  const top = [...byVendor.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 20);
  for (const [k, v] of top) {
    console.log(`  ${v.n.toString().padStart(4)}  ₱${v.total.toFixed(2).padStart(14)}  ${k.slice(0, 60)}`);
  }

  if (skipped.length > 0) {
    const reasons = new Map<string, number>();
    for (const s of skipped) {
      const r = s.reason.split(":")[0];
      reasons.set(r, (reasons.get(r) ?? 0) + 1);
    }
    console.log("\nSkipped reasons:");
    for (const [k, n] of [...reasons.entries()].sort()) {
      console.log(`  ${n.toString().padStart(4)}  ${k}`);
    }
  }

  console.log(`\nTotal ₱:  ${candidates.reduce((s, c) => s + c.cost, 0).toFixed(2)}`);
}

async function writeCsv(year: number, candidates: RawRow[]): Promise<string> {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.resolve("tmp");
  await fs.mkdir(dir, { recursive: true });
  const out = path.join(dir, `history-import-expenses-ap-${year}-${ts}.csv`);

  const header = ["row_number", "posting_date", "vendor", "category", "dr_code", "amount", "description"];
  const lines: string[][] = [header];
  for (const c of candidates) {
    lines.push([
      String(c.row_number),
      c.posting_date,
      normaliseVendorName(c.expense),
      c.category,
      CATEGORY_TO_COA[c.category]!,
      c.cost.toFixed(2),
      c.description,
    ]);
  }
  const text = lines
    .map((row) => row.map((c) => `"${c.replace(/"/g, '""')}"`).join(","))
    .join("\n");
  await fs.writeFile(out, text);
  return out;
}

// ---------------------------------------------------------------------------
// Vendor-mapping CSV (emit + load)
// ---------------------------------------------------------------------------

interface VendorMappingRow {
  canonical: string;
  action: VendorAction;
}

async function emitMappingCsv(
  year: number,
  candidates: RawRow[],
): Promise<string> {
  const dir = path.resolve("tmp");
  await fs.mkdir(dir, { recursive: true });
  const out = path.join(dir, `vendor-mapping-${year}.csv`);

  const byRaw = new Map<
    string,
    { count: number; total: number; categories: Set<string>; sample: string }
  >();
  for (const c of candidates) {
    const raw = normaliseVendorName(c.expense) || "(blank)";
    const cur = byRaw.get(raw) ?? { count: 0, total: 0, categories: new Set<string>(), sample: "" };
    cur.count += 1;
    cur.total += c.cost;
    cur.categories.add(c.category);
    if (!cur.sample) cur.sample = c.description || c.expense;
    byRaw.set(raw, cur);
  }

  const header = ["raw_name", "rows", "total_php", "categories", "sample_description", "proposed_canonical", "action"];
  const lines: string[][] = [header];
  const sorted = [...byRaw.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [raw, info] of sorted) {
    const p = proposeMapping(raw);
    lines.push([
      raw,
      String(info.count),
      info.total.toFixed(2),
      [...info.categories].join("; "),
      info.sample,
      p.canonical,
      p.action,
    ]);
  }
  const text = lines
    .map((row) => row.map((c) => `"${c.replace(/"/g, '""')}"`).join(","))
    .join("\n");
  await fs.writeFile(out, text);
  return out;
}

async function loadMappingCsv(filePath: string): Promise<Map<string, VendorMappingRow>> {
  const text = await fs.readFile(filePath, "utf-8");
  const rows = text.split(/\r?\n/).filter((r) => r.length > 0);
  // Naive CSV: each row is "v","v","v",... Handle escaped quotes.
  function parseRow(line: string): string[] {
    const out: string[] = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') inQ = false;
        else cur += ch;
      } else {
        if (ch === '"') inQ = true;
        else if (ch === ",") { out.push(cur); cur = ""; }
        else cur += ch;
      }
    }
    out.push(cur);
    return out;
  }
  if (rows.length === 0) throw new Error(`Mapping CSV is empty: ${filePath}`);
  const header = parseRow(rows[0]);
  const iRaw = header.indexOf("raw_name");
  const iCanonical = header.indexOf("proposed_canonical");
  const iAction = header.indexOf("action");
  if (iRaw < 0 || iCanonical < 0 || iAction < 0) {
    throw new Error(`Mapping CSV missing required columns (raw_name, proposed_canonical, action): ${filePath}`);
  }
  const map = new Map<string, VendorMappingRow>();
  for (let i = 1; i < rows.length; i++) {
    const r = parseRow(rows[i]);
    const raw = r[iRaw];
    if (!raw) continue;
    const action = (r[iAction] || "").trim().toLowerCase();
    if (action !== "ap" && action !== "cash") {
      throw new Error(`Row ${i + 1}: action must be "ap" or "cash", got "${action}"`);
    }
    map.set(raw, {
      canonical: (r[iCanonical] || raw).trim(),
      action: action as VendorAction,
    });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Apply mapping + split into ap-path and cash-path
// ---------------------------------------------------------------------------

interface ResolvedRow extends RawRow {
  canonical: string;
  action: VendorAction;
}

function applyMapping(
  candidates: RawRow[],
  mapping: Map<string, VendorMappingRow>,
): { resolved: ResolvedRow[]; unmapped: RawRow[] } {
  const resolved: ResolvedRow[] = [];
  const unmapped: RawRow[] = [];
  for (const c of candidates) {
    const raw = normaliseVendorName(c.expense) || "(blank)";
    const m = mapping.get(raw);
    if (!m) { unmapped.push(c); continue; }
    resolved.push({ ...c, canonical: m.canonical, action: m.action });
  }
  return { resolved, unmapped };
}

function summariseResolved(resolved: ResolvedRow[]): void {
  const ap = resolved.filter((r) => r.action === "ap");
  const cash = resolved.filter((r) => r.action === "cash");
  const apTotal = ap.reduce((s, r) => s + r.cost, 0);
  const cashTotal = cash.reduce((s, r) => s + r.cost, 0);
  console.log(`\n=== Split by action ===`);
  console.log(`AP path:    ${ap.length.toString().padStart(4)} rows  ₱${apTotal.toFixed(2)}`);
  console.log(`Cash path:  ${cash.length.toString().padStart(4)} rows  ₱${cashTotal.toFixed(2)}`);

  const apVendors = new Map<string, { n: number; total: number }>();
  for (const r of ap) {
    const cur = apVendors.get(r.canonical) ?? { n: 0, total: 0 };
    cur.n += 1; cur.total += r.cost;
    apVendors.set(r.canonical, cur);
  }
  console.log(`\nAP vendors (${apVendors.size} canonical):`);
  for (const [v, info] of [...apVendors.entries()].sort((a, b) => b[1].total - a[1].total)) {
    console.log(`  ${info.n.toString().padStart(4)}  ₱${info.total.toFixed(2).padStart(14)}  ${v}`);
  }
}

// ---------------------------------------------------------------------------
// Commit (AP-bill via RPC; cash via direct JE)
// ---------------------------------------------------------------------------

async function commit(year: number, resolved: ResolvedRow[], actorId: string): Promise<void> {
  requireLocalOrExplicitProd("import:history:expenses-ap");

  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error("ERROR: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY must be set.");
    process.exit(2);
  }

  const admin = createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1. CoA codes → uuid.
  const { data: accounts, error: aErr } = await admin
    .from("chart_of_accounts")
    .select("id, code");
  if (aErr || !accounts) { console.error("ERROR fetching CoA:", aErr); process.exit(3); }
  const codeToId = new Map(accounts.map((a) => [a.code, a.id]));

  const apRows = resolved.filter((r) => r.action === "ap");
  const cashRows = resolved.filter((r) => r.action === "cash");

  // 2A. Cash-path idempotency. Pre-filter by xlsx EXPENSES marker so sibling
  // imports (DOC ~8K, LAB ~18K) don't trip the 1000-row PostgREST cap.
  const { data: existingJEs, error: jErr } = await admin
    .from("journal_entries")
    .select("notes")
    .eq("source_kind", "history_import" as never)
    .like("notes", "%xlsx EXPENSES r%")
    .gte("posting_date", `${year}-01-01`)
    .lte("posting_date", `${year}-12-31`);
  if (jErr) { console.error("ERROR fetching JEs:", jErr); process.exit(3); }
  if (existingJEs && existingJEs.length >= 1000) {
    console.error(`Aborting: EXPENSES idempotency fetch ≥1000 — paginate.`); process.exit(3);
  }
  const existingJeRows = new Set<string>();
  for (const e of existingJEs ?? []) {
    const m = /xlsx EXPENSES r(\d+)/.exec(e.notes ?? "");
    if (m) existingJeRows.add(`r${m[1]}`);
  }

  // 2B. AP-path idempotency: existing HIST-EXP-r{N} bills for this year.
  const { data: existingBills, error: bErr } = await admin
    .from("bills")
    .select("vendor_invoice_number")
    .like("vendor_invoice_number", "HIST-EXP-r%")
    .gte("bill_date", `${year}-01-01`)
    .lte("bill_date", `${year}-12-31`);
  if (bErr) { console.error("ERROR fetching bills:", bErr); process.exit(3); }
  if (existingBills && existingBills.length >= 1000) {
    console.error(`Aborting: bill fetch ≥1000.`); process.exit(3);
  }
  const existingBillNums = new Set(
    (existingBills ?? []).map((b) => b.vendor_invoice_number).filter((s): s is string => !!s),
  );

  // 3. Vendor resolution for AP rows: lookup by canonical (case-insensitive), create if missing.
  const canonicalNames = new Set<string>(apRows.map((r) => r.canonical));
  const lowerToId = new Map<string, string>();
  if (canonicalNames.size > 0) {
    const { data: existingVendors, error: vErr } = await admin
      .from("vendors")
      .select("id, name");
    if (vErr) { console.error("ERROR fetching vendors:", vErr); process.exit(3); }
    for (const v of existingVendors ?? []) lowerToId.set(v.name.toLowerCase(), v.id);

    let createdVendors = 0;
    for (const name of canonicalNames) {
      if (lowerToId.has(name.toLowerCase())) continue;
      const { data: newV, error: cErr } = await admin
        .from("vendors")
        .insert({ name, notes: "12.B history import: auto-created from EXPENSES tab mapping" })
        .select("id, name")
        .single();
      if (cErr || !newV) {
        const { data: retry } = await admin.from("vendors").select("id, name").ilike("name", name).maybeSingle();
        if (retry) lowerToId.set(retry.name.toLowerCase(), retry.id);
        else { console.error(`Could not create or find vendor "${name}":`, cErr); process.exit(3); }
      } else {
        lowerToId.set(newV.name.toLowerCase(), newV.id);
        createdVendors++;
      }
    }
    console.log(`Vendors: ${canonicalNames.size} canonical (${createdVendors} newly created)`);
  }

  const runStamp = new Date().toISOString();

  // 4A. Post cash-path rows as direct JEs (DR expense, CR 1010 Cash).
  let cashPosted = 0, cashAlready = 0, cashFailed = 0;
  for (const r of cashRows) {
    if (existingJeRows.has(`r${r.row_number}`)) { cashAlready++; continue; }

    const drId = codeToId.get(CATEGORY_TO_COA[r.category]!);
    const crId = codeToId.get("1010");
    if (!drId || !crId) { console.error(`r${r.row_number}: missing CoA`); cashFailed++; continue; }

    const fy = Number(r.posting_date.slice(0, 4));
    const { data: nextNum, error: numErr } = await admin.rpc("je_next_number", { p_fiscal_year: fy });
    if (numErr || !nextNum) { console.error(`r${r.row_number}: je_next_number`, numErr); cashFailed++; continue; }

    const { data: je, error: jeErr } = await admin
      .from("journal_entries")
      .insert({
        entry_number: nextNum,
        posting_date: r.posting_date,
        description: `[history] ${r.category}: ${r.expense || "(no vendor)"}`.slice(0, 500),
        notes: `imported_at=${runStamp} | xlsx EXPENSES r${r.row_number} | mop=(blank, mapped→cash) | ${r.description.slice(0, 200)}`,
        status: "draft",
        source_kind: "history_import" as never,
        source_id: null,
      })
      .select("id")
      .single();
    if (jeErr || !je) { console.error(`r${r.row_number}: JE insert`, jeErr); cashFailed++; continue; }

    const amt = Math.round(r.cost * 100) / 100;
    const lineDesc = [r.expense, r.description].filter(Boolean).join(" | ").slice(0, 500) || null;
    const { error: lErr } = await admin.from("journal_lines").insert([
      { entry_id: je.id, account_id: drId, debit_php: amt, credit_php: 0, description: lineDesc, line_order: 1 },
      { entry_id: je.id, account_id: crId, debit_php: 0, credit_php: amt, description: lineDesc, line_order: 2 },
    ]);
    if (lErr) {
      console.error(`r${r.row_number}: lines insert (rolling back JE):`, lErr);
      await admin.from("journal_entries").delete().eq("id", je.id);
      cashFailed++; continue;
    }
    const { error: pErr } = await admin
      .from("journal_entries")
      .update({ status: "posted", posted_at: new Date().toISOString() })
      .eq("id", je.id);
    if (pErr) { console.error(`r${r.row_number}: post flip`, pErr); cashFailed++; continue; }
    cashPosted++;
    if (cashPosted % 25 === 0) process.stdout.write(`\r  cash ${cashPosted}/${cashRows.length}`);
  }
  if (cashRows.length > 0) process.stdout.write("\n");

  // 4B. Post AP-path rows as vendor bills.
  let apPosted = 0, apAlready = 0, apFailed = 0;
  for (const r of apRows) {
    const invoiceNum = `HIST-EXP-r${r.row_number}`;
    if (existingBillNums.has(invoiceNum)) { apAlready++; continue; }

    const vendorId = lowerToId.get(r.canonical.toLowerCase());
    if (!vendorId) { console.error(`r${r.row_number}: vendor "${r.canonical}" not resolved`); apFailed++; continue; }
    const accountId = codeToId.get(CATEGORY_TO_COA[r.category]!);
    if (!accountId) { console.error(`r${r.row_number}: CoA ${CATEGORY_TO_COA[r.category]}`); apFailed++; continue; }

    const input = {
      vendor_id: vendorId,
      vendor_invoice_number: invoiceNum,
      bill_date: r.posting_date,
      due_date: addDays(r.posting_date, 30),
      description: `[history imported_at=${runStamp}] ${r.category}: ${r.expense || "(no vendor)"}${
        r.description ? ` — ${r.description.slice(0, 200)}` : ""
      }`.slice(0, 500),
      wt_exempt: true,
      lines: [
        { line_no: 1, description: r.description || r.expense || null, amount_php: Math.round(r.cost * 100) / 100, account_id: accountId },
      ],
    };
    const rpcResult = await (admin.rpc as unknown as (
      fn: string,
      args: Record<string, unknown>,
    ) => Promise<{ error: { message: string } | null }>)(
      "ap_create_bill_and_post",
      { p_input: input, p_actor_id: actorId },
    );
    if (rpcResult.error) {
      console.error(`r${r.row_number}: ap_create_bill_and_post failed:`, rpcResult.error.message);
      apFailed++; continue;
    }
    apPosted++;
    if (apPosted % 25 === 0) process.stdout.write(`\r  ap ${apPosted}/${apRows.length}`);
  }
  if (apRows.length > 0) process.stdout.write("\n");

  console.log(`\nCommit complete:`);
  console.log(`  Cash path:   posted=${cashPosted}  already=${cashAlready}  failed=${cashFailed}`);
  console.log(`  AP path:     posted=${apPosted}  already=${apAlready}  failed=${apFailed}`);
  console.log(`\nRollback (dev only):`);
  console.log(`  -- cash-path JEs: same as expenses.ts rollback (filter notes for mop=(blank, mapped→cash))`);
  console.log(
    `  -- AP-path bills: select id from bills where vendor_invoice_number like 'HIST-EXP-r%' and bill_date between '${year}-01-01' and '${year}-12-31';`,
  );
  console.log(`  --   then admin.rpc('ap_void_bill', {p_bill_id, p_actor_id, p_reason: '12.B rollback'}) per bill.`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs();
  console.log(`Reading: ${args.xlsx}`);
  const { candidates, skipped } = await loadCandidates(args.xlsx, args.year);
  summarise(args.year, candidates, skipped);

  const csvPath = await writeCsv(args.year, candidates);
  console.log(`\nFull row-by-row CSV: ${csvPath}`);

  // Without --mapping, emit a heuristic-seeded vendor-mapping CSV and stop.
  if (!args.mapping) {
    const mappingPath = await emitMappingCsv(args.year, candidates);
    console.log(`\nVendor mapping (heuristic defaults) written to:`);
    console.log(`  ${mappingPath}`);
    console.log(`\nNext step: review/edit the canonical names and action column (ap | cash), then:`);
    console.log(
      `  npm run import:history:expenses-ap -- --year=${args.year} --mapping="${mappingPath}"                       # dry-run with mapping`,
    );
    console.log(
      `  npm run import:history:expenses-ap -- --year=${args.year} --mapping="${mappingPath}" --commit --confirm="I-mean-it"`,
    );
    return;
  }

  console.log(`\nLoading mapping: ${args.mapping}`);
  const mapping = await loadMappingCsv(args.mapping);
  const { resolved, unmapped } = applyMapping(candidates, mapping);
  console.log(`Mapping resolved ${resolved.length} of ${candidates.length} rows.`);
  if (unmapped.length > 0) {
    console.error(`\nERROR: ${unmapped.length} candidate rows have no entry in the mapping CSV.`);
    console.error(`Add rows to the CSV (e.g., these raw_names) and re-run.`);
    for (const u of unmapped.slice(0, 5)) {
      console.error(`  r${u.row_number}  raw_name="${normaliseVendorName(u.expense)}"`);
    }
    process.exit(3);
  }
  summariseResolved(resolved);

  if (!args.commit) {
    console.log(
      `\nDry-run (with mapping). To commit on dev:\n  npm run import:history:expenses-ap -- --year=${args.year} --mapping="${args.mapping}" --commit --confirm="I-mean-it"\n`,
    );
    return;
  }

  if (!args.confirmed) {
    console.error('\nERROR: --commit requires --confirm="I-mean-it".');
    process.exit(3);
  }

  await commit(args.year, resolved, args.actor);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
