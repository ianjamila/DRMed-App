import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../src/types/database";
import { requireLocalOrExplicitProd } from "../lib/env-guard";
import type { RawRow, TabConfig } from "./lib/types";
import { loadTab } from "./lib/xlsx";
import { classifyRow, type Window } from "./lib/classify";
import { isHmoRow, normaliseHmoProvider } from "./lib/hmo";
import { mopToMethod } from "./lib/mop-method";
import { buildVisitNumber } from "./lib/visit-number";
import { buildServiceIndex, mapService, type CatalogService } from "./lib/service-map";
import { buildPatientIndex, matchPatient, type PatientRow } from "./lib/patient-match";
import { parseTransactionName, matchKey } from "./lib/names";
import { resolveSurname } from "../clinical-enrich/lib/physician-map";
import { ensureSystemUser } from "./system-user";
import { writeCsv } from "./report";

const round2 = (n: number) => Math.round(n * 100) / 100;
const WINDOW: Window = { start: "2023-12-01", cutoverExclusive: "2026-05-26" };

interface Args { xlsx: string; commit: boolean; confirmed: boolean; resolutions?: string; }
export function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const xlsx = argv.find((a) => a.startsWith("--xlsx="))?.substring(7)
    ?? `${process.env.HOME ?? ""}/Downloads/DR MED MASTERSHEET.xlsx`;
  return {
    xlsx,
    commit: argv.includes("--commit"),
    confirmed: argv.includes('--confirm="I-mean-it"') || argv.includes("--confirm=I-mean-it"),
    resolutions: argv.find((a) => a.startsWith("--resolutions="))?.substring(14),
  };
}

