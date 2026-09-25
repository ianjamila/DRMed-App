import { NextResponse } from "next/server";
import { PDFDocument } from "pdf-lib";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { printAllFiles, resultPdfStates } from "@/lib/results/pdf-availability";

/**
 * "Print all released results": every released report on a visit, combined
 * into ONE PDF, so a patient collecting several results gets them in one
 * print instead of one tab per report.
 *
 * Which files: printAllFiles — released lines whose WHOLE file is released
 * and which this role may open (canViewResultPdf, the same rule as the
 * single-result route), each file once, in the visit's line order.
 *
 * Audit: one `result.printed_staff` (or `result.viewed_staff` without
 * `?print=1`) row per FILE in the bundle, shaped like the single-result
 * route's (resource = a test line on that file, metadata.result_id) so the
 * per-file "Printed …" note counts it once, plus metadata.test_request_ids
 * naming every line of this visit on that file — the normalized shape the
 * patient download rows use — metadata.amendment_count (the file version,
 * for the note) and metadata.bundle marking it as Print all.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const staff = await requireActiveStaff();
  const { id: visitId } = await params;
  const admin = createAdminClient();

  const { data: visit } = await admin
    .from("visits")
    .select("id, patient_id, visit_number")
    .eq("id", visitId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!visit) {
    return NextResponse.json({ error: "Visit not found." }, { status: 404 });
  }

  // Live lines of a live visit only (0125: a deleted line streams no PDF).
  const { data: tests } = await admin
    .from("test_requests")
    .select("id, status, services!inner ( section, kind ), visits!inner ( deleted_at )")
    .eq("visit_id", visitId)
    .is("deleted_at", null)
    .is("visits.deleted_at", null)
    .order("requested_at", { ascending: true })
    .order("id", { ascending: true });

  type SvcRow = { section: string | null; kind: string | null };
  const lines = (tests ?? []).map((t) => {
    const rel = (t as { services: SvcRow | SvcRow[] | null }).services;
    const svc = Array.isArray(rel) ? rel[0] : rel;
    return {
      id: t.id,
      status: t.status,
      section: svc?.section ?? null,
      kind: svc?.kind ?? null,
      deleted: false,
    };
  });
  const states = await resultPdfStates(admin, lines.map((l) => l.id));
  const files = printAllFiles(staff.role, lines, states);
  if (files.length === 0) {
    return NextResponse.json(
      { error: "No released results to print on this visit." },
      { status: 404 },
    );
  }

  const { data: results } = await admin
    .from("results")
    .select("id, storage_path, amendment_count")
    .in("id", files.map((f) => f.resultId));
  const pathById = new Map((results ?? []).map((r) => [r.id, r.storage_path]));
  const versionById = new Map((results ?? []).map((r) => [r.id, r.amendment_count]));

  const merged = await PDFDocument.create();
  for (const file of files) {
    const path = pathById.get(file.resultId);
    if (!path) {
      return NextResponse.json({ error: "A result file is missing — print them one by one." }, { status: 502 });
    }
    const { data: blob, error } = await admin.storage.from("results").download(path);
    if (error || !blob) {
      return NextResponse.json({ error: "Failed to fetch a result file. Try again." }, { status: 502 });
    }
    try {
      // No ignoreEncryption: pdf-lib cannot decrypt, and copying an
      // encrypted outside-lab PDF's raw streams yields blank pages. It throws
      // instead, and the counter prints that one from its own button.
      const doc = await PDFDocument.load(await blob.arrayBuffer());
      const pages = await merged.copyPages(doc, doc.getPageIndices());
      for (const p of pages) merged.addPage(p);
    } catch {
      return NextResponse.json(
        { error: "One report couldn't be combined — print them one by one." },
        { status: 502 },
      );
    }
  }
  const bytes = await merged.save();

  const printing = new URL(req.url).searchParams.get("print") === "1";
  for (const file of files) {
    await audit({
      actor_id: staff.user_id,
      actor_type: "staff",
      patient_id: visit.patient_id,
      action: printing ? "result.printed_staff" : "result.viewed_staff",
      resource_type: "test_request",
      resource_id: file.testIds[0],
      metadata: {
        result_id: file.resultId,
        amendment_count: versionById.get(file.resultId) ?? 0,
        test_request_ids: file.testIds,
        role: staff.role,
        bundle: true,
        visit_id: visitId,
      },
    });
  }

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="results-visit-${visit.visit_number ?? visitId.slice(0, 8)}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
