import { NextResponse } from "next/server";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit/log";
import { canViewResultPdf } from "@/lib/visits/line-visibility";
import { isResultDownloadEligible } from "@/lib/results/release-eligibility";

/**
 * Streams a result PDF for a test_request to the requesting staff.
 *
 * This serves ANY result with a stored PDF, not only released ones — staff
 * review before release is intended (a medtech or pathologist opens the PDF
 * on a `result_uploaded` / `ready_for_release` line before it is released,
 * e.g. from the queue or the consolidated report cards). The gate below is
 * the section check, not the test's status.
 *
 * Policy:
 *  - admin + pathologist: view any result in any section (sectionsForRole=null)
 *  - medtech: view results in their bench sections (chemistry/hematology/
 *    immunology/urinalysis/microbiology/send_out)
 *  - xray_technician: view imaging sections (imaging_xray/imaging_ultrasound/imaging_ecg)
 *  - reception: RELEASED lab/imaging results only, so the counter can print
 *    the patient's copy (owner decision 2026-09-24) — never work still on
 *    the bench, never a doctor line
 *  The rule is canViewResultPdf() in lib/visits/line-visibility.ts; the visit
 *  page and the queue call it too, so they only offer what this answers.
 *
 * `?version=N` serves a REPLACED version instead of the current PDF: 1 ≤ N ≤
 * amendment_count serves the PDF that amendment #N's edit overwrote (its
 * `prior_storage_path`); absent, or N equal to amendment_count + 1, serves the
 * current PDF; anything else 404s. A versioned request additionally requires
 * `staff_can_read_finished_result` (0172) to pass over the signed-in staff
 * client — the same rule the chemistry edit path gates on: every linked test
 * (deleted ones included) inside the caller's sections, and every LIVE linked
 * test finished. That keeps a medtech from reading edit history for a report
 * outside their bench even though the current-PDF path above only checks the
 * single test's section.
 *
 * Logs every view to audit_log so a later access review can surface who
 * looked at what. `?print=1` (the Print buttons) logs `result.printed_staff`
 * instead of `result.viewed_staff` — a printed copy leaves the building, and
 * RA 10173 wants that disclosure told apart from a look on screen.
 *
 * 404 if the test_request has no result with a stored PDF, or `version` is
 * malformed / out of range.
 * 403 if the staff role is not permitted to view this section, or (for a
 * versioned request) fails `staff_can_read_finished_result`.
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

  // ?version=N — strictly a positive integer, no leading zeros / decimals /
  // sign. Anything else (including "0", "1.5", "-1", "abc") 404s rather than
  // silently falling back to the current PDF.
  const rawVersion = new URL(req.url).searchParams.get("version");
  let requestedVersion: number | null = null;
  if (rawVersion !== null) {
    if (!/^[1-9]\d*$/.test(rawVersion)) {
      return NextResponse.json({ error: "Invalid version." }, { status: 404 });
    }
    requestedVersion = Number(rawVersion);
  }

  const currentVersion = resolved.amendment_count + 1;
  const isCurrent = requestedVersion === null || requestedVersion === currentVersion;
  let storagePath = resolved.storage_path;

  if (!isCurrent) {
    if (requestedVersion! < 1 || requestedVersion! > resolved.amendment_count) {
      return NextResponse.json({ error: "Invalid version." }, { status: 404 });
    }

    // Same rule as editing (0172, §R3): every linked test — deleted ones
    // included — inside the caller's sections, and every LIVE linked test
    // finished. The section check above only proved THIS test's section, not
    // every member of a shared combined report, so a versioned request needs
    // the stronger gate. Read through the signed-in client: RLS on
    // result_amendments now enforces this same function (0172), so a signed-
    // in read and a service-role read after the RPC check are equivalent —
    // the signed-in client is used here to keep one code path for both.
    const supabase = await createClient();
    const { data: canRead } = await supabase.rpc(
      "staff_can_read_finished_result",
      { p_result_id: resolved.id },
    );
    if (!canRead) {
      return NextResponse.json(
        { error: "You don't have access to this section." },
        { status: 403 },
      );
    }

    const { data: amendment } = await supabase
      .from("result_amendments")
      .select("prior_storage_path")
      .eq("result_id", resolved.id)
      .eq("amendment_seq", requestedVersion!)
      .maybeSingle();
    if (!amendment) {
      return NextResponse.json({ error: "Invalid version." }, { status: 404 });
    }
    storagePath = amendment.prior_storage_path;
  }

  const { data: blob, error: dlErr } = await admin.storage
    .from("results")
    .download(storagePath);
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
    // "Printed …" note resets when an amended PDF replaces it. version /
    // is_current: which version THIS request served (?version=N, 0172).
    metadata: {
      result_id: resolved.id,
      amendment_count: resolved.amendment_count,
      role: staff.role,
      version: requestedVersion ?? currentVersion,
      is_current: isCurrent,
    },
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
