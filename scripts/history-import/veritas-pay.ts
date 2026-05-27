/**
 * 12.B history import — VERITAS PAY tab.
 *
 *   npm run import:history:veritas-pay -- --year=2025                          # dry-run
 *   npm run import:history:veritas-pay -- --year=2025 --commit --confirm="I-mean-it"
 *
 * Each VERITAS PAY row is a settlement statement: on Settlement Date, the
 * payment processor deposits Net Settlement = Total Volume − Merchant Fee
 * into the clinic's BPI account, against HMO claims processed in the
 * Period Covered.
 *
 * Per row JE (one per settlement):
 *   DR 1020  Cash in Bank — BPI            (Net Settlement)
 *   DR 6610  Legal & Regulatory             (Merchant Fees = Volume − Net)
 *   CR 1110  Accounts Receivable — HMO     (Total Volume)
 *
 * NOTE: until DOCTOR CONSULTATION + LAB SERVICE imports land, the CR 1110
 * will pile up as a NEGATIVE AR balance. That's expected and resolves when
 * the revenue-side history is posted.
 *
 * source_kind='history_import'; notes='xlsx VERITAS PAY r{N} | SOA={SOA}';
 * idempotent via notes-row marker, per-year fetch.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../../src/types/database";
import { requireLocalOrExplicitProd } from "../lib/env-guard";

const XLSX_PATH_DEFAULT = `${process.env.HOME ?? ""}/Downloads/DR MED MASTERSHEET.xlsx`;

interface Args {
  xlsx: string;
  year: number;
  commit: boolean;
  confirmed: boolean;
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
  return { xlsx, year, commit, confirmed };
}

function excelSerialToISO(serial: number): string {
  const base = Date.UTC(1899, 11, 30);
  return new Date(base + serial * 86400 * 1000).toISOString().slice(0, 10);
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

// Settlement Date column accepts both MM/DD/YYYY strings and Excel serial.
function parseSettlementDate(raw: ExcelJS.CellValue): string | null {
  if (raw == null) return null;
  if (typeof raw === "number") return excelSerialToISO(raw);
  if (raw instanceof Date) return raw.toISOString().slice(0, 10);
  const s = cellText(raw).trim();
  if (!s) return null;
  // MM/DD/YYYY
  const usMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (usMatch) {
    return `${usMatch[3]}-${usMatch[1].padStart(2, "0")}-${usMatch[2].padStart(2, "0")}`;
  }
  // Numeric string (Excel serial)
  if (/^\d+(\.\d+)?$/.test(s)) return excelSerialToISO(Number(s));
  // ISO already
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}

interface RawRow {
  row_number: number;
  soa_no: string;
  period_covered: string;
  settlement_date: string;
  total_volume: number;
  net_settlement: number;
  status: string;
}

async function loadRows(xlsxPath: string, year: number): Promise<{
  postable: RawRow[];
  skipped: { row_number: number; reason: string }[];
}> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);
  const ws = wb.getWorksheet("VERITAS PAY");
  if (!ws) throw new Error(`VERITAS PAY sheet not found in ${xlsxPath}`);

  const postable: RawRow[] = [];
  const skipped: { row_number: number; reason: string }[] = [];

  ws.eachRow({ includeEmpty: false }, (row, rn) => {
    if (rn === 1) return; // header

    // Columns: A=SOA No, B=Period Covered, C=Merchant Name, D=Store, E=Code,
    // F=Settlement Date, G=Txn Count, H=Total Volume, I=Net Settlement, J=Status.
    const settlementDate = parseSettlementDate(row.getCell(6).value);
    const volume = Number(cellText(row.getCell(8).value)) || 0;
    const net = Number(cellText(row.getCell(9).value)) || 0;
    const status = cellText(row.getCell(10).value).trim();
    const soa = cellText(row.getCell(1).value).trim();
    const period = cellText(row.getCell(2).value).trim();

    // Real settlement rows have F (date) + I (net). Other rows are blanks /
    // partial drafts — skip silently unless they look intentional.
    if (!settlementDate || net <= 0 || volume <= 0) return;

    if (settlementDate.slice(0, 4) !== String(year)) return;

    if (status && status.toLowerCase() !== "settled") {
      skipped.push({ row_number: rn, reason: `status=${status}` });
      return;
    }
    if (net > volume) {
      // Net should always be ≤ Total Volume (after fees deducted).
      skipped.push({ row_number: rn, reason: `net (${net}) > volume (${volume})` });
      return;
    }

    postable.push({
      row_number: rn,
      soa_no: soa,
      period_covered: period,
      settlement_date: settlementDate,
      total_volume: volume,
      net_settlement: net,
      status,
    });
  });

  return { postable, skipped };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function summarise(year: number, rows: RawRow[], skipped: { row_number: number; reason: string }[]): void {
  const sumVol = rows.reduce((s, r) => s + r.total_volume, 0);
  const sumNet = rows.reduce((s, r) => s + r.net_settlement, 0);
  const sumFees = sumVol - sumNet;
  console.log(`\n=== VERITAS PAY dry-run (year ${year}) ===`);
  console.log(`Rows postable:   ${rows.length}`);
  console.log(`Rows skipped:    ${skipped.length}`);
  console.log(`Total Volume ₱:  ${sumVol.toFixed(2)} → CR 1110 AR HMO`);
  console.log(`Net Settlement ₱: ${sumNet.toFixed(2)} → DR 1020 BPI`);
  console.log(`Merchant Fees ₱: ${sumFees.toFixed(2)} → DR 6610 Legal & Reg`);
  if (skipped.length > 0) {
    const reasons = new Map<string, number>();
    for (const s of skipped) reasons.set(s.reason.split(":")[0], (reasons.get(s.reason.split(":")[0]) ?? 0) + 1);
    console.log("\nSkipped reasons:");
    for (const [k, n] of reasons) console.log(`  ${n.toString().padStart(4)}  ${k}`);
  }
}

async function writeCsv(year: number, rows: RawRow[]): Promise<string> {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.resolve("tmp");
  await fs.mkdir(dir, { recursive: true });
  const out = path.join(dir, `history-import-veritas-${year}-${ts}.csv`);

  const header = ["row_number", "soa_no", "settlement_date", "period_covered", "total_volume", "net_settlement", "fee"];
  const lines: string[][] = [header];
  for (const r of rows) {
    const fee = round2(r.total_volume - r.net_settlement);
    lines.push([
      String(r.row_number),
      r.soa_no,
      r.settlement_date,
      r.period_covered,
      r.total_volume.toFixed(2),
      r.net_settlement.toFixed(2),
      fee.toFixed(2),
    ]);
  }
  const text = lines.map((row) => row.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\n");
  await fs.writeFile(out, text);
  return out;
}

async function commit(year: number, rows: RawRow[]): Promise<void> {
  requireLocalOrExplicitProd("import:history:veritas-pay");
  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error("ERROR: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required.");
    process.exit(2);
  }
  const admin = createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: accounts, error: aErr } = await admin.from("chart_of_accounts").select("id, code");
  if (aErr || !accounts) { console.error("ERROR fetching CoA:", aErr); process.exit(3); }
  const codeToId = new Map(accounts.map((a) => [a.code, a.id]));
  for (const c of ["1020", "1110", "6610"]) {
    if (!codeToId.has(c)) { console.error(`ERROR: CoA missing ${c}`); process.exit(3); }
  }

  // Idempotency: pre-filter by VERITAS PAY marker so the 1000-row cap can't
  // be hit by sibling-tab imports (DOC CONS ~8K/yr, LAB SERVICE ~18K/yr).
  const { data: existing, error: eErr } = await admin
    .from("journal_entries")
    .select("notes")
    .eq("source_kind", "history_import" as never)
    .like("notes", "%xlsx VERITAS PAY r%")
    .gte("posting_date", `${year}-01-01`)
    .lte("posting_date", `${year}-12-31`);
  if (eErr) { console.error("ERROR fetching JEs:", eErr); process.exit(3); }
  if (existing && existing.length >= 1000) {
    console.error(`Aborting: VERITAS PAY idempotency fetch ≥1000 — paginate.`);
    process.exit(3);
  }
  const existingKeys = new Set<string>();
  for (const e of existing ?? []) {
    const m = /xlsx VERITAS PAY r(\d+)/.exec(e.notes ?? "");
    if (m) existingKeys.add(`r${m[1]}`);
  }

  const drBpiId = codeToId.get("1020")!;
  const drFeesId = codeToId.get("6610")!;
  const crArId = codeToId.get("1110")!;

  const runStamp = new Date().toISOString();
  let posted = 0, already = 0, failed = 0;
  for (const r of rows) {
    if (existingKeys.has(`r${r.row_number}`)) { already++; continue; }

    // Compute CR first, derive DR pieces from it so DR sum exactly matches CR.
    // (round2(net) + round2(volume − net) != round2(volume) is possible.)
    const crTotal = round2(r.total_volume);
    const drNet = round2(r.net_settlement);
    const fee = round2(crTotal - drNet);
    const fy = Number(r.settlement_date.slice(0, 4));
    const { data: nextNum, error: numErr } = await admin.rpc("je_next_number", { p_fiscal_year: fy });
    if (numErr || !nextNum) { console.error(`r${r.row_number}: je_next_number`, numErr); failed++; continue; }

    const desc = `[history] Veritas Pay settlement ${r.soa_no || "(no SOA)"}`.slice(0, 500);
    const notes = `imported_at=${runStamp} | xlsx VERITAS PAY r${r.row_number} | SOA=${r.soa_no} | period=${r.period_covered}`.slice(0, 2000);

    const { data: je, error: jeErr } = await admin
      .from("journal_entries")
      .insert({
        entry_number: nextNum,
        posting_date: r.settlement_date,
        description: desc,
        notes,
        status: "draft",
        source_kind: "history_import" as never,
        source_id: null,
      })
      .select("id")
      .single();
    if (jeErr || !je) { console.error(`r${r.row_number}: JE insert`, jeErr); failed++; continue; }

    const lineDesc = `Veritas Pay settlement ${r.soa_no} (${r.period_covered})`.slice(0, 500);
    const lines: { entry_id: string; account_id: string; debit_php: number; credit_php: number; description: string; line_order: number }[] = [
      { entry_id: je.id, account_id: drBpiId, debit_php: drNet, credit_php: 0, description: lineDesc, line_order: 1 },
    ];
    if (fee > 0) {
      lines.push({ entry_id: je.id, account_id: drFeesId, debit_php: fee, credit_php: 0, description: `Veritas Pay merchant fee (${r.soa_no})`, line_order: 2 });
    }
    lines.push({ entry_id: je.id, account_id: crArId, debit_php: 0, credit_php: crTotal, description: lineDesc, line_order: lines.length + 1 });

    const { error: lErr } = await admin.from("journal_lines").insert(lines);
    if (lErr) {
      console.error(`r${r.row_number}: lines insert (rolling back JE):`, lErr);
      await admin.from("journal_entries").delete().eq("id", je.id);
      failed++; continue;
    }

    const { error: pErr } = await admin
      .from("journal_entries")
      .update({ status: "posted", posted_at: new Date().toISOString() })
      .eq("id", je.id);
    if (pErr) { console.error(`r${r.row_number}: post flip`, pErr); failed++; continue; }
    posted++;
    if (posted % 10 === 0) process.stdout.write(`\r  posted ${posted}/${rows.length}`);
  }
  process.stdout.write("\n");

  console.log(`\nCommit complete:`);
  console.log(`  Posted:           ${posted}`);
  console.log(`  Already-existed:  ${already}`);
  console.log(`  Failed:           ${failed}`);
  console.log(`\nRollback (dev only):`);
  console.log(`  -- 1. UPDATE journal_entries SET status='draft' WHERE source_kind='history_import' AND notes LIKE 'xlsx VERITAS PAY r%' AND posting_date BETWEEN '${year}-01-01' AND '${year}-12-31';`);
  console.log(`  -- 2. DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE source_kind='history_import' AND notes LIKE 'xlsx VERITAS PAY r%' AND posting_date BETWEEN '${year}-01-01' AND '${year}-12-31');`);
  console.log(`  -- 3. DELETE FROM journal_entries WHERE source_kind='history_import' AND notes LIKE 'xlsx VERITAS PAY r%' AND posting_date BETWEEN '${year}-01-01' AND '${year}-12-31';`);
}

async function main() {
  const args = parseArgs();
  console.log(`Reading: ${args.xlsx}`);
  const { postable, skipped } = await loadRows(args.xlsx, args.year);
  summarise(args.year, postable, skipped);

  const csv = await writeCsv(args.year, postable);
  console.log(`\nRow-by-row CSV: ${csv}`);

  if (!args.commit) {
    console.log(`\nDry-run. To commit:\n  npm run import:history:veritas-pay -- --year=${args.year} --commit --confirm="I-mean-it"\n`);
    return;
  }
  if (!args.confirmed) {
    console.error('\nERROR: --commit requires --confirm="I-mean-it".');
    process.exit(3);
  }
  await commit(args.year, postable);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
