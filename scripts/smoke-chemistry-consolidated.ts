/**
 * Chemistry consolidated report smoke test.
 *
 * Bootstraps a fixture Chemistry visit (2 test_requests sharing one combined
 * `results` row) and renders it through `loadResultDocumentInput` — the SAME
 * loader the app's consolidated-finalise and edit paths call — rather than
 * hand-rolling a second copy of the query logic. That second copy is exactly
 * what went stale here before: it read `unit_label` / `display_order` /
 * `result_value_ranges`, none of which exist anymore (see
 * `src/lib/results/loaders.ts` and `.../types.ts` for the current shape).
 *
 * Proves:
 *   S1 (original render): loadResultDocumentInput + renderResultPdf produce a
 *       valid PDF for a real consolidated chemistry result.
 *   S2 (edit render): the SAME loader, called with `valuesOverride` (one
 *       value changed) and `signerStaffId` (a different staff member),
 *       still renders — and:
 *         - `controlNo` is unchanged (edits never renumber a report),
 *         - `finalisedAt` / `ageAsOf` stay the ORIGINAL `results.finalised_at`
 *           even though no `finalisedAtOverride` was passed (an edit keeps
 *           the report's original date — 0172 / owner decision 2026-09-24),
 *         - `performer` reflects the NEW signer, not the original finaliser.
 *   S3 (env-var fail-fast, real code path): deleting
 *       CONSULTANT_PATHOLOGIST_STAFF_ID and calling loadResultDocumentInput
 *       again throws with a message naming the missing var (src/lib/results/
 *       signatures.ts's requireEnv) — not simulated, the actual loader.
 *
 * loadResultDocumentInput lazy-imports src/lib/supabase/admin.ts and
 * ./signatures, both of which `import "server-only"` — that throws under
 * plain tsx (no bundler sets the `react-server` export condition Next uses
 * to swap it for an empty stub). `--conditions=react-server` would fix that
 * but breaks @react-pdf/renderer's reconciler, which also branches on that
 * condition (verified empirically 2026-09-25). So `npm run smoke:chemistry`
 * instead runs this file as
 * `tsx --require ./scripts/lib/server-only-shim.cjs`, which preloads a
 * synthetic "already loaded" cache entry for `server-only`'s resolved path —
 * the same effect as Next's `empty.js` swap, but scoped to just that one
 * package (see the shim file for the full rationale). `smoke:results`
 * predates this and avoids the loader entirely instead (see its own
 * top-of-file comment) — this script no longer needs to.
 *
 * The local stack has no chemistry `services` rows (`seed:services` doesn't
 * seed chemistry — see `docs/superpowers/plans/2026-09-24-released-chemistry-
 * view-and-amend.md`), so this script creates two minimal fixture services
 * under the CHEMISTRY report_group (code prefix `ZZSMK172_`) alongside the
 * fixture patient/visit/staff, and deletes all of it in `finally`.
 *
 * Run with:
 *   npm run smoke:chemistry
 */

import "./lib/load-env";
import { requireLocalOrExplicitProd } from "./lib/env-guard";
import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/types/database";
import { renderResultPdf } from "../src/lib/results/render-pdf";
import { loadResultDocumentInput } from "../src/lib/results/loaders";
import { PATIENT_LIFECYCLE_COLUMNS } from "../src/lib/patients/active";
import type { ResultDocumentInput } from "../src/lib/results/types";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

requireLocalOrExplicitProd("smoke:chemistry", {
  writes:
    "creates fixture chemistry services, a patient/visit/2 test_requests, a " +
    "combined structured result + values, and 5 fixture staff — all deleted " +
    "in finally",
});

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. " +
      "Source .env.development.local first, or run via `npm run smoke:chemistry`.",
  );
  process.exit(1);
}

const admin = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const SMOKE_DRM_ID = "SMK-172-CHEM";
const SMOKE_VISIT_NUMBER = "V-SMK172-CHEM";
const SERVICE_CODE_A = "ZZSMK172_FBS";
const SERVICE_CODE_B = "ZZSMK172_BUN";
const STAFF_EMAILS = {
  pathologist: "smk172-pathologist@example.test",
  radiologist: "smk172-radiologist@example.test",
  cardiologist: "smk172-cardiologist@example.test",
  finaliser: "smk172-finaliser@example.test",
  editor: "smk172-editor@example.test",
} as const;

// ---------------------------------------------------------------------------
// Fixture bootstrap + cleanup
// ---------------------------------------------------------------------------

