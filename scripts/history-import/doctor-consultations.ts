/**
 * 12.B history import — DOCTOR CONSULTATION tab.
 *
 *   npm run import:history:doctor-cons -- --year=2023                          # dry-run
 *   npm run import:history:doctor-cons -- --year=2023 --commit --confirm="I-mean-it"
 *
 * NET revenue model: the clinic recognises only CLINIC FEE (col M) as revenue.
 * Doctor PF (col Q — mislabeled "DISCOUNTS AMOUNT" in the xlsx) passed through
 * clinic cash same-day to the doctor and was never booked as an expense. This
 * matches the partner's existing Income Statement Monthly tabs.
 *
 * Row classes & treatment:
 *
 *   Cash-style with M > 0 (~1,680 rows):
 *     One JE per row.
 *       DR <cash channel from col N> (M)
 *       CR 4200 Doctor Consultation Revenue (M)
 *
 *   Cash-style with M = 0 (~4,519 rows):
 *     Skip JE. Clinic earned nothing — the entire cash flow was passthrough to
 *     the doctor. Logged to exclusion CSV.
 *
 *   HMO with amounts (88 rows, "Model B" — clinic-billed via Veritas):
 *     No GL JE (clinic earned ₱0 on HMO consults — M = 0 across all years).
 *     Insert historic_hmo_claims row for the audit lens.
 *
 *   HMO with zero amounts (1,707 rows, "Model A" — doctor-direct billing):
 *     No GL JE, no subledger. Logged to exclusion CSV. The doctor billed HMO
 *     directly; clinic never touched the money.
 *
 *   Bad date (5 rows): skip + log.
 *
 * Idempotency:
 *   - JEs: source_kind='history_import' + notes contains 'xlsx DOCTOR CONSULTATION r{N}'.
 *   - historic_hmo_claims: unique (source_tab, source_row) — ON CONFLICT DO NOTHING.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../../src/types/database";
import { requireLocalOrExplicitProd } from "../lib/env-guard";

const XLSX_PATH_DEFAULT = `${process.env.HOME ?? ""}/Downloads/DR MED MASTERSHEET.xlsx`;

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function parseDate(raw: ExcelJS.CellValue): string | null {
  if (raw == null) return null;
  if (typeof raw === "number") return excelSerialToISO(raw);
  if (raw instanceof Date) return raw.toISOString().slice(0, 10);
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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/(\s+)/)
    .map((w) => (w.match(/^\s+$/) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join("");
}

function normaliseHmoProvider(raw: string): string {
  const t = raw.trim();
  if (!t) return "(unknown HMO)";
  // Common variants
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

const STATUS_MAP: Record<string, "paid" | "pending" | "overdue" | "unknown"> = {
  PAID: "paid",
  OVERDUE: "overdue",
  PENDING: "pending",
};
function normaliseStatus(raw: string): "paid" | "pending" | "overdue" | "unknown" {
  return STATUS_MAP[raw.trim().toUpperCase()] ?? "unknown";
}

// Map column N (payment mode) → cash channel CoA code under NET model.
// All "non-HMO" modes (cash, gcash, bpi, bdo, card pay, special bundles, OK,
// pre-employment) route to a cash account; the clinic's clinic_fee landed
// there.
function cashChannelCoa(mop: string): string {
  const m = mop.trim().toUpperCase();
  if (m === "GCASH") return "1030";       // GCash Wallet
  if (m === "BPI") return "1020";         // BPI
  if (m === "BDO") return "1021";         // BDO
  if (m === "CARD PAY") return "1020";    // BPI (default merchant deposit)
  // CASH, blank, OK, PRE EMPLOYMENT, PRE- EMPLOYMENT, COMPRE EXEC,
  // STANDARD EXEC, TOTAL HEALTH, CAD, and anything else → 1010 Cash on Hand
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
  clinic_fee: number;
  doctor_pf: number;
  mop: string;
  status_v: string;
  deadline: string | null;
  date_submitted: string | null;
  or_number: string;
}

async function loadRows(xlsxPath: string): Promise<RawRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);
  const ws = wb.getWorksheet("DOCTOR CONSULTATION");
  if (!ws) throw new Error(`DOCTOR CONSULTATION sheet not found`);

  const out: RawRow[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rn) => {
    if (rn <= 2) return; // row 1 main header, row 2 sub-header
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
      final: fnum(row.getCell(12).value),
      clinic_fee: fnum(row.getCell(13).value),
      doctor_pf: fnum(row.getCell(17).value),
      mop: cellText(row.getCell(14).value).trim(),
      status_v: cellText(row.getCell(22).value).trim(),
      deadline: parseDate(row.getCell(20).value),
      date_submitted: parseDate(row.getCell(21).value),
      or_number: cellText(row.getCell(23).value).trim(),
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Classify + build
// ---------------------------------------------------------------------------

type RowClass =
  | "cash_postable"        // M > 0, post JE
  | "cash_skip_m_zero"     // M = 0, skip + log
  | "hmo_model_b"          // HMO with amounts: subledger only, no JE
  | "hmo_model_a"          // HMO zero amounts: skip + log
  | "bad_date"             // unparseable date
  | "bad_year";            // not the requested year

interface ClassifiedRow {
  row: RawRow;
  rclass: RowClass;
  cash_account_code: string | null; // cash channel for cash_postable rows
}

function classify(row: RawRow, year: number): RowClass {
  if (!row.posting_date) return "bad_date";
  if (row.posting_date.slice(0, 4) !== String(year)) return "bad_year";
  const isHmo = row.hmo_flag.trim().toUpperCase().includes("YES") || !!row.hmo_provider;
  if (isHmo) {
    if (row.base > 0 || row.final > 0 || row.clinic_fee > 0 || row.doctor_pf > 0) {
      return "hmo_model_b";
    }
    return "hmo_model_a";
  }
  if (row.clinic_fee > 0) return "cash_postable";
  return "cash_skip_m_zero";
}

function build(rows: RawRow[], year: number): ClassifiedRow[] {
  return rows.map((r) => {
    const rclass = classify(r, year);
    const cash_account_code = rclass === "cash_postable" ? cashChannelCoa(r.mop) : null;
    return { row: r, rclass, cash_account_code };
  });
}

// ---------------------------------------------------------------------------
// Summary + CSVs
// ---------------------------------------------------------------------------

function summarise(year: number, classified: ClassifiedRow[]): void {
  const c = (k: RowClass) => classified.filter((x) => x.rclass === k);
  const cashPost = c("cash_postable");
  const totalM = cashPost.reduce((s, x) => s + x.row.clinic_fee, 0);
  const hmoB = c("hmo_model_b");
  const totalHmoFinal = hmoB.reduce((s, x) => s + x.row.final, 0);
  console.log(`\n=== DOCTOR CONSULTATION dry-run (year ${year}) ===`);
  console.log(`Cash postable (M > 0):     ${cashPost.length.toString().padStart(5)}  → DR cash / CR 4200   ₱${totalM.toFixed(2)}`);
  console.log(`Cash skip (M = 0):         ${c("cash_skip_m_zero").length.toString().padStart(5)}  → exclusion CSV`);
  console.log(`HMO Model B (amounts):     ${hmoB.length.toString().padStart(5)}  → historic_hmo_claims only  AR ₱${totalHmoFinal.toFixed(2)}`);
  console.log(`HMO Model A (doctor-direct):${c("hmo_model_a").length.toString().padStart(5)}  → exclusion CSV`);
  console.log(`Bad date:                  ${c("bad_date").length.toString().padStart(5)}  → exclusion CSV`);
  console.log(`Bad year (not ${year}):     ${c("bad_year").length.toString().padStart(5)}  → filtered out (silent)`);

  if (cashPost.length > 0) {
    const byChannel = new Map<string, { n: number; total: number }>();
    for (const x of cashPost) {
      const k = x.cash_account_code ?? "?";
      const cur = byChannel.get(k) ?? { n: 0, total: 0 };
      cur.n += 1;
      cur.total += x.row.clinic_fee;
      byChannel.set(k, cur);
    }
    console.log(`\nCash postable by channel:`);
    for (const [k, v] of [...byChannel.entries()].sort()) {
      console.log(`  ${k}  ${v.n.toString().padStart(5)} rows  ₱${v.total.toFixed(2).padStart(12)}`);
    }
  }
  if (hmoB.length > 0) {
    const byProvider = new Map<string, { n: number; total: number; paid: number; pending: number; overdue: number }>();
    for (const x of hmoB) {
      const p = normaliseHmoProvider(x.row.hmo_provider);
      const cur = byProvider.get(p) ?? { n: 0, total: 0, paid: 0, pending: 0, overdue: 0 };
      cur.n += 1;
      cur.total += x.row.final;
      const s = normaliseStatus(x.row.status_v);
      if (s === "paid") cur.paid += 1;
      else if (s === "pending") cur.pending += 1;
      else if (s === "overdue") cur.overdue += 1;
      byProvider.set(p, cur);
    }
    console.log(`\nHMO Model B by provider:`);
    for (const [p, v] of [...byProvider.entries()].sort()) {
      console.log(`  ${v.n.toString().padStart(3)}  ₱${v.total.toFixed(2).padStart(12)}  paid=${v.paid} pending=${v.pending} overdue=${v.overdue}  ${p}`);
    }
  }
}

async function writeExclusionCsv(year: number, classified: ClassifiedRow[]): Promise<string> {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.resolve("tmp");
  await fs.mkdir(dir, { recursive: true });
  const out = path.join(dir, `history-import-doctor-cons-${year}-exclusions-${ts}.csv`);
  const header = ["row_number", "posting_date", "class", "patient", "hmo_flag", "hmo_provider", "service", "base", "final", "clinic_fee", "doctor_pf", "mop", "status_v"];
  const lines: string[][] = [header];
  for (const x of classified) {
    if (x.rclass === "cash_postable" || x.rclass === "hmo_model_b" || x.rclass === "bad_year") continue;
    lines.push([
      String(x.row.row_number),
      x.row.posting_date ?? "(unparseable)",
      x.rclass,
      x.row.patient_name,
      x.row.hmo_flag,
      x.row.hmo_provider,
      x.row.service,
      x.row.base.toFixed(2),
      x.row.final.toFixed(2),
      x.row.clinic_fee.toFixed(2),
      x.row.doctor_pf.toFixed(2),
      x.row.mop,
      x.row.status_v,
    ]);
  }
  const text = lines.map((row) => row.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\n");
  await fs.writeFile(out, text);
  return out;
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

async function commit(year: number, classified: ClassifiedRow[]): Promise<void> {
  requireLocalOrExplicitProd("import:history:doctor-cons");
  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error("ERROR: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required.");
    process.exit(2);
  }
  const admin = createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1. CoA codes → uuid.
  const { data: accounts, error: aErr } = await admin.from("chart_of_accounts").select("id, code");
  if (aErr || !accounts) { console.error("ERROR fetching CoA:", aErr); process.exit(3); }
  const codeToId = new Map(accounts.map((a) => [a.code, a.id]));
  for (const c of ["1010", "1020", "1021", "1030", "4200"]) {
    if (!codeToId.has(c)) { console.error(`ERROR: CoA missing ${c}`); process.exit(3); }
  }

  // 2. JE idempotency.
  const { data: existing, error: eErr } = await admin
    .from("journal_entries")
    .select("notes")
    .eq("source_kind", "history_import" as never)
    .like("notes", "%xlsx DOCTOR CONSULTATION r%")
    .gte("posting_date", `${year}-01-01`)
    .lte("posting_date", `${year}-12-31`);
  if (eErr) { console.error("ERROR fetching JEs:", eErr); process.exit(3); }
  if (existing && existing.length >= 1000) {
    console.error(`Aborting: DOC CONS idempotency fetch ≥1000 — paginate.`); process.exit(3);
  }
  const existingKeys = new Set<string>();
  for (const e of existing ?? []) {
    const m = /xlsx DOCTOR CONSULTATION r(\d+)/.exec(e.notes ?? "");
    if (m) existingKeys.add(`r${m[1]}`);
  }

  const cr4200 = codeToId.get("4200")!;
  const runStamp = new Date().toISOString();

  const cashPost = classified.filter((x) => x.rclass === "cash_postable");
  const hmoB = classified.filter((x) => x.rclass === "hmo_model_b");
  // Model A: doctor-direct HMO consults with zero amounts. No GL JE (clinic
  // earned nothing) but inserted into historic_hmo_claims with amount=0,
  // status='unknown' so the audit shows the count of doctor-direct claims.
  const hmoA = classified.filter((x) => x.rclass === "hmo_model_a");

  // 3A. Post cash-style JEs (DR cash channel / CR 4200) — clinic fee only.
  let jePosted = 0, jeAlready = 0, jeFailed = 0;
  for (const x of cashPost) {
    if (existingKeys.has(`r${x.row.row_number}`)) { jeAlready++; continue; }
    const drId = codeToId.get(x.cash_account_code!);
    if (!drId) { console.error(`r${x.row.row_number}: missing cash channel ${x.cash_account_code}`); jeFailed++; continue; }

    const amt = round2(x.row.clinic_fee);
    const fy = Number(x.row.posting_date!.slice(0, 4));
    const { data: nextNum, error: numErr } = await admin.rpc("je_next_number", { p_fiscal_year: fy });
    if (numErr || !nextNum) { console.error(`r${x.row.row_number}: je_next_number`, numErr); jeFailed++; continue; }

    const desc = `[history] Consult clinic fee: ${x.row.patient_name || "(unknown)"} / ${x.row.service || "(unknown)"}`.slice(0, 500);
    const notes = `imported_at=${runStamp} | xlsx DOCTOR CONSULTATION r${x.row.row_number} | mop=${x.row.mop || "(blank)"} | control=${x.row.control_no}`.slice(0, 2000);

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

    const lineDesc = `${x.row.patient_name} | ${x.row.service}`.slice(0, 500);
    const { error: lErr } = await admin.from("journal_lines").insert([
      { entry_id: je.id, account_id: drId, debit_php: amt, credit_php: 0, description: lineDesc, line_order: 1 },
      { entry_id: je.id, account_id: cr4200, debit_php: 0, credit_php: amt, description: lineDesc, line_order: 2 },
    ]);
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
    if (jePosted % 100 === 0) process.stdout.write(`\r  JEs ${jePosted}/${cashPost.length}`);
  }
  if (cashPost.length > 0) process.stdout.write("\n");

  // 3B. Insert historic_hmo_claims for HMO Model B (no GL JE) AND Model A
  // (doctor-direct, zero amounts, status='unknown' for audit visibility).
  // Unique (source_tab, source_row) — ON CONFLICT DO NOTHING gives idempotency.
  let hmoPosted = 0, hmoAlready = 0, hmoFailed = 0;
  const bulkInserts = [...hmoB, ...hmoA].map((x) => {
    const isModelA = x.rclass === "hmo_model_a";
    // Model B: xlsx sometimes has FINAL filled but BASE blank — use max() as
    // effective base to satisfy `final <= base` check.
    // Model A: all amounts are 0 by construction.
    const baseEff = isModelA ? 0 : round2(Math.max(x.row.base, x.row.final));
    const finalEff = isModelA ? 0 : round2(x.row.final > 0 ? x.row.final : x.row.base);
    return ({
      hmo_provider: normaliseHmoProvider(x.row.hmo_provider),
      patient_name: x.row.patient_name || "(unknown)",
      claim_date: x.row.posting_date!,
      service_description: x.row.service || null,
      base_amount_php: baseEff,
      final_amount_php: finalEff,
      // Model A: 'unknown' (no clinic involvement). Model B: from xlsx status.
      status: isModelA ? ("unknown" as const) : normaliseStatus(x.row.status_v),
      date_submitted: x.row.date_submitted,
      deadline_date: x.row.deadline,
      date_paid: null,
      or_number: x.row.or_number || null,
      source_tab: "DOCTOR CONSULTATION",
      source_row: x.row.row_number,
      journal_entry_id: null,
      notes: `imported_at=${runStamp} | mop=${x.row.mop} | model=${isModelA ? "A doctor-direct" : "B clinic-billed"} | doctor_pf=${x.row.doctor_pf} | clinic_fee=${x.row.clinic_fee}`,
    });
  });

  // PostgREST: use upsert with onConflict for ON CONFLICT DO NOTHING semantics.
  // Without ignoreDuplicates: the existing row is updated; with it (default false in v2), they're skipped silently.
  if (bulkInserts.length > 0) {
    const BATCH = 100;
    for (let i = 0; i < bulkInserts.length; i += BATCH) {
      const slice = bulkInserts.slice(i, i + BATCH);
      const { error, count } = await admin
        .from("historic_hmo_claims" as never)
        .upsert(slice as never, { onConflict: "source_tab,source_row", ignoreDuplicates: true, count: "exact" });
      if (error) {
        console.error(`HMO batch ${i}-${i + slice.length} failed:`, error);
        hmoFailed += slice.length;
      } else {
        hmoPosted += count ?? slice.length;
      }
    }
    hmoAlready = bulkInserts.length - hmoPosted - hmoFailed;
  }

  console.log(`\nCommit complete:`);
  console.log(`  JE cash-style:    posted=${jePosted}  already=${jeAlready}  failed=${jeFailed}`);
  console.log(`  HMO subledger:    posted=${hmoPosted}  already=${hmoAlready}  failed=${hmoFailed}`);
  console.log(`\nRollback (dev only):`);
  console.log(`  -- JEs: same draft-then-delete pattern as expenses.ts`);
  console.log(`  -- HMO subledger: delete from historic_hmo_claims where source_tab='DOCTOR CONSULTATION' and source_row in (...);`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs();
  console.log(`Reading: ${args.xlsx}`);
  const rows = await loadRows(args.xlsx);
  console.log(`DOCTOR CONSULTATION rows read: ${rows.length}`);

  const classified = build(rows, args.year);
  summarise(args.year, classified);

  const exclusionsPath = await writeExclusionCsv(args.year, classified);
  console.log(`\nExclusion CSV: ${exclusionsPath}`);

  if (!args.commit) {
    console.log(`\nDry-run. To commit on dev:\n  npm run import:history:doctor-cons -- --year=${args.year} --commit --confirm="I-mean-it"\n`);
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
