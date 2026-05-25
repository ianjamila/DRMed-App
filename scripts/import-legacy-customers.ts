// scripts/import-legacy-customers.ts
//
// Reads CUSTOMER LIST CSV, parses every row, produces a pre-flight report
// in dry-run mode. Commit mode (Task 8) inserts with provenance.
//
//   npm run import:legacy -- --csv="$HOME/Downloads/CUSTOMER LIST - CUSTOMER LIST2.csv"
//   npm run import:legacy -- --csv=... --commit --confirm="I-mean-it"

import { promises as fs } from "node:fs";
import { parse } from "csv-parse/sync";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/types/database";

import { parseName } from "../src/lib/legacy-import/name-parser";
import { normalizePhone } from "../src/lib/legacy-import/phone-normalizer";
import {
  mapReferralSource,
  mapReleaseMedium,
  mapSeniorPwdKind,
  mapSex,
  parseBirthdate,
} from "../src/lib/legacy-import/vocabulary-mapper";
import type {
  ImportWarning,
  LegacyIntakePayload,
  ParsedRow,
} from "../src/lib/legacy-import/types";

interface Args {
  csv: string;
  commit: boolean;
  confirmed: boolean;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const csv = args.find((a) => a.startsWith("--csv="))?.substring(6);
  if (!csv) {
    console.error("ERROR: --csv=<path> is required");
    process.exit(2);
  }
  const commit = args.includes("--commit");
  const confirmFlag = args.find((a) => a.startsWith("--confirm="));
  const confirmed =
    confirmFlag === '--confirm="I-mean-it"' ||
    confirmFlag === "--confirm=I-mean-it";
  return { csv, commit, confirmed };
}

/**
 * Pre-normalize DOB strings from the sheet into a format parseBirthdate
 * understands (M/D/YYYY or YYYY-MM-DD).
 *
 * The sheet stores dates in Google Sheets' default display format:
 *   D-Mon-YYYY  e.g. "15-Jul-1966", "8-Jan-2021"
 * as well as ad-hoc strings like "SEPT 10,2013", "February 26,2019".
 * parseBirthdate only handles M/D/YYYY and ISO; this shim bridges the gap.
 */
const MONTH_MAP: Record<string, string> = {
  jan: "1", feb: "2", mar: "3", apr: "4", may: "5", jun: "6",
  jul: "7", aug: "8", sep: "9", oct: "10", nov: "11", dec: "12",
};

function normalizeDobRaw(raw: string | undefined | null): string {
  const text = (raw ?? "").trim();
  if (!text) return text;

  // Already ISO or M/D/YYYY — pass through
  if (/^\d{4}-\d{2}-\d{2}$/.test(text) || /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(text)) {
    return text;
  }

  // D-Mon-YYYY  e.g. "15-Jul-1966"
  const dmyHyphen = /^(\d{1,2})-([A-Za-z]{3,})-(\d{4})$/.exec(text);
  if (dmyHyphen) {
    const m = MONTH_MAP[dmyHyphen[2].toLowerCase().slice(0, 3)];
    if (m) return `${m}/${dmyHyphen[1]}/${dmyHyphen[3]}`;
  }

  // MM-DD-YYYY with hyphens (no month abbreviation)  e.g. "08-15-1948"
  const mmddyyyy = /^(\d{2})-(\d{2})-(\d{4})$/.exec(text);
  if (mmddyyyy) {
    return `${mmddyyyy[1]}/${mmddyyyy[2]}/${mmddyyyy[3]}`;
  }

  // "Month D,YYYY" or "Month D, YYYY"  e.g. "February 26,2019", "SEPT 10,2013"
  const longMonth = /^([A-Za-z]+\.?)\s+(\d{1,2}),?\s*(\d{4})$/.exec(text);
  if (longMonth) {
    const m = MONTH_MAP[longMonth[1].toLowerCase().replace(/\.$/, "").slice(0, 3)];
    if (m) return `${m}/${longMonth[2]}/${longMonth[3]}`;
  }

  // Can't normalize — return as-is and let parseBirthdate flag it
  return text;
}

