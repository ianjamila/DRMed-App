import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { formatPhp } from "@/lib/marketing/format";
import { ServiceForm } from "../../service-form";

export const metadata = {
  title: "Edit service — staff",
};

interface Props {
  params: Promise<{ id: string }>;
}

const HISTORY_LIMIT = 20;

const DATE_TIME_FMT = new Intl.DateTimeFormat("en-PH", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Manila",
});

export default async function EditServicePage({ params }: Props) {
  await requireAdminStaff();
  const { id } = await params;
  const supabase = await createClient();
  const { data: service } = await supabase
    .from("services")
    .select(
      "id, code, name, description, price_php, hmo_price_php, senior_discount_php, turnaround_hours, kind, section, is_send_out, send_out_lab, is_active, requires_signoff",
    )
    .eq("id", id)
    .maybeSingle();

  if (!service) notFound();

  // Service-role client so we can join auth.users for the changer's name.
  // Read-only here; the page is admin-gated.
  const admin = createAdminClient();
  const { data: history } = await admin
    .from("service_price_history")
    .select(
      "id, price_php, hmo_price_php, senior_discount_php, effective_from, changed_by, change_reason",
    )
    .eq("service_id", id)
    .order("effective_from", { ascending: false })
    .limit(HISTORY_LIMIT);

  // Resolve changed_by ids → staff names for the audit trail.
  const changerIds = Array.from(
    new Set(
      (history ?? [])
        .map((h) => h.changed_by)
        .filter((v): v is string => !!v),
    ),
  );
  const nameById = new Map<string, string>();
  if (changerIds.length > 0) {
    const { data: staff } = await admin
      .from("staff_profiles")
      .select("id, full_name")
      .in("id", changerIds);
    for (const s of staff ?? []) nameById.set(s.id, s.full_name);
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href="/staff/services"
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← Services
      </Link>
      <h1 className="mt-3 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
        Edit service
      </h1>
      <p className="mt-1 font-mono text-xs text-[color:var(--color-brand-text-soft)]">
        {service.code}
      </p>

      <div className="mt-6 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6">
        <ServiceForm initial={service} />
      </div>

      <section className="mt-8">
        <h2 className="font-[family-name:var(--font-heading)] text-lg font-extrabold text-[color:var(--color-brand-navy)]">
          Price history
        </h2>
        <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
          Every price change is recorded automatically. Showing the most recent{" "}
          {HISTORY_LIMIT}.
        </p>
        <div className="mt-3 overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              <tr>
                <th className="px-4 py-3">When</th>
                <th className="px-4 py-3 text-right">DRMed</th>
                <th className="px-4 py-3 text-right">HMO</th>
                <th className="px-4 py-3 text-right">Senior disc.</th>
                <th className="px-4 py-3">By</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
              {(history ?? []).length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    className="px-4 py-6 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                  >
                    No history yet.
                  </td>
                </tr>
              ) : (
                (history ?? []).map((h) => (
                  <tr key={h.id}>
                    <td className="px-4 py-2 text-[color:var(--color-brand-text-mid)]">
                      {DATE_TIME_FMT.format(new Date(h.effective_from))}
                    </td>
                    <td className="px-4 py-2 text-right font-semibold text-[color:var(--color-brand-navy)]">
                      {h.price_php != null ? formatPhp(h.price_php) : "—"}
                    </td>
                    <td className="px-4 py-2 text-right text-[color:var(--color-brand-text-mid)]">
                      {h.hmo_price_php != null
                        ? formatPhp(h.hmo_price_php)
                        : "—"}
                    </td>
                    <td className="px-4 py-2 text-right text-[color:var(--color-brand-text-mid)]">
                      {h.senior_discount_php != null
                        ? formatPhp(h.senior_discount_php)
                        : "—"}
                    </td>
                    <td className="px-4 py-2 text-xs text-[color:var(--color-brand-text-soft)]">
                      {h.changed_by
                        ? (nameById.get(h.changed_by) ?? "Unknown staff")
                        : (h.change_reason ?? "System")}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