async function ensureStaffUser(email: string, fullName: string, role: string): Promise<string> {
  const { data: existing } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  let user = existing.users.find((u) => u.email === email);
  if (!user) {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: `Smk172-${Math.random().toString(36).slice(2)}!`,
      email_confirm: true,
    });
    if (error) throw new Error(`create fixture staff user ${email} failed: ${error.message}`);
    user = data.user;
  }
  if (!user) throw new Error(`fixture staff user ${email} not resolved`);

  const { error: profileErr } = await admin
    .from("staff_profiles")
    .upsert({ id: user.id, full_name: fullName, role, is_active: true }, { onConflict: "id" });
  if (profileErr) throw new Error(`upsert fixture staff_profile ${email}: ${profileErr.message}`);

  return user.id;
}

async function deleteStaffUser(email: string): Promise<void> {
  const { data: existing } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  const user = existing.users.find((u) => u.email === email);
  if (!user) return;
  // staff_profiles.id → auth.users(id) ON DELETE CASCADE.
  await admin.auth.admin.deleteUser(user.id);
}

async function cleanup(): Promise<void> {
  // Must delete in FK-safe order due to ON DELETE RESTRICT constraints. Not
  // active-filtered on purpose: teardown must find and remove this fixture
  // whatever lifecycle state a prior run left it in (including soft-deleted).
  const { data: patient } = await admin
    .from("patients")
    .select(`id, ${PATIENT_LIFECYCLE_COLUMNS}`)
    .eq("drm_id", SMOKE_DRM_ID)
    .maybeSingle();

  if (patient) {
    const { data: visits } = await admin.from("visits").select("id").eq("patient_id", patient.id);
    const visitIds = (visits ?? []).map((v) => v.id);

    if (visitIds.length > 0) {
      const { data: trs } = await admin.from("test_requests").select("id").in("visit_id", visitIds);
      const trIds = (trs ?? []).map((t) => t.id);

      if (trIds.length > 0) {
        const { data: results } = await admin
          .from("result_test_requests")
          .select("result_id")
          .in("test_request_id", trIds);
        const resultIds = [...new Set((results ?? []).map((r) => r.result_id))];

        if (resultIds.length > 0) {
          await admin.from("result_values").delete().in("result_id", resultIds);
          await admin.from("result_test_requests").delete().in("result_id", resultIds);
          await admin.from("results").delete().in("id", resultIds);
        }
        // Any junction row not already caught above (defensive).
        await admin.from("result_test_requests").delete().in("test_request_id", trIds);
        await admin.from("test_requests").delete().in("id", trIds);
      }
      await admin.from("visits").delete().in("id", visitIds);
    }
    await admin.from("patients").delete().eq("id", patient.id);
  }

  await admin.from("services").delete().in("code", [SERVICE_CODE_A, SERVICE_CODE_B]);

  for (const email of Object.values(STAFF_EMAILS)) {
    await deleteStaffUser(email);
  }
}

interface Fixture {
  resultId: string;
  originalFinalisedAtIso: string;
  finaliserStaffId: string;
  editorStaffId: string;
  editorFullName: string;
  paramAId: string; // overridden in the edit render
  paramAOriginalValue: number;
  paramAEditedValue: number;
}

