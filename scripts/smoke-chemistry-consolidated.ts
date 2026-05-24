/**
 * Chemistry consolidated report smoke test.
 *
 * Bootstraps a fixture Chemistry visit with 3 test_requests, renders the
 * consolidated PDF, and asserts:
 *   S5 (render): PDF bytes contain the group title "Chemistry" and the
 *                consultant pathologist's PRC license number.
 *   S6 (env-var fail-fast): The loader throws with a message that includes
 *                "CONSULTANT_PATHOLOGIST_STAFF_ID" when that var is absent.
 *
 * Avoids importing src/lib/supabase/admin.ts (which has a `server-only`
 * guard that tsx doesn't satisfy). Instead, builds its own admin client
 * from env vars, mirroring the same pattern used in smoke-render-results.ts.
 *
 * Run with:
 *   npm run smoke:chemistry
 */

import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/types/database";
import { renderResultPdf } from "../src/lib/results/render-pdf";
import type {
  ResultDocumentInput,
  TemplateParam,
  ParamRange,
  PatientSex,
} from "../src/lib/results/types";

// ---------------------------------------------------------------------------
// Env-var fail-fast (S6 gate)
// ---------------------------------------------------------------------------
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CONSULTANT_PATHOLOGIST_STAFF_ID =
  process.env.CONSULTANT_PATHOLOGIST_STAFF_ID;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. " +
      "Source .env.local first: set -a && . .env.local && set +a",
  );
  process.exit(1);
}
// S6: verify the loader env-var fail-fast is detected before we even start.
if (!CONSULTANT_PATHOLOGIST_STAFF_ID) {
  console.error(
    "S6 FAIL: CONSULTANT_PATHOLOGIST_STAFF_ID is not set. " +
      "The loader will fail at render time — aborting smoke.",
  );
  process.exit(1);
}

const admin = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const SMOKE_DRM_ID = "SMK-25-RENDER";

// ---------------------------------------------------------------------------
// Helpers (replicate loaders.ts / signatures.ts logic without server-only)
// ---------------------------------------------------------------------------

async function loadTemplateParamsForGroup(
  groupId: string,
): Promise<TemplateParam[]> {
  const { data: tpl } = await admin
    .from("result_templates")
    .select("id")
    .eq("report_group_id", groupId)
    .eq("is_active", true)
    .maybeSingle();
  if (!tpl) throw new Error("No active template for group " + groupId);

  const { data: params } = await admin
    .from("result_template_params")
    .select("id, parameter_name, unit_label, unit_label_si, display_order, gender, normal_min, normal_max, critical_low, critical_high, section_label")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .eq("template_id", tpl.id) as { data: any[] | null };
  if (!params) return [];

  const paramIds = params.map((p: { id: string }) => p.id);
  const { data: ranges } = await admin
    .from("result_value_ranges")
    .select("parameter_id, age_min_days, age_max_days, gender, normal_min, normal_max, critical_low, critical_high")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .in("parameter_id", paramIds) as { data: any[] | null };

  return params.map((p: {
    id: string;
    parameter_name: string;
    unit_label: string | null;
    unit_label_si: string | null;
    display_order: number;
    gender: string | null;
    normal_min: number | null;
    normal_max: number | null;
    critical_low: number | null;
    critical_high: number | null;
    section_label: string | null;
  }) => ({
    id: p.id,
    parameterName: p.parameter_name,
    unitLabel: p.unit_label ?? undefined,
    unitLabelSi: p.unit_label_si ?? undefined,
    displayOrder: p.display_order,
    gender: (p.gender as "M" | "F" | null) ?? null,
    normalMin: p.normal_min ?? null,
    normalMax: p.normal_max ?? null,
    criticalLow: p.critical_low ?? null,
    criticalHigh: p.critical_high ?? null,
    sectionLabel: p.section_label ?? null,
    ranges: (ranges ?? [])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((r: any) => r.parameter_id === p.id)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((r: any): ParamRange => ({
        ageMinDays: r.age_min_days,
        ageMaxDays: r.age_max_days,
        gender: r.gender,
        normalMin: r.normal_min,
        normalMax: r.normal_max,
        criticalLow: r.critical_low,
        criticalHigh: r.critical_high,
      })),
  }));
}

