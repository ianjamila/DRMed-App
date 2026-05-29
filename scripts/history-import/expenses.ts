/**
 * 12.B history import — EXPENSES tab of DR MED MASTERSHEET.xlsx.
 *
 *   npm run import:history:expenses -- --year=2023                     # dry-run
 *   npm run import:history:expenses -- --year=2023 --commit --confirm="I-mean-it"
 *
 * Default xlsx path: ~/Downloads/DR MED MASTERSHEET.xlsx (override with --xlsx=).
 *
 * Per the agreed mapping (2026-05-27):
 *   - Category → CoA (16 of 21 match 1:1 to existing codes; "Out of Pocket
 *     Expense" routes DR 9999 Suspense for later reclassification by admin).
 *   - MOP → CR cash/bank/shareholder account:
 *       CLINIC CASH               → 1010
 *       CLINIC GCASH / GCASH      → 1030
 *       CHEQUE                    → 1020 (BPI per user decision)
 *       IAN / FREYA (shareholder) → 2500 Due to Shareholders (added in 0075)
 *       (blank)                   → 1010 (corrected 2026-05-27: all blank-MOP
 *                                    rows were paid same-day from clinic cash,
 *                                    regardless of year — earlier Hybrid C
 *                                    routing 2026 to AP was wrong)
 *
 * Idempotency: each row's JE notes encode `xlsx EXPENSES r{n}`. Before insert
 * we fetch the existing notes-set and skip rows already present.
 *
 * source_kind='history_import' (added in migration 0074) so admins can filter
 * these out of normal accounting views and mass-reverse if needed.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../../src/types/database";
import { requireLocalOrExplicitProd } from "../lib/env-guard";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

interface Args {
  xlsx: string;
  year: number;
  commit: boolean;
  confirmed: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const xlsx =
    argv.find((a) => a.startsWith("--xlsx="))?.substring(7) ??
    `${process.env.HOME ?? ""}/Downloads/DR MED MASTERSHEET.xlsx`;
  const yearArg = argv.find((a) => a.startsWith("--year="))?.substring(7);
  if (!yearArg) {
    console.error("ERROR: --year=YYYY is required (e.g. --year=2023)");
    process.exit(2);
  }
  const year = Number(yearArg);
  if (!Number.isInteger(year) || year < 2023 || year > 2030) {
    console.error(`ERROR: --year must be an integer 2023-2030, got ${yearArg}`);
    process.exit(2);
  }
  const commit = argv.includes("--commit");
  const confirmed =
    argv.includes('--confirm="I-mean-it"') ||
    argv.includes("--confirm=I-mean-it");
  return { xlsx, year, commit, confirmed };
}

// ---------------------------------------------------------------------------
// Mapping policy
// ---------------------------------------------------------------------------

const CATEGORY_TO_COA: Record<string, string | null> = {
  "Salaries & Wages": "6100",
  "Doctors Payroll": "6110",
  Benefits: "6120",
  "Past HMO of Doctors": "6120",
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
  // OOP rows aren't an expense type — the actual type is in the description.
  // Park at Suspense for admin to reclassify case-by-case.
  "Out of Pocket Expense": "9999",
  // These two are atypical — skip and surface so the user can hand-enter.
  "Payment by Shareholders": null,
  "For Reimbursement": null,
};

function normaliseMop(raw: string | null | undefined): string {
  if (!raw) return "(blank)";
  const t = raw.trim().toLowerCase();
  if (!t) return "(blank)";
  if (t.includes("cheque")) return "CHEQUE";
  if (t.includes("gcash") && t.includes("clinic")) return "CLINIC GCASH";
  if (t === "gcash") return "GCASH";
  if (t.includes("clinic") && t.includes("cash")) return "CLINIC CASH";
  if (t === "ian") return "IAN";
  if (t === "freya") return "FREYA";
  return raw.trim().toUpperCase();
}

interface CreditTarget {
  coaCode: string;
}

function mopToCredit(mop: string | null | undefined): CreditTarget {
  const m = normaliseMop(mop);
  switch (m) {
    case "CLINIC CASH":
      return { coaCode: "1010" };
    case "CLINIC GCASH":
    case "GCASH":
      return { coaCode: "1030" };
    case "CHEQUE":
      return { coaCode: "1020" };
    case "IAN":
    case "FREYA":
      return { coaCode: "2500" };
    case "(blank)":
      // Partner confirmed (2026-05-27): all blank-MOP rows were paid
      // same-day from clinic cash, regardless of year or category.
      return { coaCode: "1010" };
    default:
      // "10k gcash, rest cash" mixed-split, "NOT YET GIVEN, FOR LAST PAY NA",
      // and any other weirdness — park to Suspense + flag.
      return { coaCode: "9999" };
  }
}

// ---------------------------------------------------------------------------
// Excel reader
// ---------------------------------------------------------------------------

interface RawRow {
  row_number: number;
  date_raw: ExcelJS.CellValue;
  category: string;
  cost: number;
  expense: string;
  description: string;
  mop: string;
  status: string;
}

function excelSerialToISO(serial: number): string {
  // Excel epoch = 1899-12-30 (matches openpyxl + LibreOffice).
  const base = Date.UTC(1899, 11, 30);
  const ms = base + serial * 86400 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
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

async function readRawRows(xlsxPath: string): Promise<RawRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);
  const ws = wb.getWorksheet("EXPENSES");
  if (!ws) throw new Error(`EXPENSES sheet not found in ${xlsxPath}`);

  const out: RawRow[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rn) => {
    if (rn <= 2) return; // title + header
    // Rows 3-11 are the FB Ads summary block (totals per campaign, no #).
    // Skip them — those aren't transactions.
    if (rn >= 3 && rn <= 11) {
      const c = cellText(row.getCell(3).value).trim();
      if (c === "FB Ads") return;
    }
    out.push({
      row_number: rn,
      date_raw: row.getCell(2).value,
      category: cellText(row.getCell(3).value).trim(),
      cost: Number(cellText(row.getCell(4).value)) || 0,
      expense: cellText(row.getCell(5).value).trim(),
      description: cellText(row.getCell(6).value).trim(),
      mop: cellText(row.getCell(7).value).trim(),
      status: cellText(row.getCell(8).value).trim(),
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Build proposed JEs
// ---------------------------------------------------------------------------

interface ProposedLine {
  account_code: string;
  debit_php: number;
  credit_php: number;
  description: string | null;
}

interface ProposedJE {
  row_number: number;
  posting_date: string;
  description: string;
  notes: string;
  lines: ProposedLine[];
  warnings: string[];
  skip_reason?: string;
}

function buildProposed(rows: RawRow[], year: number): ProposedJE[] {
  const out: ProposedJE[] = [];

  for (const r of rows) {
    const base: Omit<ProposedJE, "lines"> = {
      row_number: r.row_number,
      posting_date: "",
      description: `[history] ${r.category}: ${r.expense || "(no vendor)"}`.slice(0, 500),
      notes: `xlsx EXPENSES r${r.row_number} | mop=${normaliseMop(r.mop)}${
        r.description ? ` | ${r.description.slice(0, 200)}` : ""
      }`,
      warnings: [],
    };

    // Date — accept Excel serial number, ISO date string, MM/DD/YYYY string,
    // or Date object. ExcelJS sometimes returns date-formatted cells as a
    // locale-formatted string when the cell has a custom format.
    let postingDate = "";
    if (typeof r.date_raw === "number") {
      postingDate = excelSerialToISO(r.date_raw);
    } else if (r.date_raw instanceof Date) {
      postingDate = r.date_raw.toISOString().slice(0, 10);
    } else if (typeof r.date_raw === "string") {
      const s = r.date_raw.trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        postingDate = s;
      } else if (/^\d+(\.\d+)?$/.test(s)) {
        postingDate = excelSerialToISO(Number(s));
      } else {
        const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
        if (us) postingDate = `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
      }
    }

    if (!postingDate) {
      out.push({
        ...base,
        lines: [],
        skip_reason: `unparseable date: ${JSON.stringify(r.date_raw)}`,
      });
      continue;
    }

    // Year filter.
    if (postingDate.slice(0, 4) !== String(year)) continue;

    base.posting_date = postingDate;

    if (!r.cost || r.cost <= 0) {
      out.push({ ...base, lines: [], skip_reason: `cost=${r.cost} (expected > 0)` });
      continue;
    }

    if (!r.category) {
      out.push({ ...base, lines: [], skip_reason: "missing category" });
      continue;
    }

    const drCode = CATEGORY_TO_COA[r.category];
    if (drCode === null) {
      out.push({
        ...base,
        lines: [],
        skip_reason: `category "${r.category}" requires manual JE (atypical)`,
      });
      continue;
    }
    if (drCode === undefined) {
      out.push({
        ...base,
        lines: [],
        skip_reason: `unmapped category: ${r.category}`,
      });
      continue;
    }

    const cr = mopToCredit(r.mop);

    const warnings: string[] = [];
    if (drCode === "9999")
      warnings.push("DR to Suspense (Out of Pocket — admin must reclassify)");
    if (cr.coaCode === "9999")
      warnings.push(`CR to Suspense (unparseable MOP: ${r.mop})`);

    const lineDesc =
      [r.expense, r.description].filter(Boolean).join(" | ").slice(0, 500) || null;

    out.push({
      ...base,
      warnings,
      lines: [
        { account_code: drCode, debit_php: round2(r.cost), credit_php: 0, description: lineDesc },
        { account_code: cr.coaCode, debit_php: 0, credit_php: round2(r.cost), description: lineDesc },
      ],
    });
  }

  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Dry-run report
// ---------------------------------------------------------------------------

function summarise(year: number, proposed: ProposedJE[]): void {
  const postable = proposed.filter((p) => !p.skip_reason);
  const skipped = proposed.filter((p) => !!p.skip_reason);

  const byCat = new Map<string, { n: number; total: number }>();
  let total = 0;
  for (const p of postable) {
    const dr = p.lines.find((l) => l.debit_php > 0);
    if (!dr) continue;
    const key = dr.account_code;
    const prev = byCat.get(key) ?? { n: 0, total: 0 };
    prev.n += 1;
    prev.total += dr.debit_php;
    byCat.set(key, prev);
    total += dr.debit_php;
  }

  const byCredit = new Map<string, { n: number; total: number }>();
  for (const p of postable) {
    const cr = p.lines.find((l) => l.credit_php > 0);
    if (!cr) continue;
    const prev = byCredit.get(cr.account_code) ?? { n: 0, total: 0 };
    prev.n += 1;
    prev.total += cr.credit_php;
    byCredit.set(cr.account_code, prev);
  }

  const skipReasons = new Map<string, number>();
  for (const p of skipped) {
    const k = (p.skip_reason ?? "").split(":")[0];
    skipReasons.set(k, (skipReasons.get(k) ?? 0) + 1);
  }

  const warningCount = new Map<string, number>();
  for (const p of postable) {
    for (const w of p.warnings) {
      const k = w.split(" (")[0];
      warningCount.set(k, (warningCount.get(k) ?? 0) + 1);
    }
  }

  console.log(`\n=== EXPENSES dry-run report (year ${year}) ===`);
  console.log(`Rows postable:   ${postable.length}`);
  console.log(`Rows skipped:    ${skipped.length}`);
  console.log(`Total DR ₱:      ${total.toFixed(2)}`);

  console.log("\nDR by account:");
  for (const [code, v] of [...byCat.entries()].sort()) {
    console.log(`  ${code.padEnd(6)} ${v.n.toString().padStart(4)} rows  ₱${v.total.toFixed(2).padStart(14)}`);
  }
  console.log("\nCR by account:");
  for (const [code, v] of [...byCredit.entries()].sort()) {
    console.log(`  ${code.padEnd(6)} ${v.n.toString().padStart(4)} rows  ₱${v.total.toFixed(2).padStart(14)}`);
  }

  if (warningCount.size > 0) {
    console.log("\nWarnings raised (still postable):");
    for (const [k, n] of [...warningCount.entries()].sort()) {
      console.log(`  ${n.toString().padStart(4)}  ${k}`);
    }
  }

  if (skipReasons.size > 0) {
    console.log("\nSkipped rows by reason:");
    for (const [k, n] of [...skipReasons.entries()].sort()) {
      console.log(`  ${n.toString().padStart(4)}  ${k}`);
    }
  }
}

async function writeCsv(proposed: ProposedJE[], year: number): Promise<string> {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.resolve("tmp");
  await fs.mkdir(dir, { recursive: true });
  const out = path.join(dir, `history-import-expenses-${year}-${ts}.csv`);

  const header = [
    "row_number",
    "posting_date",
    "skip_reason",
    "description",
    "dr_code",
    "dr_amount",
    "cr_code",
    "cr_amount",
    "warnings",
    "notes",
  ];
  const lines: string[][] = [header];
  for (const p of proposed) {
    const dr = p.lines.find((l) => l.debit_php > 0);
    const cr = p.lines.find((l) => l.credit_php > 0);
    lines.push([
      String(p.row_number),
      p.posting_date,
      p.skip_reason ?? "",
      p.description,
      dr?.account_code ?? "",
      dr ? dr.debit_php.toFixed(2) : "",
      cr?.account_code ?? "",
      cr ? cr.credit_php.toFixed(2) : "",
      p.warnings.join("; "),
      p.notes,
    ]);
  }
  const text = lines
    .map((row) => row.map((c) => `"${c.replace(/"/g, '""')}"`).join(","))
    .join("\n");
  await fs.writeFile(out, text);
  return out;
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

async function commit(year: number, proposed: ProposedJE[]): Promise<void> {
  requireLocalOrExplicitProd("import:history:expenses");

  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error(
      "ERROR: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local.",
    );
    process.exit(2);
  }

  const admin = createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1. Resolve account code → uuid once.
  const { data: accounts, error: aErr } = await admin
    .from("chart_of_accounts")
    .select("id, code");
  if (aErr || !accounts) {
    console.error("ERROR fetching chart_of_accounts:", aErr);
    process.exit(3);
  }
  const codeToId = new Map(accounts.map((a) => [a.code, a.id]));

  const requiredCodes = new Set<string>();
  for (const p of proposed) {
    for (const l of p.lines) requiredCodes.add(l.account_code);
  }
  const missing = [...requiredCodes].filter((c) => !codeToId.has(c));
  if (missing.length > 0) {
    console.error(`ERROR: chart_of_accounts is missing codes: ${missing.join(", ")}`);
    console.error("Apply migrations 0074 + 0075 first (npm run db:reset on dev).");
    process.exit(3);
  }

  // 2. Fetch existing history_import notes for THIS year + THIS tab.
  // Pre-filtering by notes pattern keeps the per-year fetch under the 1000-row
  // PostgREST cap even after sibling tabs (DOC ~8K, LAB ~18K per year) land.
  const { data: existing, error: eErr } = await admin
    .from("journal_entries")
    .select("notes")
    .eq("source_kind", "history_import" as never)
    .like("notes", "%xlsx EXPENSES r%")
    .gte("posting_date", `${year}-01-01`)
    .lte("posting_date", `${year}-12-31`);
  if (eErr) {
    console.error("ERROR fetching existing history_import JEs:", eErr);
    process.exit(3);
  }
  if (existing && existing.length >= 1000) {
    console.error(
      `WARNING: idempotency fetch returned ${existing.length} rows (≥1000). ` +
        `Supabase default cap may be truncating — re-import will create duplicates. ` +
        `Aborting.`,
    );
    process.exit(3);
  }
  const existingKeys = new Set<string>();
  for (const e of existing ?? []) {
    const m = /xlsx EXPENSES r(\d+)/.exec(e.notes ?? "");
    if (m) existingKeys.add(`r${m[1]}`);
  }

  // 3. Post each (skip if already posted).
  const postable = proposed.filter((p) => !p.skip_reason);
  const runStamp = new Date().toISOString();
  let posted = 0;
  let already = 0;
  let failed = 0;

  for (const p of postable) {
    const key = `r${p.row_number}`;
    if (existingKeys.has(key)) {
      already++;
      continue;
    }

    const fiscalYear = Number(p.posting_date.slice(0, 4));
    const { data: nextNum, error: numErr } = await admin.rpc("je_next_number", {
      p_fiscal_year: fiscalYear,
    });
    if (numErr || !nextNum) {
      console.error(`r${p.row_number}: je_next_number failed:`, numErr);
      failed++;
      continue;
    }

    const { data: je, error: jeErr } = await admin
      .from("journal_entries")
      .insert({
        entry_number: nextNum,
        posting_date: p.posting_date,
        description: p.description,
        notes: `imported_at=${runStamp} | ${p.notes}`.slice(0, 2000),
        status: "draft",
        source_kind: "history_import" as never,
        source_id: null,
      })
      .select("id")
      .single();
    if (jeErr || !je) {
      console.error(`r${p.row_number}: JE insert failed:`, jeErr);
      failed++;
      continue;
    }

    const lineRows = p.lines.map((l, i) => ({
      entry_id: je.id,
      account_id: codeToId.get(l.account_code)!,
      debit_php: l.debit_php,
      credit_php: l.credit_php,
      description: l.description,
      line_order: i + 1,
    }));
    const { error: lErr } = await admin.from("journal_lines").insert(lineRows);
    if (lErr) {
      console.error(`r${p.row_number}: lines insert failed (rolling back JE):`, lErr);
      await admin.from("journal_entries").delete().eq("id", je.id);
      failed++;
      continue;
    }

    const { error: pErr } = await admin
      .from("journal_entries")
      .update({ status: "posted", posted_at: new Date().toISOString() })
      .eq("id", je.id);
    if (pErr) {
      console.error(`r${p.row_number}: post flip failed (left as draft):`, pErr);
      failed++;
      continue;
    }

    posted++;
    if (posted % 25 === 0) process.stdout.write(`\r  posted ${posted}/${postable.length}`);
  }

  process.stdout.write("\n");
  console.log(`\nCommit complete:`);
  console.log(`  Posted:           ${posted}`);
  console.log(`  Already-existed:  ${already}`);
  console.log(`  Failed:           ${failed}`);
  console.log(`\nRollback (dev only):`);
  console.log(
    `  delete from journal_lines where entry_id in (select id from journal_entries where source_kind='history_import' and notes like 'xlsx EXPENSES r%' and posting_date >= '${year}-01-01' and posting_date <= '${year}-12-31');`,
  );
  console.log(
    `  delete from journal_entries where source_kind='history_import' and notes like 'xlsx EXPENSES r%' and posting_date >= '${year}-01-01' and posting_date <= '${year}-12-31';`,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs();
  console.log(`Reading: ${args.xlsx}`);
  const rows = await readRawRows(args.xlsx);
  console.log(`EXPENSES rows read (excl title/header/FB-Ads block): ${rows.length}`);

  const proposed = buildProposed(rows, args.year);
  summarise(args.year, proposed);

  const csvPath = await writeCsv(proposed, args.year);
  console.log(`\nFull row-by-row CSV: ${csvPath}`);

  if (!args.commit) {
    console.log(
      `\nDry-run. Review the CSV. To commit on dev:\n  npm run import:history:expenses -- --year=${args.year} --commit --confirm="I-mean-it"\n`,
    );
    return;
  }

  if (!args.confirmed) {
    console.error('\nERROR: --commit requires --confirm="I-mean-it" exactly.');
    process.exit(3);
  }

  await commit(args.year, proposed);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
