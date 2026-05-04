import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { loadTemplateParams } from "@/lib/results/loaders";
import { TemplateEditor } from "./template-editor";
import type { TemplateEditorPayload, TemplateParamPayload } from "@/lib/validations/result-template";

export const metadata = { title: "Edit result template — staff" };

interface Props {
  params: Promise<{ service_id: string }>;
}

export default async function EditResultTemplatePage({ params }: Props) {
  const session = await requireAdminStaff();
  if (session.role !== "admin") redirect("/staff");

  const { service_id } = await params;
  const admin = createAdminClient();

  const { data: svc } = await admin
    .from("services")
    .select("id, code, name, kind, is_send_out")
    .eq("id", service_id)
    .maybeSingle();
  if (!svc) notFound();

  if (svc.is_send_out) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
        <Link
          href="/staff/admin/result-templates"
          className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
        >
          ← Result templates
        </Link>
        <h1 className="mt-3 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          {svc.name}
        </h1>
        <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          This is a send-out service. Send-out tests use the partner-lab&apos;s
          PDF — they don&apos;t need a structured template. Mark{" "}
          <code>is_send_out = false</code> on the service if you want the
          medtech to enter values in-house.
        </p>
      </div>
    );
  }

  const { data: tpl } = await admin
    .from("result_templates")
    .select("id, layout, header_notes, footer_notes, is_active")
    .eq("service_id", service_id)
    .maybeSingle();

  const initialParams: TemplateParamPayload[] = tpl
    ? (await loadTemplateParams(admin, tpl.id)).map((p) => ({
        id: p.id,
        parameter_name: p.parameter_name,
        input_type: p.input_type,
        section: p.section,
        is_section_header: p.is_section_header,
        unit_si: p.unit_si,
        unit_conv: p.unit_conv,
        ref_low_si: p.ref_low_si,
        ref_high_si: p.ref_high_si,
        ref_low_conv: p.ref_low_conv,
        ref_high_conv: p.ref_high_conv,
        gender: p.gender,
        si_to_conv_factor: p.si_to_conv_factor,
        allowed_values: p.allowed_values,
        abnormal_values: p.abnormal_values,
        placeholder: p.placeholder,
        ranges: p.ranges.map((r) => ({
          id: r.id,
          band_label: r.band_label,
          age_min_months: r.age_min_months,
          age_max_months: r.age_max_months,
          gender: r.gender,
          ref_low_si: r.ref_low_si,
          ref_high_si: r.ref_high_si,
          ref_low_conv: r.ref_low_conv,
          ref_high_conv: r.ref_high_conv,
        })),
      }))
    : [];

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href="/staff/admin/result-templates"
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← Result templates
      </Link>
      <h1 className="mt-3 mb-4 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
        {tpl ? "Edit template" : "Create template"}
      </h1>

      <TemplateEditor
        serviceId={svc.id}
        serviceCode={svc.code}
        serviceName={svc.name}
        hasTemplate={!!tpl}
        initialLayout={(tpl?.layout ?? "simple") as TemplateEditorPayload["layout"]}
        initialHeaderNotes={tpl?.header_notes ?? null}
        initialFooterNotes={tpl?.footer_notes ?? null}
        initialIsActive={tpl?.is_active ?? true}
        initialParams={initialParams}
      />

    </div>
  );
}