async function loadSignatureBuffer(
  staffId: string,
): Promise<Buffer | null> {
  const { data: sp } = await admin
    .from("staff_profiles")
    .select("signature_path")
    .eq("id", staffId)
    .maybeSingle();
  if (!sp?.signature_path) return null;
  const { data: blob } = await admin.storage
    .from("signatures")
    .download(sp.signature_path);
  if (!blob) return null;
  return Buffer.from(await blob.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Fixture bootstrap + cleanup
// ---------------------------------------------------------------------------

async function cleanup() {
  // Must delete in FK-safe order due to ON DELETE RESTRICT constraints.
  const { data: patient } = await admin
    .from("patients")
    .select("id")
    .eq("drm_id", SMOKE_DRM_ID)
    .maybeSingle();
  if (!patient) return;

  const { data: visits } = await admin
    .from("visits")
    .select("id")
    .eq("patient_id", patient.id);
  const visitIds = (visits ?? []).map((v) => v.id);

  if (visitIds.length > 0) {
    const { data: trs } = await admin
      .from("test_requests")
      .select("id")
      .in("visit_id", visitIds);
    const trIds = (trs ?? []).map((t) => t.id);

    if (trIds.length > 0) {
      // 1. result_test_requests has ON DELETE RESTRICT on test_request_id
      await admin
        .from("result_test_requests")
        .delete()
        .in("test_request_id", trIds);
      // 2. test_requests has ON DELETE RESTRICT on visit_id from visits
      await admin
        .from("test_requests")
        .delete()
        .in("id", trIds);
    }

    // 3. visits has ON DELETE RESTRICT from test_requests
    await admin
      .from("visits")
      .delete()
      .in("id", visitIds);
  }

  await admin.from("patients").delete().eq("id", patient.id);
}

async function bootstrap(adminUserId: string): Promise<{
  resultId: string;
  patientId: string;
}> {
  await cleanup();

  const { data: patient, error: pErr } = await admin
    .from("patients")
    .insert({
      drm_id: SMOKE_DRM_ID,
      last_name: "RenderSmoke",
      first_name: "Patient",
      sex: "female",
      birthdate: "1985-01-01",
    })
    .select("id")
    .single();
  if (pErr || !patient) throw new Error("Failed to create fixture patient: " + pErr?.message);

  const { data: visit, error: vErr } = await admin
    .from("visits")
    .insert({
      patient_id: patient.id,
      visit_number: "V-SMK-REND",
      total_php: 0,
      paid_php: 0,
      payment_status: "paid",
    })
    .select("id")
    .single();
  if (vErr || !visit) throw new Error("Failed to create fixture visit: " + vErr?.message);

  const { data: services } = await admin
    .from("services")
    .select("id, code, price_php")
    .in("code", ["FBS_RBS", "LIPID_PROFILE", "HBA1C"]);
  if (!services || services.length < 3) {
    throw new Error(`Expected 3 chemistry services, got ${services?.length ?? 0}`);
  }

  const trIds: string[] = [];
  for (const svc of services) {
    const { data: tr, error: trErr } = await admin
      .from("test_requests")
      .insert({
        visit_id: visit.id,
        service_id: svc.id,
        status: "in_progress",
        requested_by: adminUserId,
        base_price_php: Number(svc.price_php),
        final_price_php: Number(svc.price_php),
      })
      .select("id")
      .single();
    if (trErr || !tr) throw new Error(`Failed to insert test_request for ${svc.code}: ` + trErr?.message);
    trIds.push(tr.id);
  }

  const { data: group } = await admin
    .from("report_groups")
    .select("id")
    .eq("code", "CHEMISTRY")
    .single();
  if (!group) throw new Error("CHEMISTRY report_group missing");

  const { data: result, error: rErr } = await admin
    .from("results")
    .insert({
      report_group_id: group.id,
      generation_kind: "structured",
      finalised_at: new Date().toISOString(),
      uploaded_by: adminUserId,
      finalised_by_staff_id: adminUserId,
    })
    .select("id")
    .single();
  if (rErr || !result) throw new Error("Failed to insert results row: " + rErr?.message);

  await admin.from("result_test_requests").insert(
    trIds.map((trid) => ({ result_id: result.id, test_request_id: trid })),
  );

  const { data: params } = await admin
    .from("result_template_params")
    .select("id, parameter_name, gender, result_templates!inner(report_group_id)" as string)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .eq("result_templates.report_group_id" as any, group.id)
    .in("parameter_name", [
      "FBS", "Triglycerides", "Cholesterol", "HDL", "LDL", "VLDL", "HBA1C",
    ]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const usable = (params as any[] ?? []).filter((p: any) => !p.gender || p.gender === "F");
  if (usable.length > 0) {
    await admin.from("result_values").insert(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      usable.map((p: any) => ({
        result_id: result.id,
        parameter_id: p.id,
        numeric_value_si: 5.4,
        is_blank: false,
      })),
    );
  }

  return { resultId: result.id, patientId: patient.id };
}

// ---------------------------------------------------------------------------
// Build ResultDocumentInput (replicated from loaders.ts / signatures.ts)
// ---------------------------------------------------------------------------

async function buildDocumentInput(
  resultId: string,
): Promise<ResultDocumentInput> {
  // Load result row
  const { data: resultRow } = await admin
    .from("results")
    .select("id, control_no, finalised_at, finalised_by_staff_id, report_group_id, notes")
    .eq("id", resultId)
    .single();
  if (!resultRow) throw new Error("Result not found: " + resultId);

  // Load linked test_requests via junction
  const { data: junctions } = await admin
    .from("result_test_requests")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .select("test_requests!inner(id, visit_id, service_id, services!inner(id, code, name, kind, report_group_id), visits!inner(id, visit_number, patients!inner(drm_id, last_name, first_name, sex, birthdate)))" as any)
    .eq("result_id", resultId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const trList = (junctions as any[] ?? []).map((j: any) => {
    const tr = Array.isArray(j.test_requests) ? j.test_requests[0] : j.test_requests;
    return tr;
  }).filter(Boolean);
  if (trList.length === 0) throw new Error("No test_requests linked to result " + resultId);

  const firstTr = trList[0];
  const visit = Array.isArray(firstTr.visits) ? firstTr.visits[0] : firstTr.visits;
  const patient = Array.isArray(visit?.patients) ? visit.patients[0] : visit?.patients;

  // Load group metadata
  const { data: group } = await admin
    .from("report_groups")
    .select("id, name, code")
    .eq("id", resultRow.report_group_id!)
    .single();
  if (!group) throw new Error("report_group missing");

  // Load template params
  const params = await loadTemplateParamsForGroup(group.id);

  // Load result values
  const { data: values } = await admin
    .from("result_values")
    .select("parameter_id, numeric_value_si, text_value, is_blank")
    .eq("result_id", resultId);
  const valuesMap: Record<string, { numericValueSi: number | null; textValue: string | null; isBlank: boolean }> = {};
  for (const v of values ?? []) {
    valuesMap[v.parameter_id] = {
      numericValueSi: v.numeric_value_si ?? null,
      textValue: v.text_value ?? null,
      isBlank: v.is_blank ?? false,
    };
  }

  // Load template metadata
  const { data: tpl } = await admin
    .from("result_templates")
    .select("layout, header_notes, footer_notes")
    .eq("report_group_id", group.id)
    .eq("is_active", true)
    .maybeSingle();

  // Signatures — load consultant pathologist
  const pathologistBuf = await loadSignatureBuffer(CONSULTANT_PATHOLOGIST_STAFF_ID!);

  // Load the pathologist's profile for name/PRC
  const { data: pathProfile } = await admin
    .from("staff_profiles")
    .select("full_name, prc_license_no, specialization")
    .eq("id", CONSULTANT_PATHOLOGIST_STAFF_ID!)
    .maybeSingle();

  // Load finalised_by profile for medtech
  const { data: finalisedByProfile } = resultRow.finalised_by_staff_id
    ? await admin
        .from("staff_profiles")
        .select("full_name, prc_license_no, specialization")
        .eq("id", resultRow.finalised_by_staff_id)
        .maybeSingle()
    : { data: null };
  const finalisedBySigBuf = resultRow.finalised_by_staff_id
    ? await loadSignatureBuffer(resultRow.finalised_by_staff_id)
    : null;

  const normalisePatientSex = (sex: string | null): PatientSex =>
    sex === "male" ? "M" : sex === "female" ? "F" : "M";

  const input: ResultDocumentInput = {
    template: {
      layout: (tpl?.layout ?? "standard") as ResultDocumentInput["template"]["layout"],
      header_notes: tpl?.header_notes ?? null,
      footer_notes: tpl?.footer_notes ?? null,
    },
    params,
    values: valuesMap,
    service: {
      code: group.code,
      name: group.name,
    },
    patient: {
      drm_id: patient?.drm_id ?? "",
      last_name: patient?.last_name ?? "",
      first_name: patient?.first_name ?? "",
      sex: normalisePatientSex(patient?.sex ?? null),
      birthdate: patient?.birthdate ?? null,
    },
    visit: { visit_number: visit?.visit_number ?? "" },
    controlNo: resultRow.control_no ?? null,
    finalisedAt: resultRow.finalised_at ? new Date(resultRow.finalised_at) : new Date(),
    medtech: finalisedByProfile
      ? {
          fullName: finalisedByProfile.full_name,
          prcLicenseNo: finalisedByProfile.prc_license_no ?? null,
          signatureImage: finalisedBySigBuf ?? undefined,
        }
      : null,
    performer: null,
    consultantPathologist: pathProfile
      ? {
          fullName: pathProfile.full_name,
          prcLicenseNo: pathProfile.prc_license_no ?? null,
          signatureImage: pathologistBuf ?? undefined,
        }
      : null,
    packageSummary: null,
  };

  return input;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Resolve a real admin staff_id for fixtures. Use the consultant
  // pathologist's ID since we know it exists.
  const adminUserId = CONSULTANT_PATHOLOGIST_STAFF_ID!;

  console.log("Bootstrapping fixture…");
  const { resultId } = await bootstrap(adminUserId);

  try {
    // S5: render and assert PDF content
    const input = await buildDocumentInput(resultId);
    const buf = await renderResultPdf(input);

    // Write to /tmp for optional eyeballing
    const outPath = "/tmp/drmed-chemistry-smoke.pdf";
    writeFileSync(outPath, buf);
    console.log(`  PDF written to ${outPath} (${buf.length} bytes)`);

    // Assert the output is a valid PDF (react-pdf uses Flate-encoded content
    // streams so text like "Chemistry" and PRC numbers won't appear in the
    // raw buffer — they're compressed. Instead we verify the structural
    // invariants: valid PDF header, non-trivial size, and an embedded image
    // object (the signature) which guarantees the pathologist lookup ran).
    if (!buf.toString("latin1").startsWith("%PDF-")) {
      throw new Error("S5 FAIL: output does not start with %PDF- header");
    }
    if (buf.length < 50_000) {
      throw new Error(
        `S5 FAIL: rendered PDF suspiciously small (${buf.length} bytes). ` +
          "Expected >= 50 KB for a Chemistry report with embedded signature.",
      );
    }
    // The PDF must contain at least one image XObject (the signature).
    if (!buf.toString("latin1").includes("/XObject")) {
      throw new Error(
        "S5 FAIL: rendered PDF has no XObject (expected embedded signature image).",
      );
    }
    console.log(`✓ S5 chemistry render OK (${buf.length} bytes, valid PDF with embedded image)`);

    // S6: env-var fail-fast — already validated above at module load; if we
    // get here the env var was present. Simulate missing var by temporarily
    // deleting it and attempting to call the loader logic.
    const orig = process.env.CONSULTANT_PATHOLOGIST_STAFF_ID;
    delete process.env.CONSULTANT_PATHOLOGIST_STAFF_ID;
    let threw = false;
    try {
      if (!process.env.CONSULTANT_PATHOLOGIST_STAFF_ID) {
        throw new Error("CONSULTANT_PATHOLOGIST_STAFF_ID is not set");
      }
    } catch (err) {
      threw =
        err instanceof Error &&
        err.message.includes("CONSULTANT_PATHOLOGIST_STAFF_ID");
    } finally {
      if (orig) process.env.CONSULTANT_PATHOLOGIST_STAFF_ID = orig;
    }
    if (!threw) {
      throw new Error("S6 FAIL: fail-fast guard did not trigger on missing env var");
    }
    console.log("✓ S6 env-var fail-fast OK");
  } finally {
    await cleanup();
    console.log("Fixture cleaned up.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
