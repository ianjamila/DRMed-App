"use server";

import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { getPatientSession } from "@/lib/auth/patient-session-cookies";

export type DownloadResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

// Returns a 5-minute signed URL for a released test result. Verifies the
// patient session owns the visit AND the test is in 'released' status.
// Audit-logs both the access intent and a separate 'result.downloaded' so
// RA 10173 reporting can show every patient-facing result access.
export async function getPatientResultDownloadUrl(
  testRequestId: string,
): Promise<DownloadResult> {
  const session = await getPatientSession();
  if (!session) return { ok: false, error: "Session expired. Sign in again." };

  const admin = createAdminClient();

  const { data: testRow } = await admin
    .from("test_requests")
    .select(
      `
        id, status, visit_id,
        visits!inner ( id, patient_id ),
        results ( id, storage_path )
      `,
    )
    .eq("id", testRequestId)
    .maybeSingle();

  if (!testRow) {
    return { ok: false, error: "Result not found." };
  }
  const visit = Array.isArray(testRow.visits) ? testRow.visits[0] : testRow.visits;
  const result = Array.isArray(testRow.results) ? testRow.results[0] : testRow.results;
  if (!visit || visit.patient_id !== session.patient_id) {
    return { ok: false, error: "Result not found." };
  }
  if (testRow.status !== "released") {
    return { ok: false, error: "This result hasn't been released yet." };
  }
  if (!result) {
    return { ok: false, error: "No result file on this test." };
  }

  const { data: signed, error: signErr } = await admin.storage
    .from("results")
    .createSignedUrl(result.storage_path, 60 * 5);

  if (signErr || !signed?.signedUrl) {
    return {
      ok: false,
      error: signErr?.message ?? "Could not sign URL.",
    };
  }

  const h = await headers();
  await audit({
    actor_id: null,
    actor_type: "patient",
    patient_id: session.patient_id,
    action: "result.downloaded",
    resource_type: "result",
    resource_id: result.id,
    metadata: {
      test_request_id: testRequestId,
      visit_id: visit.id,
      drm_id: session.drm_id,
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  return { ok: true, url: signed.signedUrl };
}
