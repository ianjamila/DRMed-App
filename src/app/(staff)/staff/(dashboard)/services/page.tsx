import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { formatPhp } from "@/lib/marketing/format";

export const metadata = {
  title: "Services — staff",
};

export default async function ServicesAdminPage() {
  await requireAdminStaff();
  const supabase = await createClient();
  const { data: services } = await supabase
    .from("services")
    .select("id, code, name, price_php, turnaround_hours, is_active, requires_signoff")
    .order("name", { ascending: true });

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            Services
          </h1>
          <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
            Catalog of tests and clinical services. Inactive entries are
            hidden from the marketing site but still usable on existing
            visits.
          </p>
        </div>
        <Link
          href="/staff/services/new"
          className="rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold text-white hover:bg-[color:var(--color-brand-cyan)]"
        >
          + New service
        </Link>
      </header>

      <div className="overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        <table className="w-full text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-4 py-3">Code</th>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Price</th>
              <th className="px-4 py-3">Turnaround</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {(services ?? []).length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                >
                  No services yet.
                </td>
              </tr>
            ) : (
              (services ?? []).map((s) => (
                <tr
                  key={s.id}
                  className="hover:bg-[color:var(--color-brand-bg)]"
                >
                  <td className="px-4 py-3 font-mono text-[color:var(--color-brand-text-mid)]">
                    {s.code}
                  </td>
                  <td className="px-4 py-3 font-semibold text-[color:var(--color-brand-navy)]">
                    {s.name}
                    {s.requires_signoff ? (
                      <span className="ml-2 rounded-md bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-amber-900">
                        Signoff
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">{formatPhp(s.price_php)}</td>
                  <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                    {s.turnaround_hours ? `${s.turnaround_hours}h` : "—"}
                  </td>
                  <td className="px-4 py-3">
                    {s.is_active ? (
                      <span className="rounded-md bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-900">
                        Active
                      </span>
                    ) : (
                      <span className="rounded-md bg-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-700">
                        Inactive
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/staff/services/${s.id}/edit`}
                      className="text-xs font-bold text-[color:var(--color-brand-cyan)] hover:underline"
                    >
                      Edit →
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