function adminClient(): SupabaseClient<Database> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error("NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required."); process.exit(2); }
  return createClient<Database>(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

// Fetch all rows of a table in pages of 1000 (PostgREST cap).
async function fetchAll<T>(q: (from: number, to: number) => Promise<T[]>): Promise<T[]> {
  const out: T[] = []; let from = 0; const page = 1000;
  for (;;) {
    const batch = await q(from, from + page - 1);
    out.push(...batch);
    if (batch.length < page) break;
    from += page;
  }
  return out;
}

interface BuiltLine { row: RawRow; service_id: string; serviceMatched: boolean; }
interface BuiltVisit {
  key: string; patient_id: string; created_patient: boolean;
  visit_date: string; control_no: string; hmo_provider_id: string | null;
  lines: BuiltLine[]; collected: number; method: string; received_at: string; or_number: string;
  total: number;
}

export async function run(cfg: TabConfig): Promise<void> {
  const args = parseArgs();
  console.log(`Reading ${cfg.sheetName} from ${args.xlsx}`);
  const rows = await loadTab(args.xlsx, cfg);
  console.log(`  ${rows.length} rows read`);

  const admin = adminClient();

  // catalogs
  const patientsRaw = await fetchAll<PatientRow & { drm_id: string }>(async (lo, hi) => {
    const { data, error } = await admin.from("patients")
      .select("id,drm_id,last_name,first_name,sex").is("merged_into_id", null).range(lo, hi);
    if (error) throw new Error(error.message); return (data ?? []) as (PatientRow & { drm_id: string })[];
  });
  const patientIndex = buildPatientIndex(patientsRaw);

  // Optional partner-resolution overrides: matchKey -> patient_id. Lets a DISTINCT
  // ambiguous cluster's held rows import to the partner-chosen patient instead of
  // staying held. SAME clusters normally collapse to a single match once resolve.ts
  // has merged the duplicates, so the override is belt-and-suspenders for them.
  const overrideByKey = new Map<string, string>();
  if (args.resolutions) {
    const { parseResolutions, buildOverrideMap } = await import("./followups/resolutions");
    const text = await (await import("node:fs")).promises.readFile(args.resolutions, "utf8");
    const { resolutions, errors } = parseResolutions(text);
    if (errors.length) { console.error("Resolution file errors:\n  " + errors.join("\n  ")); process.exit(4); }
    const drmToId = new Map(patientsRaw.map((p) => [p.drm_id, p.id]));
    const built = buildOverrideMap(resolutions, drmToId);
    if (built.errors.length) { console.error("Resolution mapping errors:\n  " + built.errors.join("\n  ")); process.exit(4); }
    for (const [k, v] of built.overrides) overrideByKey.set(k, v);
    console.log(`  resolutions loaded: ${overrideByKey.size} cluster override(s) from ${args.resolutions}`);
  }

  const services = await fetchAll<CatalogService>(async (lo, hi) => {
    const { data, error } = await admin.from("services").select("id,code,name,kind,is_active").range(lo, hi);
    if (error) throw new Error(error.message); return (data ?? []) as CatalogService[];
  });
  // resolve generic legacy-lab + consult anchors (commit mode upserts legacy lab)
  const consultId = services.find((s) => s.code === "CONSULT")?.id ?? "";
  const legacyLabId = services.find((s) => s.code === "LEGACY-LAB")?.id ?? "";
  const hmoProviders = await fetchAll<{ id: string; name: string }>(async (lo, hi) => {
    const { data, error } = await admin.from("hmo_providers").select("id,name").range(lo, hi);
    if (error) throw new Error(error.message); return (data ?? []) as { id: string; name: string }[];
  });
  const hmoByName = new Map(hmoProviders.map((p) => [p.name.toLowerCase(), p.id]));

  // Surnames whose attending doctor keeps 100% of the consult (clinic_fee=0 is
  // expected, not an error) — recover their otherwise-"zero_amount" consults.
  const physRoster = await fetchAll<{ full_name: string; compensation_arrangement: string | null }>(async (lo, hi) => {
    const { data, error } = await admin.from("physicians").select("full_name,compensation_arrangement").range(lo, hi);
    if (error) throw new Error(error.message);
    return (data ?? []) as { full_name: string; compensation_arrangement: string | null }[];
  });
  const keepsFullFeeByName = new Set(
    physRoster.filter((p) => p.compensation_arrangement === "rent_paying" || p.compensation_arrangement === "shareholder").map((p) => p.full_name),
  );

  // classify + match + group
  const visits = new Map<string, BuiltVisit>();
  const ambiguous: string[][] = [];
  let resolvedViaOverride = 0;
  const newPatients = new Map<string, { last: string; first: string; sex: string; sample: RawRow }>();
  const unmappedServices = new Map<string, number>();
  const exclusions: string[][] = [];
  const svcIndex = buildServiceIndex(services, consultId, legacyLabId);

  for (const r of rows) {
    const doctorKeepsFullFee = cfg.isConsult
      && (() => { const fn = resolveSurname(r.service); return fn != null && keepsFullFeeByName.has(fn); })();
    const klass = classifyRow(r, WINDOW, cfg.isConsult, doctorKeepsFullFee);
    if (klass !== "postable") {
      exclusions.push([String(r.row_number), r.posting_date ?? "(none)", klass, r.patient_name, r.service,
        r.base.toFixed(2), r.final.toFixed(2), r.mop]);
      continue;
    }
    // patient
    const parsed = parseTransactionName(r.patient_name);
    // Stable, run-independent token for a person (same sheet name -> same token
    // every run). Used as the new-patient dedup key AND the control_no-less visit
    // group key, so re-runs stay idempotent: a resolved patient_id flips from a
    // NEW:placeholder to a real uuid once the patient is created in a prior run,
    // but this token does not.
    const nameToken = `${parsed.last}|${parsed.first}`.toLowerCase();
    const m = matchPatient(r.patient_name, "", patientIndex);
    let patient_id: string; let created_patient = false;
    if (m.kind === "match") { patient_id = m.patient_id; }
    else if (m.kind === "ambiguous") {
      // A partner resolution can lift the hold: route this cluster's rows to the
      // chosen patient. The override is keyed by the same matchKey the matcher uses.
      const ov = overrideByKey.get(matchKey(parsed.last, parsed.first));
      if (ov) { patient_id = ov; resolvedViaOverride++; }
      else {
        ambiguous.push([String(r.row_number), r.patient_name, m.candidates.join("|"), r.posting_date ?? ""]);
        continue; // held — not committed in the auto pass
      }
    } else {
      // new patient (dedup within run by the stable name token)
      if (!nameToken.trim() || nameToken === "|") {
        exclusions.push([String(r.row_number), r.posting_date ?? "", "unparseable_name", r.patient_name, r.service, "", "", ""]);
        continue;
      }
      if (!newPatients.has(nameToken)) newPatients.set(nameToken, { last: parsed.last, first: parsed.first, sex: "", sample: r });
      patient_id = `NEW:${nameToken}`; created_patient = true; // placeholder, resolved at commit
    }
    // service
    const sm = mapService(r.service, cfg.isConsult, svcIndex);
    if (!sm.matched) unmappedServices.set(r.service, (unmappedServices.get(r.service) ?? 0) + 1);

    // group key: tab+control_no; fallback uses the STABLE name token + date (NOT
    // the volatile patient_id) so the control_no-less branch is idempotent.
    const gkey = r.control_no ? `${cfg.tab}|${r.control_no}` : `${cfg.tab}|name:${nameToken}|${r.posting_date}`;
    let v = visits.get(gkey);
    if (!v) {
      const hmoId = isHmoRow(r) ? (hmoByName.get(normaliseHmoProvider(r.hmo_provider).toLowerCase()) ?? null) : null;
      v = {
        key: gkey, patient_id, created_patient, visit_date: r.posting_date!, control_no: r.control_no,
        hmo_provider_id: hmoId, lines: [], collected: 0, method: mopToMethod(r.mop),
        received_at: r.date_paid ?? r.posting_date!, or_number: r.or_number, total: 0,
      };
      visits.set(gkey, v);
    }
    v.lines.push({ row: r, service_id: sm.service_id, serviceMatched: sm.matched });
    const final = round2(cfg.isConsult ? r.clinic_fee : (r.final > 0 ? r.final : r.base));
    v.total = round2(v.total + final);
    // collected: cash-style only (HMO patient copay unknown -> 0). Non-HMO pays final.
    if (!isHmoRow(r)) v.collected = round2(v.collected + final);
  }

  // summary
  const visitArr = [...visits.values()];
  console.log(`\n=== ${cfg.sheetName} dry-run ===`);
  console.log(`Postable visits:     ${visitArr.length}`);
  console.log(`  test_request lines: ${visitArr.reduce((s, v) => s + v.lines.length, 0)}`);
  console.log(`  new patients:       ${newPatients.size}`);
  console.log(`  ambiguous (held):   ${ambiguous.length}`);
  if (args.resolutions) console.log(`  resolved via partner override: ${resolvedViaOverride}`);
  console.log(`  unmapped services:  ${unmappedServices.size}`);
  console.log(`  excluded rows:      ${exclusions.length}`);

  const csvs = await Promise.all([
    writeCsv(`clinical-${cfg.tab}-ambiguous`, ["row","name","candidates","date"], ambiguous),
    writeCsv(`clinical-${cfg.tab}-new-patients`, ["key","last","first"], [...newPatients.entries()].map(([k, p]) => [k, p.last, p.first])),
    writeCsv(`clinical-${cfg.tab}-unmapped-services`, ["service","count"], [...unmappedServices.entries()].sort((a,b)=>b[1]-a[1]).map(([s,n]) => [s, String(n)])),
    writeCsv(`clinical-${cfg.tab}-exclusions`, ["row","date","class","name","service","base","final","mop"], exclusions),
  ]);
  console.log(`\nCSVs:\n  ${csvs.join("\n  ")}`);

  if (!args.commit) {
    console.log(`\nDry-run. To commit (dev): npm run ${cfg.isConsult ? "backfill:clinical:consult" : "backfill:clinical:lab"} -- --commit --confirm="I-mean-it"\n`);
    return;
  }
  if (!args.confirmed) { console.error('\n--commit requires --confirm="I-mean-it".'); process.exit(3); }
  await commit(cfg, admin, visitArr, newPatients, svcIndex, legacyLabId);
}

async function commit(
  cfg: TabConfig, admin: SupabaseClient<Database>, visitArr: BuiltVisit[],
  newPatients: Map<string, { last: string; first: string; sex: string; sample: RawRow }>,
  svcIndex: ReturnType<typeof buildServiceIndex>,
  resolvedLegacyLabId: string,
): Promise<void> {
  requireLocalOrExplicitProd(`backfill:clinical:${cfg.isConsult ? "consult" : "lab"}`);
  const systemUserId = await ensureSystemUser(admin);

  // ensure generic legacy-lab service exists (lab tab only)
  if (!cfg.isConsult && !resolvedLegacyLabId) {
    const { data, error } = await admin.from("services")
      .upsert({ code: "LEGACY-LAB", name: "Legacy lab test", kind: "lab_test", price_php: 0, is_active: false } as never,
        { onConflict: "code" }).select("id").single();
    if (error || !data) throw new Error(`legacy-lab upsert: ${error?.message}`);
    svcIndex.legacyLabId = data.id;
    resolvedLegacyLabId = data.id;
  }

  // open the run
  const { data: runRow, error: runErr } = await admin.from("legacy_import_runs")
    .insert({ source: `clinical_backfill:${cfg.tab}`, dry_run: false, run_by: systemUserId } as never)
    .select("id").single();
  if (runErr || !runRow) throw new Error(`legacy_import_runs: ${runErr?.message}`);
  const runId = runRow.id as string;

  // 1. create new patients, resolve NEW: placeholders -> real ids
  // CORRECTION A: omit drm_id — the DB has a DEFAULT generate_drm_id() on the
  // column, so the Postgres sequence assigns it automatically (mirrors the proven
  // scripts/import-legacy-customers.ts pattern). Never compute or pass drm_id here.
  // Reuse patients THIS backfill already created so re-runs / partial-failure
  // resumes don't mint duplicate patient rows. Keyed on a stable
  // clinical_name_token stamped into legacy_intake at creation — the fuzzy
  // matcher alone is insufficient (e.g. single-token names are stored with
  // first_name=last_name and would not re-match on a blank first token).
  const priorClinicalPatients = await fetchAll<{ id: string; legacy_intake: { clinical_name_token?: string } | null }>(
    async (lo, hi) => {
      const { data, error } = await admin.from("patients")
        .select("id,legacy_intake").not("legacy_import_run_id", "is", null).range(lo, hi);
      if (error) throw new Error(error.message);
      return (data ?? []) as { id: string; legacy_intake: { clinical_name_token?: string } | null }[];
    },
  );
  const priorByToken = new Map<string, string>();
  for (const pp of priorClinicalPatients) {
    const tok = pp.legacy_intake?.clinical_name_token;
    if (typeof tok === "string" && tok && !priorByToken.has(tok)) priorByToken.set(tok, pp.id);
  }

  const newIdByKey = new Map<string, string>();
  let pNew = 0, pReused = 0;
  for (const [nk, p] of newPatients) {
    const reuse = priorByToken.get(nk);
    if (reuse) { newIdByKey.set(`NEW:${nk}`, reuse); pReused++; continue; }
    const { data, error } = await admin.from("patients").insert({
      first_name: p.first || p.last,   // first_name is NOT NULL; fall back to last
      last_name: p.last,
      pre_registered: false,
      birthdate_confirmed: false,
      legacy_import_run_id: runId,
      legacy_intake: { source: `clinical_backfill:${cfg.tab}`, clinical_name_token: nk, raw: p.sample } as never,
    } as never).select("id").single();
    if (error || !data) throw new Error(`patient insert (${nk}): ${error?.message}`);
    newIdByKey.set(`NEW:${nk}`, data.id as string);
    priorByToken.set(nk, data.id as string); // also guards against intra-run dupes
    pNew++;
  }

  // 2. visits -> test_requests -> payment, idempotent on legacy_source_ref.
  // Pre-load existing rows ONCE into in-memory indexes instead of a per-row
  // SELECT. This (a) roughly halves network round-trips for the whole import and
  // (b) makes a resume after a transient/partial failure near-instant — it skips
  // the thousands of already-imported rows in memory rather than re-querying each
  // (the per-row SELECT made every retry re-scan the whole prior progress).
  // usedVisitNumbers also pre-seeds visit_number uniqueness so a new
  // H-<control_no> can't collide with an app visit or the other tab's visit
  // sharing a control_no.
  const usedVisitNumbers = new Set<string>();
  const existingVisitByRef = new Map<string, string>(); // legacy_source_ref -> visit id
  const existingVisitRows = await fetchAll<{ id: string; visit_number: string; legacy_source_ref: string | null }>(
    async (lo, hi) => {
      const { data, error } = await admin.from("visits")
        .select("id,visit_number,legacy_source_ref").range(lo, hi);
      if (error) throw new Error(error.message);
      return (data ?? []) as { id: string; visit_number: string; legacy_source_ref: string | null }[];
    },
  );
  for (const e of existingVisitRows) {
    if (e.visit_number) usedVisitNumbers.add(e.visit_number);
    if (e.legacy_source_ref) existingVisitByRef.set(e.legacy_source_ref, e.id);
  }
  const existingTestRefs = new Set<string>();
  for (const e of await fetchAll<{ legacy_source_ref: string }>(async (lo, hi) => {
    const { data, error } = await admin.from("test_requests")
      .select("legacy_source_ref").not("legacy_source_ref", "is", null).range(lo, hi);
    if (error) throw new Error(error.message);
    return (data ?? []) as { legacy_source_ref: string }[];
  })) existingTestRefs.add(e.legacy_source_ref);
  const existingPaymentRefs = new Set<string>();
  for (const e of await fetchAll<{ legacy_source_ref: string }>(async (lo, hi) => {
    const { data, error } = await admin.from("payments")
      .select("legacy_source_ref").not("legacy_source_ref", "is", null).range(lo, hi);
    if (error) throw new Error(error.message);
    return (data ?? []) as { legacy_source_ref: string }[];
  })) existingPaymentRefs.add(e.legacy_source_ref);
  let vIns = 0, vSkip = 0, tIns = 0, pIns = 0;
  for (const v of visitArr) {
    const patient_id = v.patient_id.startsWith("NEW:") ? newIdByKey.get(v.patient_id)! : v.patient_id;
    const visitRef = `${cfg.tab} ${v.control_no ? "control=" + v.control_no : "grp=" + v.key}`;
    // idempotency: skip if this visit ref already imported (in-memory index)
    const existingVisitId = existingVisitByRef.get(visitRef);
    let visitId: string;
    if (existingVisitId) { visitId = existingVisitId; vSkip++; }
    else {
      const visit_number = buildVisitNumber(cfg.tab, v.control_no, 0, usedVisitNumbers);
      const { data: vr, error: vErr } = await admin.from("visits").insert({
        patient_id, visit_number, visit_date: v.visit_date, payment_status: "unpaid",
        total_php: v.total, paid_php: 0, hmo_provider_id: v.hmo_provider_id,
        created_by: systemUserId, created_at: v.visit_date,
        legacy_import_run_id: runId, legacy_source_ref: visitRef,
      } as never).select("id").single();
      if (vErr || !vr) throw new Error(`visit insert (${visitRef}): ${vErr?.message}`);
      visitId = vr.id as string; vIns++;
      existingVisitByRef.set(visitRef, visitId);
    }
    // test_requests
    for (const ln of v.lines) {
      const ref = `${cfg.tab} r${ln.row.row_number}`;
      if (existingTestRefs.has(ref)) continue;
      const base = round2(ln.row.base > 0 ? ln.row.base : ln.row.final);
      const final = round2(cfg.isConsult ? ln.row.clinic_fee : (ln.row.final > 0 ? ln.row.final : ln.row.base));
      const discount = round2(Math.max(base - final, 0));
      // unmatched lab lines carried service_id="" through dry-run; resolve to
      // the now-known generic legacy-lab service at commit time.
      const service_id = ln.service_id || resolvedLegacyLabId;
      const { error: tErr } = await admin.from("test_requests").insert({
        visit_id: visitId, service_id, status: "released",
        requested_by: systemUserId, requested_at: ln.row.posting_date!,
        released_by: systemUserId, released_at: ln.row.posting_date!, release_medium: "physical",
        base_price_php: base, discount_amount_php: discount,
        discount_kind: discount > 0 ? "custom" : null,
        final_price_php: final,
        // clamp pass-through consult fees to >= 0: the sheet has a few rows
        // with a positive clinic_fee but a negative doctor_pf (data-entry
        // anomaly), which would violate test_requests_{clinic_fee,doctor_pf}_php_check.
        clinic_fee_php: cfg.isConsult ? Math.max(round2(ln.row.clinic_fee), 0) : null,
        doctor_pf_php: cfg.isConsult ? Math.max(round2(ln.row.doctor_pf), 0) : null,
        is_package_header: false, test_number: null,
        receptionist_remarks: ln.serviceMatched ? null : `legacy service: ${ln.row.service}`,
        legacy_import_run_id: runId, legacy_source_ref: ref,
      } as never);
      if (tErr) throw new Error(`test_request insert (${ref}): ${tErr.message}`);
      existingTestRefs.add(ref);
      tIns++;
    }
    // payment (only if collected > 0)
    if (v.collected > 0) {
      const pref = `${cfg.tab} ${v.control_no ? "control=" + v.control_no : "grp=" + v.key} pay`;
      if (!existingPaymentRefs.has(pref)) {
        const { error: pErr } = await admin.from("payments").insert({
          visit_id: visitId, amount_php: v.collected, method: v.method,
          reference_number: v.or_number || null, received_by: systemUserId,
          received_at: `${v.received_at}T02:00:00Z`,
          legacy_import_run_id: runId, legacy_source_ref: pref,
        } as never);
        if (pErr) throw new Error(`payment insert (${pref}): ${pErr.message}`);
        existingPaymentRefs.add(pref);
        pIns++;
      }
    }
  }

  await admin.from("legacy_import_runs").update({
    ended_at: new Date().toISOString(), rows_inserted: vIns + tIns + pIns + pNew,
    notes: `visits +${vIns} (skip ${vSkip}), tests +${tIns}, payments +${pIns}, new patients +${pNew} (reused ${pReused})`,
  } as never).eq("id", runId);

  console.log(`\nCommit complete: visits +${vIns} (skip ${vSkip}), tests +${tIns}, payments +${pIns}, new patients +${pNew} (reused ${pReused})`);
}