async function bootstrap(): Promise<Fixture> {
  await cleanup();

  const pathologistId = await ensureStaffUser(STAFF_EMAILS.pathologist, "Smoke Pathologist", "pathologist");
  const radiologistId = await ensureStaffUser(STAFF_EMAILS.radiologist, "Smoke Radiologist", "pathologist");
  const cardiologistId = await ensureStaffUser(STAFF_EMAILS.cardiologist, "Smoke Cardiologist", "pathologist");
  const finaliserId = await ensureStaffUser(STAFF_EMAILS.finaliser, "Smoke Finaliser Medtech", "medtech");
  const editorId = await ensureStaffUser(STAFF_EMAILS.editor, "Smoke Editor Medtech", "medtech");

  // Point the env vars loaders.ts/signatures.ts read at our fixture staff, so
  // the render doesn't depend on ambient CONSULTANT_*_STAFF_ID (unset on this
  // local stack — see the module comment).
  process.env.CONSULTANT_PATHOLOGIST_STAFF_ID = pathologistId;
  process.env.CONSULTANT_RADIOLOGIST_STAFF_ID = radiologistId;
  process.env.CONSULTANT_CARDIOLOGIST_STAFF_ID = cardiologistId;

  const { data: group, error: groupErr } = await admin
    .from("report_groups")
    .select("id")
    .eq("code", "CHEMISTRY")
    .single();
  if (groupErr || !group) {
    throw new Error(
      "CHEMISTRY report_group missing locally — run `supabase db reset` (seeded by " +
        `migration 0053) before smoke:chemistry: ${groupErr?.message}`,
    );
  }

  const { data: template, error: templateErr } = await admin
    .from("result_templates")
    .select("id")
    .eq("report_group_id", group.id)
    .eq("is_active", true)
    .maybeSingle();
  if (templateErr || !template) {
    throw new Error(`No active chemistry template locally: ${templateErr?.message}`);
  }

  const { data: params, error: paramsErr } = await admin
    .from("result_template_params")
    .select("id, parameter_name, gender")
    .eq("template_id", template.id)
    .is("gender", null) // avoid the gender-specific Creatinine/Uric Acid rows
    .order("sort_order", { ascending: true })
    .limit(2);
  if (paramsErr || !params || params.length < 2) {
    throw new Error(`Expected >= 2 gender-neutral chemistry params: ${paramsErr?.message}`);
  }
  const [paramA, paramB] = params;

  const { data: svcA, error: svcAErr } = await admin
    .from("services")
    .insert({
      code: SERVICE_CODE_A,
      name: `Smoke ${paramA.parameter_name}`,
      price_php: 150,
      kind: "lab_test",
      section: "chemistry",
      report_group_id: group.id,
    })
    .select("id, code, name, kind, report_group_id")
    .single();
  if (svcAErr || !svcA) throw new Error(`create fixture service A: ${svcAErr?.message}`);

  const { data: svcB, error: svcBErr } = await admin
    .from("services")
    .insert({
      code: SERVICE_CODE_B,
      name: `Smoke ${paramB.parameter_name}`,
      price_php: 150,
      kind: "lab_test",
      section: "chemistry",
      report_group_id: group.id,
    })
    .select("id, code, name, kind, report_group_id")
    .single();
  if (svcBErr || !svcB) throw new Error(`create fixture service B: ${svcBErr?.message}`);

  const { data: patient, error: pErr } = await admin
    .from("patients")
    .insert({
      drm_id: SMOKE_DRM_ID,
      last_name: "ChemistrySmoke",
      first_name: "Patient",
      sex: "female",
      birthdate: "1985-01-01",
    })
    .select("id")
    .single();
  if (pErr || !patient) throw new Error(`create fixture patient: ${pErr?.message}`);

  const { data: visit, error: vErr } = await admin
    .from("visits")
    .insert({
      patient_id: patient.id,
      visit_number: SMOKE_VISIT_NUMBER,
      total_php: 300,
      paid_php: 300,
      payment_status: "paid",
    })
    .select("id")
    .single();
  if (vErr || !visit) throw new Error(`create fixture visit: ${vErr?.message}`);

  const trIds: string[] = [];
  for (const svc of [svcA, svcB]) {
    const { data: tr, error: trErr } = await admin
      .from("test_requests")
      .insert({
        visit_id: visit.id,
        service_id: svc.id,
        status: "ready_for_release",
        requested_by: finaliserId,
        assigned_to: finaliserId,
        base_price_php: 150,
        final_price_php: 150,
      })
      .select("id")
      .single();
    if (trErr || !tr) throw new Error(`create fixture test_request for ${svc.code}: ${trErr?.message}`);
    trIds.push(tr.id);
  }

  const finalisedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000); // 3 days ago
  const { data: result, error: rErr } = await admin
    .from("results")
    .insert({
      report_group_id: group.id,
      generation_kind: "structured",
      finalised_at: finalisedAt.toISOString(),
      uploaded_by: finaliserId,
      finalised_by_staff_id: finaliserId,
    })
    .select("id")
    .single();
  if (rErr || !result) throw new Error(`create fixture results row: ${rErr?.message}`);

  await admin
    .from("result_test_requests")
    .insert(trIds.map((tr_id) => ({ result_id: result.id, test_request_id: tr_id })));

  const paramAOriginalValue = 5.4;
  const paramBValue = 4.0;
  const { error: valuesErr } = await admin.from("result_values").insert([
    { result_id: result.id, parameter_id: paramA.id, numeric_value_si: paramAOriginalValue, is_blank: false },
    { result_id: result.id, parameter_id: paramB.id, numeric_value_si: paramBValue, is_blank: false },
  ]);
  if (valuesErr) throw new Error(`insert fixture result_values: ${valuesErr.message}`);

  return {
    resultId: result.id,
    originalFinalisedAtIso: finalisedAt.toISOString(),
    finaliserStaffId: finaliserId,
    editorStaffId: editorId,
    editorFullName: "Smoke Editor Medtech",
    paramAId: paramA.id,
    paramAOriginalValue,
    paramAEditedValue: 9.9,
  };
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function assertValidPdf(buf: Buffer, label: string): void {
  if (!buf.toString("latin1").startsWith("%PDF-")) {
    throw new Error(`${label} FAIL: output does not start with %PDF- header`);
  }
  if (buf.length < 2_000) {
    throw new Error(`${label} FAIL: rendered PDF suspiciously small (${buf.length} bytes)`);
  }
}

