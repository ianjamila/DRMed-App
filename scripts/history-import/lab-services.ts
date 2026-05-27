/**
 * 12.B history import — LAB SERVICE tab.
 *
 *   npm run import:history:lab-services -- --year=2025                         # dry-run
 *   npm run import:history:lab-services -- --year=2025 --commit --confirm="I-mean-it"
 *
 * GROSS revenue model: labs don't have doctor PFs, so the clinic books the
 * full FINAL price as revenue (4100 Lab Tests Sales Revenue).
 *
 * Row classes & treatment:
 *
 *   Cash-style with FINAL > 0:
 *     One JE per row:
 *       DR <cash channel from col O> (FINAL)
 *       DR 4910 Lab Discounts (BASE − FINAL)         [contra-revenue, if any]
 *       CR 4100 Lab Tests Revenue (BASE)
 *
 *   HMO with FINAL > 0:
 *     One JE per row + one historic_hmo_claims row:
 *       DR 1110 AR-HMO (FINAL)
 *       DR 4910 Lab Discounts (BASE − FINAL)
 *       CR 4100 Lab Tests Revenue (BASE)
 *     Plus: insert historic_hmo_claims with status mapped from col X.
 *
 *   Skip + log (exclusion CSV):
 *     - FINAL = 0 (no revenue to book)
 *     - bad date (typo'd year, blank)
 *     - HMO claim with all zero amounts (rare for labs)
 *
 * Idempotency:
 *   - JEs: source_kind='history_import' + notes contains 'xlsx LAB SERVICE r{N}'
 *   - HMO subledger: unique (source_tab, source_row).
 *
 * The 1000-row PostgREST cap is a real concern: LAB SERVICE has ~6,500
 * rows/year in 2024+2025. The idempotency fetch chunks by month, then merges.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
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
  if (v instanceof Date) {
    const t = v.getTime();
    return Number.isNaN(t) ? "" : v.toISOString().slice(0, 10);
  }
  if (typeof v === "object" && "richText" in v && Array.isArray(v.richText)) {
    return v.richText.map((r) => r.text ?? "").join("");
  }
  if (typeof v === "object" && "text" in v) return String((v as { text: unknown }).text);
  if (typeof v === "object" && "result" in v) return cellText((v as { result: ExcelJS.CellValue }).result);
  return String(v);
}
function parseDate(raw: ExcelJS.CellValue): string | null {
  if (raw == null) return null;
  if (typeof raw === "number") return excelSerialToISO(raw);
  if (raw instanceof Date) {
    const t = raw.getTime();
    if (Number.isNaN(t)) return null;
    return raw.toISOString().slice(0, 10);
  }
  const s = cellText(raw).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d+(\.\d+)?$/.test(s)) return excelSerialToISO(Number(s));
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  return null;
}
function fnum(raw: ExcelJS.CellValue): number {
  if (raw == null) return 0;
  if (typeof raw === "number") return raw;
  const s = cellText(raw).trim();
  if (!s || s.toUpperCase() === "N/A" || s.toUpperCase() === "NA") return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}
function round2(n: number): number { return Math.round(n * 100) / 100; }

function titleCase(s: string): string {
  return s.toLowerCase().split(/(\s+)/).map((w) => (w.match(/^\s+$/) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join("");
}
function normaliseHmoProvider(raw: string): string {
  const t = raw.trim();
  if (!t) return "(unknown HMO)";
  const lower = t.toLowerCase();
  if (lower === "maxicare") return "Maxicare";
  if (lower === "intellicare") return "Intellicare";
  if (lower === "etiqa") return "Etiqa";
  if (lower === "cocolife") return "Cocolife";
  if (lower === "avega") return "Avega";
  if (lower === "valucare") return "Valucare";
  if (lower === "icare") return "iCare";
  if (lower === "generali") return "Generali";
  if (lower === "amaphil") return "Amaphil";
  if (lower === "med asia" || lower === "medasia") return "Med Asia";
  return titleCase(t);
}
function normaliseStatus(raw: string): "paid" | "pending" | "overdue" | "unknown" {
  const s = raw.trim().toUpperCase();
  if (s === "PAID") return "paid";
  if (s === "OVERDUE") return "overdue";
  if (s === "PENDING") return "pending";
  return "unknown";
}

// Cash channel: col O (LAB SERVICE) is the payment mode. Same mapping as DOC.
function cashChannelCoa(mop: string): string {
  const m = mop.trim().toUpperCase();
  if (m === "GCASH") return "1030";
  if (m === "BPI") return "1020";
  if (m === "BDO") return "1021";
  if (m === "CARD PAY") return "1020";
  return "1010";
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

interface RawRow {
  row_number: number;
  posting_date: string | null;
  control_no: string;
  test_no: string;
  patient_name: string;
  hmo_flag: string;
  hmo_provider: string;
  service: string;
  base: number;
  final: number;
  mop: string;             // col O
  hmo_billing_status: string;  // col S
  hmo_payment_status: string;  // col X
  or_number: string;       // col Y
  date_paid: string | null; // col Z
  deadline: string | null; // col U
  date_submitted: string | null; // col W
}

async function loadRows(xlsxPath: string): Promise<RawRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);
  const ws = wb.getWorksheet("LAB SERVICE");
  if (!ws) throw new Error(`LAB SERVICE sheet not found`);

  const out: RawRow[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rn) => {
    if (rn <= 2) return;
    const A = row.getCell(1).value;
    if (A == null || A === "") return;
    const postingDate = parseDate(A);
    out.push({
      row_number: rn,
      posting_date: postingDate,
      control_no: cellText(row.getCell(2).value).trim(),
      test_no: cellText(row.getCell(3).value).trim(),
      patient_name: cellText(row.getCell(4).value).trim(),
      hmo_flag: cellText(row.getCell(5).value).trim(),
      hmo_provider: cellText(row.getCell(6).value).trim(),
      service: cellText(row.getCell(8).value).trim(),
      base: fnum(row.getCell(9).value),
      final: fnum(row.getCell(14).value),
      mop: cellText(row.getCell(15).value).trim(),
      hmo_billing_status: cellText(row.getCell(19).value).trim(),
      hmo_payment_status: cellText(row.getCell(24).value).trim(),
      or_number: cellText(row.getCell(25).value).trim(),
      date_paid: parseDate(row.getCell(26).value),
      deadline: parseDate(row.getCell(21).value),
      date_submitted: parseDate(row.getCell(23).value),
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Classify
// ---------------------------------------------------------------------------

type RowClass = "cash_postable" | "hmo_postable" | "skip_zero_final" | "skip_hmo_zero" | "bad_date" | "bad_year";

interface ClassifiedRow {
  row: RawRow;
  rclass: RowClass;
  cash_account_code: string | null;
}

function classify(row: RawRow, year: number): RowClass {
  if (!row.posting_date) return "bad_date";
  if (row.posting_date.slice(0, 4) !== String(year)) return "bad_year";
  const isHmo = row.hmo_flag.trim().toUpperCase().includes("YES") || !!row.hmo_provider || row.mop.trim().toUpperCase() === "HMO";
  if (isHmo) {
    if (row.final > 0 || row.base > 0) return "hmo_postable";
    return "skip_hmo_zero";
  }
  if (row.final > 0) return "cash_postable";
  return "skip_zero_final";
}

function build(rows: RawRow[], year: number): ClassifiedRow[] {
  return rows.map((r) => {
    const rclass = classify(r, year);
    const cash_account_code = rclass === "cash_postable" ? cashChannelCoa(r.mop) : null;
    return { row: r, rclass, cash_account_code };
  });
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function summarise(year: number, classified: ClassifiedRow[]): void {
  const cashPost = classified.filter((x) => x.rclass === "cash_postable");
  const hmoPost = classified.filter((x) => x.rclass === "hmo_postable");
  const totalCashFinal = cashPost.reduce((s, x) => s + x.row.final, 0);
  const totalCashBase = cashPost.reduce((s, x) => s + x.row.base, 0);
  const totalHmoFinal = hmoPost.reduce((s, x) => s + x.row.final, 0);
  const totalHmoBase = hmoPost.reduce((s, x) => s + x.row.base, 0);

  console.log(`\n=== LAB SERVICE dry-run (year ${year}) ===`);
  console.log(`Cash postable:      ${cashPost.length.toString().padStart(5)}  base=₱${totalCashBase.toFixed(2)}  final=₱${totalCashFinal.toFixed(2)}  discount=₱${(totalCashBase - totalCashFinal).toFixed(2)}`);
  console.log(`HMO postable:       ${hmoPost.length.toString().padStart(5)}  base=₱${totalHmoBase.toFixed(2)}  final=₱${totalHmoFinal.toFixed(2)}  discount=₱${(totalHmoBase - totalHmoFinal).toFixed(2)}`);
  console.log(`Skip zero final:    ${classified.filter((x) => x.rclass === "skip_zero_final").length.toString().padStart(5)}`);
  console.log(`Skip HMO zero:      ${classified.filter((x) => x.rclass === "skip_hmo_zero").length.toString().padStart(5)}`);
  console.log(`Bad date:           ${classified.filter((x) => x.rclass === "bad_date").length.toString().padStart(5)}`);
  console.log(`Bad year (filtered):${classified.filter((x) => x.rclass === "bad_year").length.toString().padStart(5)}`);

  if (hmoPost.length > 0) {
    const byProvider = new Map<string, { n: number; total: number; paid: number; outstanding: number }>();
    for (const x of hmoPost) {
      const p = normaliseHmoProvider(x.row.hmo_provider);
      const cur = byProvider.get(p) ?? { n: 0, total: 0, paid: 0, outstanding: 0 };
      cur.n += 1;
      cur.total += x.row.final;
      const s = normaliseStatus(x.row.hmo_payment_status);
      if (s === "paid") cur.paid += x.row.final;
      else if (s === "pending" || s === "overdue") cur.outstanding += x.row.final;
      byProvider.set(p, cur);
    }
    console.log(`\nHMO by provider (final amount):`);
    for (const [p, v] of [...byProvider.entries()].sort((a, b) => b[1].total - a[1].total)) {
      console.log(`  ${v.n.toString().padStart(4)}  total=₱${v.total.toFixed(2).padStart(12)}  paid=₱${v.paid.toFixed(2).padStart(10)}  outstanding=₱${v.outstanding.toFixed(2).padStart(10)}  ${p}`);
    }
  }
}

async function writeExclusionCsv(year: number, classified: ClassifiedRow[]): Promise<string> {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.resolve("tmp");
  await fs.mkdir(dir, { recursive: true });
  const out = path.join(dir, `history-import-lab-${year}-exclusions-${ts}.csv`);
  const header = ["row_number", "posting_date", "class", "patient", "hmo_flag", "hmo_provider", "service", "base", "final", "mop", "hmo_payment_status"];
  const lines: string[][] = [header];
  for (const x of classified) {
    if (x.rclass === "cash_postable" || x.rclass === "hmo_postable" || x.rclass === "bad_year") continue;
    lines.push([
      String(x.row.row_number), x.row.posting_date ?? "(unparseable)", x.rclass,
      x.row.patient_name, x.row.hmo_flag, x.row.hmo_provider, x.row.service,
      x.row.base.toFixed(2), x.row.final.toFixed(2), x.row.mop, x.row.hmo_payment_status,
    ]);
  }
  const text = lines.map((row) => row.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\n");
  await fs.writeFile(out, text);
  return out;
}

// ---------------------------------------------------------------------------
// Idempotency — paginated by month (per-year may exceed 1000)
// ---------------------------------------------------------------------------

async function fetchExistingKeys(admin: SupabaseClient<Database>, year: number): Promise<Set<string>> {
  const keys = new Set<string>();
  // 12 monthly windows. Per-month rows are ~500-800; stays under 1000.
  for (let month = 1; month <= 12; month++) {
    const startDay = `${year}-${String(month).padStart(2, "0")}-01`;
    const next = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
    const endDay = new Date(new Date(next).getTime() - 86400_000).toISOString().slice(0, 10);
    const { data, error } = await admin
      .from("journal_entries")
      .select("notes")
      .eq("source_kind", "history_import" as never)
      .like("notes", "%xlsx LAB SERVICE r%")
      .gte("posting_date", startDay)
      .lte("posting_date", endDay);
    if (error) throw new Error(`fetchExistingKeys ${startDay}: ${error.message}`);
    if (data && data.length >= 1000) {
      throw new Error(`LAB SERVICE month ${startDay} returned ${data.length} ≥ 1000 — paginate finer.`);
    }
    for (const e of data ?? []) {
      const m = /xlsx LAB SERVICE r(\d+)/.exec(e.notes ?? "");
      if (m) keys.add(`r${m[1]}`);
    }
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

async function commit(year: number, classified: ClassifiedRow[]): Promise<void> {
  requireLocalOrExplicitProd("import:history:lab-services");
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
  for (const c of ["1010", "1020", "1021", "1030", "1110", "4100", "4910"]) {
    if (!codeToId.has(c)) { console.error(`ERROR: CoA missing ${c}`); process.exit(3); }
  }

  console.log(`Fetching idempotency keys (12 monthly windows)...`);
  const existingKeys = await fetchExistingKeys(admin, year);
  console.log(`  ${existingKeys.size} existing rows for ${year}.`);

  const cr4100 = codeToId.get("4100")!;
  const drDiscount = codeToId.get("4910")!;
  const drHmoAr = codeToId.get("1110")!;
  const runStamp = new Date().toISOString();

  const postable = classified.filter((x) => x.rclass === "cash_postable" || x.rclass === "hmo_postable");

  // Post JEs in chunks. We can't batch JEs (each needs je_next_number RPC),
  // but we can keep tight loop.
  let jePosted = 0, jeAlready = 0, jeFailed = 0;
  const hmoForSubledger: { row: RawRow; je_id: string | null }[] = [];

  for (const x of postable) {
    // Always queue HMO rows for subledger upsert, even if JE already posted.
    // The unique (source_tab, source_row) constraint prevents duplicates.
    if (existingKeys.has(`r${x.row.row_number}`)) {
      jeAlready++;
      if (x.rclass === "hmo_postable") hmoForSubledger.push({ row: x.row, je_id: null });
      continue;
    }

    const isHmo = x.rclass === "hmo_postable";
    // Use larger of base, final to satisfy contra-revenue sign + check constraints.
    const baseEff = round2(Math.max(x.row.base, x.row.final));
    const finalEff = round2(x.row.final > 0 ? x.row.final : x.row.base);
    const discount = round2(baseEff - finalEff);

    if (baseEff <= 0) { jeFailed++; console.error(`r${x.row.row_number}: base/final both zero or negative`); continue; }

    const fy = Number(x.row.posting_date!.slice(0, 4));
    const { data: nextNum, error: numErr } = await admin.rpc("je_next_number", { p_fiscal_year: fy });
    if (numErr || !nextNum) { console.error(`r${x.row.row_number}: je_next_number`, numErr); jeFailed++; continue; }

    const desc = `[history] Lab ${isHmo ? "HMO" : "cash"}: ${x.row.patient_name || "(unknown)"} / ${x.row.service || "(unknown)"}`.slice(0, 500);
    const notes = `imported_at=${runStamp} | xlsx LAB SERVICE r${x.row.row_number} | mop=${x.row.mop || "(blank)"} | control=${x.row.control_no} test=${x.row.test_no}`.slice(0, 2000);

    const { data: je, error: jeErr } = await admin
      .from("journal_entries")
      .insert({
        entry_number: nextNum,
        posting_date: x.row.posting_date!,
        description: desc,
        notes,
        status: "draft",
        source_kind: "history_import" as never,
        source_id: null,
      })
      .select("id")
      .single();
    if (jeErr || !je) { console.error(`r${x.row.row_number}: JE insert`, jeErr); jeFailed++; continue; }

    const drMainId = isHmo ? drHmoAr : codeToId.get(x.cash_account_code!)!;
    const lineDesc = `${x.row.patient_name} | ${x.row.service}`.slice(0, 500);
    const lineRows: { entry_id: string; account_id: string; debit_php: number; credit_php: number; description: string; line_order: number }[] = [
      { entry_id: je.id, account_id: drMainId, debit_php: finalEff, credit_php: 0, description: lineDesc, line_order: 1 },
    ];
    if (discount > 0) {
      lineRows.push({ entry_id: je.id, account_id: drDiscount, debit_php: discount, credit_php: 0, description: `Lab discount (${x.row.service})`, line_order: 2 });
    }
    lineRows.push({ entry_id: je.id, account_id: cr4100, debit_php: 0, credit_php: baseEff, description: lineDesc, line_order: lineRows.length + 1 });

    const { error: lErr } = await admin.from("journal_lines").insert(lineRows);
    if (lErr) {
      console.error(`r${x.row.row_number}: lines insert (rolling back JE):`, lErr);
      await admin.from("journal_entries").delete().eq("id", je.id);
      jeFailed++; continue;
    }
    const { error: pErr } = await admin
      .from("journal_entries")
      .update({ status: "posted", posted_at: new Date().toISOString() })
      .eq("id", je.id);
    if (pErr) { console.error(`r${x.row.row_number}: post flip`, pErr); jeFailed++; continue; }
    jePosted++;
    if (isHmo) hmoForSubledger.push({ row: x.row, je_id: je.id });
    if (jePosted % 200 === 0) process.stdout.write(`\r  JEs ${jePosted}/${postable.length}`);
  }
  process.stdout.write("\n");

  // HMO subledger upserts (one-by-one to survive per-row constraint failures
  // without losing the whole batch — historic data has occasional dirty rows).
  let hmoPosted = 0, hmoAlready = 0, hmoFailed = 0;
  if (hmoForSubledger.length > 0) {
    const bulk = hmoForSubledger.map(({ row, je_id }) => {
      const baseEff = round2(Math.max(row.base, row.final));
      const finalEff = round2(row.final > 0 ? row.final : row.base);
      const status = normaliseStatus(row.hmo_payment_status);
      return {
        hmo_provider: normaliseHmoProvider(row.hmo_provider),
        patient_name: row.patient_name || "(unknown)",
        claim_date: row.posting_date!,
        service_description: row.service || null,
        base_amount_php: baseEff,
        final_amount_php: finalEff,
        status,
        date_submitted: row.date_submitted,
        deadline_date: row.deadline,
        date_paid: status === "paid" ? row.date_paid : null,
        or_number: row.or_number || null,
        source_tab: "LAB SERVICE",
        source_row: row.row_number,
        journal_entry_id: je_id,
        notes: `imported_at=${runStamp} | mop=${row.mop} | billing_status=${row.hmo_billing_status}`,
      };
    });
    // First try big batch; on per-row constraint errors, fall back to one-by-one.
    const BATCH = 100;
    let batchFailedRows = 0;
    const failedRowsForRetry: typeof bulk = [];
    for (let i = 0; i < bulk.length; i += BATCH) {
      const slice = bulk.slice(i, i + BATCH);
      const { error, count } = await admin
        .from("historic_hmo_claims" as never)
        .upsert(slice as never, { onConflict: "source_tab,source_row", ignoreDuplicates: true, count: "exact" });
      if (error) {
        // Batch died on one bad row — queue all for retry one-by-one.
        failedRowsForRetry.push(...slice);
        batchFailedRows += slice.length;
      } else {
        hmoPosted += count ?? slice.length;
      }
    }
    if (failedRowsForRetry.length > 0) {
      console.log(`  ${batchFailedRows} rows fell through batch insert; retrying one-by-one...`);
      for (const row of failedRowsForRetry) {
        const { error, count } = await admin
          .from("historic_hmo_claims" as never)
          .upsert([row] as never, { onConflict: "source_tab,source_row", ignoreDuplicates: true, count: "exact" });
        if (error) {
          hmoFailed++;
          if (hmoFailed <= 5) console.error(`  r${row.source_row}: ${error.message}`);
        } else {
          hmoPosted += count ?? 1;
        }
      }
    }
    hmoAlready = bulk.length - hmoPosted - hmoFailed;
    process.stdout.write("\n");
  }

  console.log(`\nCommit complete:`);
  console.log(`  JEs:               posted=${jePosted}  already=${jeAlready}  failed=${jeFailed}`);
  console.log(`  HMO subledger:     posted=${hmoPosted}  already=${hmoAlready}  failed=${hmoFailed}`);
}

async function main() {
  const args = parseArgs();
  console.log(`Reading: ${args.xlsx}`);
  const rows = await loadRows(args.xlsx);
  console.log(`LAB SERVICE rows read: ${rows.length}`);
  const classified = build(rows, args.year);
  summarise(args.year, classified);

  const exclusionsPath = await writeExclusionCsv(args.year, classified);
  console.log(`\nExclusion CSV: ${exclusionsPath}`);

  if (!args.commit) {
    console.log(`\nDry-run. To commit on dev:\n  npm run import:history:lab-services -- --year=${args.year} --commit --confirm="I-mean-it"\n`);
    return;
  }
  if (!args.confirmed) {
    console.error('\nERROR: --commit requires --confirm="I-mean-it".');
    process.exit(3);
  }
  await commit(args.year, classified);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
