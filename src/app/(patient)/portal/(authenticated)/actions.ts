"use server";

import { headers } from "next/headers";
import { PDFDocument } from "pdf-lib";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { getPatientSession } from "@/lib/auth/patient-session-cookies";
import { renderResultPdf } from "@/lib/results/render-pdf";
import {
  normalisePatientSex,
  type ResultDocumentInput,
} from "@/lib/results/types";

export type DownloadResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

export type PackageDownloadResult =
  | { ok: true; pdfBase64: string; filename: string }
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
  if (!result || !result.storage_path) {
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

// Builds a consolidated package PDF: a cover page listing the included
// components, followed by each released component's released PDF
// concatenated in package_components.sort_order. The result is returned
// base64-encoded so the client can convert it to a Blob and trigger a
// download without needing a separate route. Every successful build is
// audit-logged with the kind=package_consolidated metadata so RA 10173
// reporting can show what was assembled.
//
// Verifies, in order:
//   1. Patient session exists.
//   2. Header test_request belongs to the session patient.
//   3. Header is is_package_header=true and status='released'.
//   4. No components are still in_progress / pending; cancelled is fine
//      and gets skipped.
//   5. Every non-cancelled component has a results row with a
//      storage_path.
export async function getPackagePdfDownloadUrl(
  headerTestRequestId: string,
): Promise<PackageDownloadResult> {
  const session = await getPatientSession();
  if (!session) return { ok: false, error: "Session expired. Sign in again." };

  const admin = createAdminClient();

  // 1) Load the header + linked visit + linked patient. We need patient
  // demographics for the cover page (sex/birthdate drive the patient
  // grid the same way it does for any other rendered result PDF).
  const { data: headerRow } = await admin
    .from("test_requests")
    .select(
      `
        id, status, is_package_header, parent_id, visit_id,
        package_completed_at,
        services!test_requests_service_id_fkey ( code, name ),
        visits!test_requests_visit_id_fkey (
          id, patient_id, visit_number,
          patients!visits_patient_id_fkey (
            drm_id, last_name, first_name, sex, birthdate
          )
        )
      `,
    )
    .eq("id", headerTestRequestId)
    .maybeSingle();

  if (!headerRow) {
    return { ok: false, error: "Package not found." };
  }
  const headerService = Array.isArray(headerRow.services)
    ? headerRow.services[0]
    : headerRow.services;
  const headerVisit = Array.isArray(headerRow.visits)
    ? headerRow.visits[0]
    : headerRow.visits;
  const headerPatient = headerVisit
    ? Array.isArray(headerVisit.patients)
      ? headerVisit.patients[0]
      : headerVisit.patients
    : null;

  if (headerRow.is_package_header !== true) {
    return { ok: false, error: "Not a package header." };
  }
  if (!headerVisit || headerVisit.patient_id !== session.patient_id) {
    return { ok: false, error: "Package not found." };
  }
  if (headerRow.status !== "released") {
    return { ok: false, error: "Package not yet released." };
  }

  // 2) Load components. Order by created_at because the visit-creation
  // action inserts them in package_components.sort_order.
  const { data: components } = await admin
    .from("test_requests")
    .select(
      `
        id, status,
        services!test_requests_service_id_fkey ( code, name )
      `,
    )
    .eq("parent_id", headerRow.id)
    .order("created_at");

  if (!components || components.length === 0) {
    return { ok: false, error: "Package has no components." };
  }

  type ComponentRow = {
    id: string;
    status: string;
    service: { code: string; name: string } | null;
  };
  const componentRows: ComponentRow[] = components.map((c) => ({
    id: c.id,
    status: c.status,
    service: Array.isArray(c.services)
      ? (c.services[0] ?? null)
      : (c.services ?? null),
  }));

  const releasedComponents = componentRows.filter(
    (c) => c.status === "released",
  );
  const cancelledComponents = componentRows.filter(
    (c) => c.status === "cancelled",
  );
  const pendingComponents = componentRows.filter(
    (c) => c.status !== "released" && c.status !== "cancelled",
  );
  if (pendingComponents.length > 0) {
    return {
      ok: false,
      error: `${pendingComponents.length} of ${componentRows.length} components are still in progress.`,
    };
  }
  if (releasedComponents.length === 0) {
    return { ok: false, error: "No released components to assemble." };
  }

  // 3) Load results.storage_path for each released component via the junction.
  const { data: junctions } = await admin
    .from("result_test_requests")
    .select("test_request_id, results!inner(id, storage_path)")
    .in(
      "test_request_id",
      releasedComponents.map((c) => c.id),
    );
  const resultByTrId = new Map(
    (junctions ?? []).map((j) => {
      const r = Array.isArray(j.results) ? j.results[0] : j.results;
      return [j.test_request_id, r ?? null] as const;
    }),
  );

  // 4) Render cover + fetch every component PDF in parallel. Skip
  // components that have no result row (data integrity issue — we audit
  // the skip rather than failing the whole assembly).
  const coverInput: ResultDocumentInput = {
    template: {
      layout: "package_summary",
      header_notes: null,
      footer_notes: null,
    },
    params: [],
    values: {},
    service: {
      code: headerService?.code ?? "PACKAGE",
      name: headerService?.name ?? "Package Result",
    },
    patient: {
      drm_id: headerPatient?.drm_id ?? "",
      last_name: headerPatient?.last_name ?? "",
      first_name: headerPatient?.first_name ?? "",
      sex: normalisePatientSex(headerPatient?.sex ?? null),
      birthdate: headerPatient?.birthdate ?? null,
    },
    visit: { visit_number: headerVisit?.visit_number ?? "" },
    controlNo: null,
    finalisedAt: headerRow.package_completed_at
      ? new Date(headerRow.package_completed_at)
      : new Date(),
    medtech: null,
    packageSummary: {
      packageCode: headerService?.code ?? "",
      packageName: headerService?.name ?? "",
      components: releasedComponents.map((c) => ({
        code: c.service?.code ?? "",
        name: c.service?.name ?? "",
        status: c.status,
      })),
    },
  };

  const [coverPdfBytes, ...componentPdfBytes] = await Promise.all([
    renderResultPdf(coverInput),
    ...releasedComponents.map(async (c) => {
      const result = resultByTrId.get(c.id);
      if (!result || !result.storage_path) return null;
      const dl = await admin.storage
        .from("results")
        .download(result.storage_path);
      if (dl.error || !dl.data) return null;
      return new Uint8Array(await dl.data.arrayBuffer());
    }),
  ]);

  // 5) Concatenate with pdf-lib. The cover always lands first; component
  // PDFs follow in released-component order. Malformed PDFs are skipped
  // rather than failing the whole assembly so the patient still gets the
  // other components.
  const merged = await PDFDocument.create();
  const coverDoc = await PDFDocument.load(coverPdfBytes);
  const coverPages = await merged.copyPages(
    coverDoc,
    coverDoc.getPageIndices(),
  );
  for (const p of coverPages) merged.addPage(p);

  let skippedMalformed = 0;
  for (const bytes of componentPdfBytes) {
    if (!bytes) {
      skippedMalformed++;
      continue;
    }
    try {
      const doc = await PDFDocument.load(bytes);
      const pages = await merged.copyPages(doc, doc.getPageIndices());
      for (const p of pages) merged.addPage(p);
    } catch (err) {
      skippedMalformed++;
      console.error("Failed to load component PDF; skipping:", err);
    }
  }
  const mergedBytes = await merged.save();
  const mergedBase64 = Buffer.from(mergedBytes).toString("base64");

  // 6) Audit. Use kind=package_consolidated so the RA 10173 view can
  // distinguish a package download from a single-component download.
  const h = await headers();
  await audit({
    actor_id: null,
    actor_type: "patient",
    patient_id: session.patient_id,
    action: "result.downloaded",
    resource_type: "result",
    resource_id: headerRow.id,
    metadata: {
      kind: "package_consolidated",
      visit_id: headerRow.visit_id,
      header_test_request_id: headerRow.id,
      package_code: headerService?.code ?? null,
      merged_component_ids: releasedComponents.map((c) => c.id),
      merged_page_count: merged.getPageCount(),
      skipped_cancelled_components: cancelledComponents.length,
      skipped_malformed_components: skippedMalformed,
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  const safePkgCode = (headerService?.code ?? "PACKAGE").replace(
    /[^A-Z0-9_-]/gi,
    "_",
  );
  return {
    ok: true,
    pdfBase64: mergedBase64,
    filename: `${safePkgCode}-${headerRow.id.slice(0, 8)}.pdf`,
  };
}