interface RowParseResult {
  parsed: ParsedRow | null;
  reason_skipped?: string;
}

function parseRow(
  raw: Record<string, string>,
  rowIndex: number,
): RowParseResult {
  // Use the exact column names from the sheet (some have trailing spaces)
  const fullName = raw["Full Name"];
  const lastName = raw["Last Name"];
  const firstName = raw["First Name"];

  if (!fullName?.trim() && !lastName?.trim() && !firstName?.trim()) {
    return { parsed: null, reason_skipped: "empty_name" };
  }

  const warnings: ImportWarning[] = [];

  const name = parseName(fullName, lastName, firstName, raw["M.I."]);
  if (name.unparseable) warnings.push("name_unparseable");

  const dob = parseBirthdate(normalizeDobRaw(raw["Date of Birth"]));
  if (dob.unparseable) warnings.push("dob_unparseable");
  else if (!dob.iso) warnings.push("dob_missing");

  const phone = normalizePhone(raw["Contact Number"]);
  if (phone.unparseable) warnings.push("phone_unparseable");

  const sex = mapSex(raw["Gender"]);
  if (!sex && (raw["Gender"]?.trim() ?? "")) warnings.push("sex_unparseable");

  const ref = mapReferralSource(raw["How did you know about DR Med?"]);
  if (ref.unmapped_raw !== undefined && ref.unmapped_raw !== "") {
    warnings.push({ kind: "referral_source_unmapped", raw: ref.unmapped_raw });
  }

  const rel = mapReleaseMedium(raw["Preferred Medium of Result Release"]);
  if (rel.unmapped_raw) {
    warnings.push({ kind: "release_medium_unmapped", raw: rel.unmapped_raw });
  }

  const pwdKind = mapSeniorPwdKind(raw["Senior / PWD ID"]);
  const pwdNumber = raw["Senior / PWD ID Number"]?.trim() || null;
  let final_pwd_kind: "senior" | "pwd" | null = null;
  let final_pwd_number: string | null = null;
  if (pwdKind && pwdNumber) {
    final_pwd_kind = pwdKind;
    final_pwd_number = pwdNumber;
  } else if (pwdKind || pwdNumber) {
    warnings.push("senior_pwd_id_missing");
  }

  // Address columns have trailing spaces in the header
  const addrStreet = raw["Address (#, Street Name) "] ?? raw["Address (#, Street Name)"] ?? "";
  const addrBarangay = raw["Address (Barangay) "] ?? raw["Address (Barangay)"] ?? "";
  const addrCity = raw["Address (City) "] ?? raw["Address (City)"] ?? "";

  const addr = [addrStreet, addrBarangay, addrCity]
    .map((x) => x?.trim() ?? "")
    .filter(Boolean)
    .join(", ")
    .replace(/\s+/g, " ")
    .replace(/(,\s*)+$/g, "");

  const email = raw["Email address"]?.trim().toLowerCase() || null;

  const intake: LegacyIntakePayload = {
    source: "google_sheet_CUSTOMER_LIST2",
    imported_at: new Date().toISOString(),
    original_row_index: rowIndex,
    raw,
    import_warnings: warnings,
  };

  return {
    parsed: {
      first_name: name.first_name,
      last_name: name.last_name,
      middle_name: name.middle_name,
      birthdate: dob.iso,
      sex,
      phone: phone.e164,
      email: email || null,
      address: addr || null,
      referral_source: ref.id,
      referred_by_doctor: raw["Doctor"]?.trim() || null,
      preferred_release_medium: rel.id,
      senior_pwd_id_kind: final_pwd_kind,
      senior_pwd_id_number: final_pwd_number,
      legacy_intake: intake,
    },
  };
}

interface PreflightStats {
  rows_total: number;
  rows_parsed: number;
  rows_skipped: number;
  skip_reasons: Record<string, number>;
  warnings: Record<string, number>;
  dob_present: number;
  phone_present: number;
  email_present: number;
  top_referring_doctors: Array<{ name: string; count: number }>;
}

