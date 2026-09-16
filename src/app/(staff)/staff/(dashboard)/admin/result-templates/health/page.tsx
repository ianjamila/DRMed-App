import Link from "next/link";
import { PageHeader } from "@/components/staff/page-header";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createClient } from "@/lib/supabase/server";
import { collectTemplateHealthFindings } from "@/lib/results/collect-template-health";

export const metadata = { title: "Template Health" };
export const dynamic = "force-dynamic";

const SEVERITIES = [
  { severity: "error", label: "Broken" },
  { severity: "warning", label: "Warning" },
  { severity: "info", label: "Informational" },
] as const;

export default async function TemplateHealthPage() {
  await requireAdminStaff();
  const supabase = await createClient();
  const { findings } = await collectTemplateHealthFindings(supabase);

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title="Template Health"
        subtitle="Current report-group template findings. Broken templates and warnings need attention; informational findings include retained template history."
      />
      <Link
        href="/staff/admin/result-templates"
        className="text-sm font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
      >
        Result Templates
      </Link>

      {findings.length === 0 ? (
        <p className="mt-8 rounded-lg border border-dashed border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-3 text-sm text-[color:var(--color-brand-text-soft)]">
          No template-health findings. All report-group template checks passed.
        </p>
      ) : (
        SEVERITIES.map(({ severity, label }) => {
          const matching = findings.filter((f) => f.severity === severity);
          return (
            <section key={severity} className="mt-8" aria-labelledby={`health-${severity}`}>
              <h2 id={`health-${severity}`} className="font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]">
                {label} ({matching.length})
              </h2>
              {matching.length === 0 ? (
                <p className="mt-3 text-sm text-[color:var(--color-brand-text-soft)]">No findings.</p>
              ) : (
                <ul className="mt-3 divide-y divide-[color:var(--color-brand-bg-mid)] rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
                  {matching.map((finding) => (
                    <li key={`${finding.type}-${finding.group_id}-${finding.template_id}-${finding.service_id ?? finding.param_id ?? ""}`} className="px-4 py-3">
                      <Link
                        href={`/staff/admin/result-templates/group/${finding.group_id}/edit`}
                        className="font-semibold text-[color:var(--color-brand-navy)] hover:underline"
                      >
                        {finding.group_name}
                      </Link>
                      {finding.service_code ? (
                        <p className="mt-1 break-words font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                          {finding.service_code}
                        </p>
                      ) : null}
                      <p className="mt-2 text-sm text-[color:var(--color-brand-text-mid)]">
                        {finding.message}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })
      )}
    </div>
  );
}
