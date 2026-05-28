import { NextResponse } from "next/server";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { sectionsForRole } from "@/lib/auth/role-sections";

/**
 * Streams the released result PDF for a test_request to the requesting staff.
 *
 * Policy:
 *  - admin + pathologist: view any released result (sectionsForRole=null)
 *  - medtech: view results in their bench sections (chemistry/hematology/
 *    immunology/urinalysis/microbiology/send_out)
 *  - xray_technician: view imaging sections (imaging_xray/imaging_ultrasound)
 *  - reception: no access
 *
 * Logs every view to audit_log so a later access review can surface who
 * looked at what.
 *
 * 404 if the test_request has no released result with a stored PDF.
 * 403 if the staff role is not permitted to view this section.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ testRequestId: string }> },
) {
  const staff = await requireActiveStaff();
  const { testRequestId } = await params;

  const admin = createAdminClient();

  // Role gate: look up the service.section for this test_request and compare
  // to the role's allowed sections. null = unrestricted (admin/pathologist).
  const { data: tr } = await admin
    .from("test_requests")
    .select("id, services!inner ( section )")
    .eq("id", testRequestId)
    .maybeSingle();
  if (!tr) {
    return NextResponse.json({ error: "Test not found." }, { status: 404 });
  }
  const svc = (tr as { services: { section: string | null } | { section: string | null }[] | null }).services;
  const section =
    (Array.isArray(svc) ? svc[0]?.section : svc?.section) ?? null;
  const allowed = sectionsForRole(staff.role);
  if (allowed !== null) {
    if (allowed.length === 0 || !section || !allowed.includes(section as never)) {
      return NextResponse.json(
        { error: "You don't have access to this section." },
        { status: 403 },
      );
    }
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

  const { data: blob, error: dlErr } = await admin.storage
    .from("results")
    .download(resolved.storage_path);
  if (dlErr || !blob) {
    return NextResponse.json(
      { error: dlErr?.message ?? "Failed to fetch PDF." },
      { status: 502 },
    );
  }

  await audit({
    actor_id: staff.user_id,
    actor_type: "staff",
    action: "result.viewed_staff",
    resource_type: "test_request",
    resource_id: testRequestId,
    metadata: { result_id: resolved.id, role: staff.role },
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
