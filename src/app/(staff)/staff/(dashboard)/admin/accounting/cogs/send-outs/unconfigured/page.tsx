import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import Link from "next/link";

export const metadata = { title: "Unconfigured Send-outs — DRMed" };
export const dynamic = "force-dynamic";

export default async function UnconfiguredPage() {
  await requireAdminStaff();
  const admin = createAdminClient();

  const { data: services } = await admin
    .from("services")
    .select("id, code, name, kind, send_out_unit_cost_php, send_out_vendor_id")
    .eq("is_send_out", true)
    .or("send_out_unit_cost_php.is.null,send_out_unit_cost_php.eq.0")
    .order("code");

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          Phase 12.5 · Admin · Accounting
        </p>
        <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Unconfigured Send-out Services
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
          These send-out services are missing a unit cost. Releases accrue at
          zero cost (a row is still recorded for visibility). Configure unit cost
          and vendor so future releases book correctly.
        </p>
      </header>

      {!services || services.length === 0 ? (
        <div className="rounded-md border border-[color:var(--color-brand-border)] bg-[color:var(--color-brand-bg)] p-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
          All send-out services have unit costs configured.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-[color:var(--color-brand-border)]">
          <table className="w-full text-sm">
            <thead className="bg-[color:var(--color-brand-bg)] text-[color:var(--color-brand-text-soft)]">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Code</th>
                <th className="px-4 py-3 text-left font-medium">Name</th>
                <th className="px-4 py-3 text-left font-medium">Kind</th>
                <th className="px-4 py-3 text-right font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--color-brand-border)]">
              {services.map((s) => (
                <tr
                  key={s.id}
                  className="hover:bg-[color:var(--color-brand-bg)]/50"
                >
                  <td className="px-4 py-3 font-mono text-xs">{s.code}</td>
                  <td className="px-4 py-3 font-medium">{s.name}</td>
                  <td className="px-4 py-3 capitalize text-[color:var(--color-brand-text-soft)]">
                    {s.kind?.replace(/_/g, " ") ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/staff/admin/services/${s.id}/edit`}
                      className="text-xs font-medium text-[color:var(--color-brand-cyan)] hover:underline"
                    >
                      Configure
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-4">
        <Link
          href="/staff/admin/accounting/cogs/send-outs"
          className="text-sm text-[color:var(--color-brand-cyan)] hover:underline"
        >
          ← Back to Send-out COGS
        </Link>
      </div>
    </div>
  );
}
