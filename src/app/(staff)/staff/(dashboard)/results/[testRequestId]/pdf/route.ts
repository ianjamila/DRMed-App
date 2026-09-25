import { NextResponse } from "next/server";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { canViewResultPdf } from "@/lib/visits/line-visibility";
import { isResultDownloadEligible } from "@/lib/results/release-eligibility";

/**
 * Streams the released result PDF for a test_request to the requesting staff.
 *
 * Policy:
 *  - admin + pathologist: view any released result (sectionsForRole=null)
 *  - medtech: view results in their bench sections (chemistry/hematology/
 *    immunology/urinalysis/microbiology/send_out)
 *  - xray_technician: view imaging sections (imaging_xray/imaging_ultrasound/imaging_ecg)
 *  - reception: RELEASED lab/imaging results only, so the counter can print
 *    the patient's copy (owner decision 2026-09-24) — never work still on
 *    the bench, never a doctor line
 *  The rule is canViewResultPdf() in lib/visits/line-visibility.ts; the visit
 *  page and the queue call it too, so they only offer what this answers.
 *
 * Logs every view to audit_log so a later access review can surface who
 * looked at what. `?print=1` (the Print buttons) logs `result.printed_staff`
 * instead of `result.viewed_staff` — a printed copy leaves the building, and
 * RA 10173 wants that disclosure told apart from a look on screen.
 *
 * 404 if the test_request has no released result with a stored PDF.
 * 403 if the staff role is not permitted to view this section.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ testRequestId: string }> },
) {
  const staff = await requireActiveStaff();
  const { testRequestId } = await params;

  const admin = createAdminClient();

  // Role gate: the line's section, status and kind decide it (see
  // canViewResultPdf). status and kind matter only to reception.
  const { data: tr } = await admin
    .from("test_requests")
    .select("id, status, services!inner ( section, kind ), visits!inner ( id, patient_id )")
    .eq("id", testRequestId)
    // Queue-deleted lines (0125), or lines on a deleted visit, stream no PDF.
    .is("deleted_at", null)
    .is("visits.deleted_at", null)
    .maybeSingle();
  if (!tr) {
    return NextResponse.json({ error: "Test not found." }, { status: 404 });
  }
  type SvcRow = { section: string | null; kind: string | null };
  const svcRel = (tr as { services: SvcRow | SvcRow[] | null }).services;
  const svc = Array.isArray(svcRel) ? svcRel[0] : svcRel;
  type VisitRow = { id: string; patient_id: string | null };
  const visitRel = (tr as { visits: VisitRow | VisitRow[] | null }).visits;
  const visit = Array.isArray(visitRel) ? visitRel[0] : visitRel;
  const line = {
    section: svc?.section ?? null,
    status: tr.status,
    kind: svc?.kind ?? null,
  };

  // First pass, on the line alone, before touching the result: with
  // reportReleased assumed true this is the most the role could ever be
  // allowed, so a refusal here is final. The file-level check (is EVERY test
  // on a shared PDF released?) runs below, once the result is known.
  if (!canViewResultPdf(staff.role, { ...line, reportReleased: true })) {
    return NextResponse.json(
      {
        error:
          staff.role !== "reception"
            ? "You don't have access to this section."
            : line.status !== "released"
              ? "This result hasn't been released yet."
              : "There is no result file to print for this line.",
      },
      { status: 403 },
    );
  }

  // result_test_requests is the junction; pull the linked result + its
  // storage_path. There may be more than one historical result for
  // amendments — take the most recent finalised one.
  const { data: link } = await admin
    .from("result_test_requests")
    .select(
      "result_id, results!inner ( id, storage_path, finalised_at, amendment_count )",
    )
    .eq("test_request_id", testRequestId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const result = link?.results as
    | { id: string; storage_path: string | null; finalised_at: string | null; amendment_count: number }
    | { id: string; storage_path: string | null; finalised_at: string | null; amendment_count: number }[]
    | null
    | undefined;
  const resolved = Array.isArray(result) ? result[0] : result;

  if (!resolved || !resolved.storage_path) {
    return NextResponse.json(
      { error: "No released PDF for this test." },
      { status: 404 },
    );
  }

  // Second pass, on the FILE: a consolidated chemistry report is one PDF
  // linked to every test in the panel, and release/undo are per line. If any
  // linked test is unreleased (never released, or withdrawn), the file still
  // carries its values — the portal refuses it for that reason
  // (release-eligibility.ts), and reception must too. Lab roles pass
  // regardless: they review their own unreleased work here.
  const reportReleased = await isResultDownloadEligible(admin, resolved.id);
  if (!canViewResultPdf(staff.role, { ...line, reportReleased })) {
    return NextResponse.json(
      {
        error:
          "Part of this report isn't released yet — ask the lab to release the rest before printing.",
      },
      { status: 403 },
    );
  }

  const { data: blob, error: dlErr } = await admin.storage
    .from("results")
    .download(resolved.storage_path);
  if (dlErr || !blob) {
    return NextResponse.json(
      { error: dlErr?.message ?? "Failed to fetch PDF." },
      { status: 502 },
    );
  }

  const printing = new URL(req.url).searchParams.get("print") === "1";
  await audit({
    actor_id: staff.user_id,
    actor_type: "staff",
    // Who the disclosed result belongs to, so an access review by patient
    // finds staff views and prints next to the patient's own downloads.
    patient_id: visit?.patient_id ?? null,
    action: printing ? "result.printed_staff" : "result.viewed_staff",
    resource_type: "test_request",
    resource_id: testRequestId,
    // amendment_count: which version of the file went out, so the
    // "Printed …" note resets when an amended PDF replaces it.
    metadata: { result_id: resolved.id, amendment_count: resolved.amendment_count, role: staff.role },
  });

  const bytes = new Uint8Array(await blob.arrayBuffer());
  return new NextResponse(bytes, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="result-${testRequestId.slice(0, 8)}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