function assertEqual<T>(label: string, actual: T, expected: T): void {
  if (actual !== expected) {
    throw new Error(`${label} FAIL: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("Bootstrapping fixture…");
  const fx = await bootstrap();

  try {
    // -------------------------------------------------------------------
    // S1: original render, through the real loader.
    // -------------------------------------------------------------------
    const original = await loadResultDocumentInput(fx.resultId);
    const originalPdf = await renderResultPdf(original);
    writeFileSync("/tmp/drmed-chemistry-smoke-original.pdf", originalPdf);
    assertValidPdf(originalPdf, "S1");
    assertEqual("S1 reportGroup.code", original.reportGroup?.code, "CHEMISTRY");
    assertEqual(
      "S1 finalisedAt",
      original.finalisedAt?.toISOString(),
      fx.originalFinalisedAtIso,
    );
    assertEqual("S1 ageAsOf defaults to finalisedAt", original.ageAsOf?.toISOString(), fx.originalFinalisedAtIso);
    assertEqual(
      "S1 values[paramA]",
      original.values[fx.paramAId]?.numeric_value_si,
      fx.paramAOriginalValue,
    );
    console.log(
      `✓ S1 original render OK (${originalPdf.length} bytes; controlNo=${original.controlNo}, ` +
        `finalisedAt=${original.finalisedAt?.toISOString()})`,
    );

    // -------------------------------------------------------------------
    // S2: edit render — new values + new signer, NO finalisedAtOverride.
    // Mirrors what commitResultEdit renders before it writes anything (0172
    // §2): the PDF is drawn from the values about to be committed, the
    // editor's signature, and the ORIGINAL finalised_at as both the printed
    // date and the age-as-of instant.
    // -------------------------------------------------------------------
    const editedValues: ResultDocumentInput["values"] = {
      ...original.values,
      [fx.paramAId]: {
        ...original.values[fx.paramAId],
        numeric_value_si: fx.paramAEditedValue,
      },
    };
    const edited = await loadResultDocumentInput(fx.resultId, {
      valuesOverride: editedValues,
      signerStaffId: fx.editorStaffId,
    });
    const editedPdf = await renderResultPdf(edited);
    writeFileSync("/tmp/drmed-chemistry-smoke-edited.pdf", editedPdf);
    assertValidPdf(editedPdf, "S2");

    assertEqual("S2 controlNo unchanged", edited.controlNo, original.controlNo);
    assertEqual(
      "S2 finalisedAt stays the ORIGINAL report date",
      edited.finalisedAt?.toISOString(),
      fx.originalFinalisedAtIso,
    );
    assertEqual(
      "S2 ageAsOf stays the ORIGINAL report date",
      edited.ageAsOf?.toISOString(),
      fx.originalFinalisedAtIso,
    );
    assertEqual(
      "S2 values[paramA] reflects the override",
      edited.values[fx.paramAId]?.numeric_value_si,
      fx.paramAEditedValue,
    );
    if (edited.performer?.full_name !== fx.editorFullName) {
      throw new Error(
        `S2 FAIL: performer should be the editor ("${fx.editorFullName}"), got "${edited.performer?.full_name}"`,
      );
    }
    console.log(
      `✓ S2 edit render OK (${editedPdf.length} bytes; controlNo unchanged=${edited.controlNo === original.controlNo}, ` +
        `signer="${edited.performer?.full_name}", finalisedAt unchanged=${edited.finalisedAt?.toISOString() === fx.originalFinalisedAtIso})`,
    );

    // -------------------------------------------------------------------
    // S3: real env-var fail-fast — delete the var, call the real loader.
    // -------------------------------------------------------------------
    const savedPathologistId = process.env.CONSULTANT_PATHOLOGIST_STAFF_ID;
    delete process.env.CONSULTANT_PATHOLOGIST_STAFF_ID;
    let threw = false;
    let message = "";
    try {
      await loadResultDocumentInput(fx.resultId);
    } catch (err) {
      threw = true;
      message = err instanceof Error ? err.message : String(err);
    } finally {
      process.env.CONSULTANT_PATHOLOGIST_STAFF_ID = savedPathologistId;
    }
    if (!threw || !message.includes("CONSULTANT_PATHOLOGIST_STAFF_ID")) {
      throw new Error(
        `S3 FAIL: expected loadResultDocumentInput to throw naming CONSULTANT_PATHOLOGIST_STAFF_ID, ` +
          `threw=${threw}, message="${message}"`,
      );
    }
    console.log("✓ S3 env-var fail-fast OK (real loader, real throw)");
  } finally {
    await cleanup();
    console.log("Fixture cleaned up.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