function computeStats(
  parsed: ParsedRow[],
  skips: Record<string, number>,
  total: number,
): PreflightStats {
  const warnings: Record<string, number> = {};
  const doctors: Record<string, number> = {};
  let dob = 0,
    phone = 0,
    email = 0;
  for (const r of parsed) {
    if (r.birthdate) dob++;
    if (r.phone) phone++;
    if (r.email) email++;
    if (r.referred_by_doctor)
      doctors[r.referred_by_doctor] =
        (doctors[r.referred_by_doctor] ?? 0) + 1;
    for (const w of r.legacy_intake.import_warnings) {
      const key = typeof w === "string" ? w : w.kind;
      warnings[key] = (warnings[key] ?? 0) + 1;
    }
  }
  const topDocs = Object.entries(doctors)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 30);
  return {
    rows_total: total,
    rows_parsed: parsed.length,
    rows_skipped: total - parsed.length,
    skip_reasons: skips,
    warnings,
    dob_present: dob,
    phone_present: phone,
    email_present: email,
    top_referring_doctors: topDocs,
  };
}

function pct(n: number, total: number): string {
  if (!total) return "0%";
  return `${Math.round((n / total) * 100)}%`;
}

function printStats(s: PreflightStats): void {
  console.log("\n=== Pre-flight report ===");
  console.log(`Total rows in sheet:    ${s.rows_total}`);
  console.log(`Parsed:                 ${s.rows_parsed}`);
  console.log(`Skipped:                ${s.rows_skipped}`);
  for (const [reason, n] of Object.entries(s.skip_reasons)) {
    console.log(`  - ${reason.padEnd(30)} ${n}`);
  }
  console.log(
    `\nDOB present:            ${s.dob_present} (${pct(s.dob_present, s.rows_parsed)})`,
  );
  console.log(
    `Phone present:          ${s.phone_present} (${pct(s.phone_present, s.rows_parsed)})`,
  );
  console.log(
    `Email present:          ${s.email_present} (${pct(s.email_present, s.rows_parsed)})`,
  );
  console.log("\nWarnings raised:");
  for (const [k, n] of Object.entries(s.warnings).sort(
    ([, a], [, b]) => b - a,
  )) {
    console.log(`  - ${k.padEnd(36)} ${n}`);
  }
  console.log("\nTop 30 referring physicians:");
  for (const d of s.top_referring_doctors) {
    console.log(`  ${String(d.count).padStart(4)}  ${d.name}`);
  }
  console.log();
}

async function writePreflightCsv(
  parsed: ParsedRow[],
  path: string,
): Promise<void> {
  const header = [
    "row_index",
    "last_name",
    "first_name",
    "middle_name",
    "birthdate",
    "sex",
    "phone",
    "email",
    "address",
    "referral_source",
    "referred_by_doctor",
    "preferred_release_medium",
    "senior_pwd_id_kind",
    "senior_pwd_id_number",
    "warnings",
  ];
  const rows = parsed.map((r) => [
    r.legacy_intake.original_row_index,
    r.last_name ?? "",
    r.first_name ?? "",
    r.middle_name ?? "",
    r.birthdate ?? "",
    r.sex ?? "",
    r.phone ?? "",
    r.email ?? "",
    r.address?.replace(/[\n,]/g, " ") ?? "",
    r.referral_source ?? "",
    r.referred_by_doctor?.replace(/[\n,]/g, " ") ?? "",
    r.preferred_release_medium ?? "",
    r.senior_pwd_id_kind ?? "",
    r.senior_pwd_id_number ?? "",
    r.legacy_intake.import_warnings
      .map((w) =>
        typeof w === "string" ? w : `${w.kind}:${w.raw}`,
      )
      .join("; "),
  ]);
  const text = [header, ...rows]
    .map((row) =>
      row
        .map((cell) => `"${String(cell).replace(/"/g, '""')}"`)
        .join(","),
    )
    .join("\n");
  await fs.writeFile(path, text);
  console.log(`Pre-flight CSV written: ${path}`);
}

