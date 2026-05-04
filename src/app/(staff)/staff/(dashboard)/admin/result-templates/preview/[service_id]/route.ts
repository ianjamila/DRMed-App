// GET /staff/admin/result-templates/preview/[service_id]
// Renders a sample PDF for the template attached to `service_id`, populated
// with synthesised placeholder values, and returns it inline so the browser
// preview tab displays it directly. Admin-only — pathologists / medtechs use
// the medtech queue flow to see real values.

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { renderResultPdf } from "@/lib/results/render-pdf";
import { buildPreviewValues } from "@/lib/results/preview-data";
import type {
  ResultDocumentInput,
  ResultLayout,
  TemplateParam,
} from "@/lib/results/types";

export const runtime = "nodejs";

interface Props {
  params: Promise<{ service_id: string }>;
}

export async function GET(_req: Request, { params }: Props) {
  const session = await requireActiveStaff();
  if (session.role !== "admin") {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const { service_id } = await params;
  const supabase = await createClient();

  const { data: service } = await supabase
    .from("services")
    .select("id, code, name")
    .eq("id", service_id)
    .maybeSingle();
  if (!service) {
    return new NextResponse("Service not found", { status: 404 });
  }

  const { data: template } = await supabase
    .from("result_templates")
    .select("id, layout, header_notes, footer_notes")
    .eq("service_id", service_id)
    .maybeSingle();
  if (!template) {
    return new NextResponse(
      "No template configured for this service yet.",
      { status: 404 },
    );
  }

  const { data: paramRows } = await supabase
    .from("result_template_params")
    .select(
      "id, sort_order, section, is_section_header, parameter_name, input_type, unit_si, unit_conv, ref_low_si, ref_high_si, ref_low_conv, ref_high_conv, gender, si_to_conv_factor, allowed_values, abnormal_values, placeholder",
    )
    .eq("template_id", template.id)
    .order("sort_order", { ascending: true });

  const params2: TemplateParam[] = (paramRows ?? []).map((r) => ({
    id: r.id,
    sort_order: r.sort_order,
    section: r.section,
    is_section_header: r.is_section_header,
    parameter_name: r.parameter_name,
    input_type: r.input_type as TemplateParam["input_type"],
    unit_si: r.unit_si,
    unit_conv: r.unit_conv,
    ref_low_si: r.ref_low_si,
    ref_high_si: r.ref_high_si,
    ref_low_conv: r.ref_low_conv,
    ref_high_conv: r.ref_high_conv,
    gender: (r.gender ?? null) as TemplateParam["gender"],
    si_to_conv_factor: r.si_to_conv_factor,
    allowed_values: r.allowed_values,
    abnormal_values: r.abnormal_values,
    placeholder: r.placeholder,
  }));

  const values = buildPreviewValues(params2);

  const input: ResultDocumentInput = {
    template: {
      layout: template.layout as ResultLayout,
      header_notes: template.header_notes,
      footer_notes: template.footer_notes,
    },
    params: params2,
    values,
    service: { code: service.code, name: service.name },
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
    isPreview: true,
  };

  const pdf = await renderResultPdf(input);

  return new NextResponse(pdf as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${service.code}-preview.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}
