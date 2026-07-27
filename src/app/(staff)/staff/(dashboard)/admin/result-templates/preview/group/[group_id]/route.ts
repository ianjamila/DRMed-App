// GET /staff/admin/result-templates/preview/group/[group_id]
// Sample PDF for a report-group (consolidated) template with synthesised
// values. Mirrors the per-service preview route; populates
// ResultDocumentInput.reportGroup — the same path real consolidated results
// use — instead of `service`.

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { renderResultPdf } from "@/lib/results/render-pdf";
import { buildPreviewValues } from "@/lib/results/preview-data";
import { loadTemplateParams } from "@/lib/results/loaders";
import { loadConsultantSignatures, resolvePerformer } from "@/lib/results/signatures";
import type {
  ResultDocumentInput,
  ResultLayout,
} from "@/lib/results/types";

export const runtime = "nodejs";

interface Props {
  params: Promise<{ group_id: string }>;
}

export async function GET(_req: Request, { params }: Props) {
  const session = await requireActiveStaff();
  if (session.role !== "admin") {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const { group_id } = await params;
  const supabase = await createClient();

  const { data: group } = await supabase
    .from("report_groups")
    .select("id, code, name")
    .eq("id", group_id)
    .maybeSingle();
  if (!group) {
    return new NextResponse("Report group not found", { status: 404 });
  }

  const { data: template } = await supabase
    .from("result_templates")
    .select("id, layout, header_notes, footer_notes")
    .eq("report_group_id", group_id)
    .maybeSingle();
  if (!template) {
    return new NextResponse(
      "No template configured for this report group yet.",
      { status: 404 },
    );
  }

  const { data: services } = await supabase
    .from("services")
    .select("code, name, is_active")
    .eq("report_group_id", group_id)
    .order("code", { ascending: true });

  const templateParams = await loadTemplateParams(supabase, template.id);
  const values = buildPreviewValues(templateParams);

  const consultants = await loadConsultantSignatures();
  const performer = await resolvePerformer({
    service: { code: group.code, kind: null },
    finalisedByStaffId: null,
  });

  const input: ResultDocumentInput = {
    template: {
      layout: template.layout as ResultLayout,
      header_notes: template.header_notes,
      footer_notes: template.footer_notes,
    },
    params: templateParams,
    values,
    reportGroup: {
      code: group.code,
      name: group.name,
      orderedTests: (services ?? [])
        .filter((s) => s.is_active)
        .map((s) => ({ code: s.code, name: s.name })),
    },
    patient: {
      drm_id: "DRM-PREVIEW",
      last_name: "DOE",
      first_name: "JANE",
      sex: "F",
      birthdate: "1985-04-12",
    },
    visit: { visit_number: "PREVIEW" },
    controlNo: null,
    finalisedAt: null,
    medtech: {
      full_name: session.full_name,
      prc_license_kind: null,
      prc_license_no: null,
    },
    performer,
    consultantPathologist: consultants.pathologist,
    isPreview: true,
  };

  const pdf = await renderResultPdf(input);

  return new NextResponse(pdf as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${group.code}-preview.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}