async function main() {
  const args = parseArgs();
  const text = await fs.readFile(args.csv, "utf-8");
  const records = parse(text, {
    columns: true,
    skip_empty_lines: true,
  }) as Record<string, string>[];

  const parsed: ParsedRow[] = [];
  const skips: Record<string, number> = {};
  records.forEach((row, i) => {
    // csv-parse strips the header row; data row 1 of the array is sheet row 2.
    const rowIndex = i + 2;
    const r = parseRow(row, rowIndex);
    if (r.parsed) parsed.push(r.parsed);
    else {
      const reason = r.reason_skipped ?? "unknown";
      skips[reason] = (skips[reason] ?? 0) + 1;
    }
  });

  const stats = computeStats(parsed, skips, records.length);
  printStats(stats);

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = `tmp/legacy-import-preflight-${ts}.csv`;
  await fs.mkdir("tmp", { recursive: true });
  await writePreflightCsv(parsed, reportPath);

  if (!args.commit) {
    console.log(
      '\nDry-run complete. Review the preflight CSV, then re-run with --commit --confirm="I-mean-it".\n',
    );
    return;
  }

  if (!args.confirmed) {
    console.error(
      '\nERROR: --commit requires --confirm="I-mean-it" exactly.',
    );
    process.exit(3);
  }

  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("ERROR: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
    process.exit(2);
  }

  const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 1. Insert the run row.
  const { data: runRow, error: runErr } = await supabase
    .from("legacy_import_runs")
    .insert({
      source: "google_sheet_CUSTOMER_LIST2",
      dry_run: false,
      rows_in: records.length,
    })
    .select("id")
    .single();
  if (runErr || !runRow) {
    console.error("ERROR creating legacy_import_runs row:", runErr);
    process.exit(4);
  }
  const runId = runRow.id;
  console.log(`\nlegacy_import_run_id = ${runId}`);

  // 2. Bulk insert in batches of 500.
  const BATCH = 500;
  let inserted = 0;
  let flagged = 0;
  for (let i = 0; i < parsed.length; i += BATCH) {
    const batch = parsed.slice(i, i + BATCH).map((r) => ({
      first_name: r.first_name ?? "",
      last_name: r.last_name ?? "",
      middle_name: r.middle_name,
      birthdate: r.birthdate,
      birthdate_confirmed: false,
      sex: r.sex,
      phone: r.phone,
      email: r.email,
      address: r.address,
      referral_source: r.referral_source,
      referred_by_doctor: r.referred_by_doctor,
      preferred_release_medium: r.preferred_release_medium,
      senior_pwd_id_kind: r.senior_pwd_id_kind,
      senior_pwd_id_number: r.senior_pwd_id_number,
      pre_registered: false,
      legacy_intake: r.legacy_intake as never,
      legacy_import_run_id: runId,
    }));
    const { error: insErr } = await supabase.from("patients").insert(batch as never);
    if (insErr) {
      console.error(`\nERROR inserting batch ${Math.floor(i / BATCH) + 1}:`, insErr);
      console.error(`Inserted so far: ${inserted}. Rollback: DELETE FROM patients WHERE legacy_import_run_id = '${runId}';`);
      process.exit(5);
    }
    inserted += batch.length;
    flagged += parsed.slice(i, i + BATCH).filter((r) => r.legacy_intake.import_warnings.length > 0).length;
    process.stdout.write(`\r  inserted ${inserted}/${parsed.length}`);
  }
  process.stdout.write("\n");

  // 3. Stamp the run row as complete.
  await supabase
    .from("legacy_import_runs")
    .update({
      ended_at: new Date().toISOString(),
      rows_inserted: inserted,
      rows_skipped: records.length - parsed.length,
      rows_flagged: flagged,
    })
    .eq("id", runId);

  console.log(`\nImport complete. ${inserted} rows inserted, ${flagged} flagged with warnings.`);
  console.log(`Rollback command:\n  DELETE FROM patients WHERE legacy_import_run_id = '${runId}';`);
  console.log();
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
