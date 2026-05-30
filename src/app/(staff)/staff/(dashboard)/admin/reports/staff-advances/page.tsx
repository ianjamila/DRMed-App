import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";

export const metadata = { title: "Staff advances — staff" };
export const dynamic = "force-dynamic";

const PESO = (n: number) =>
  new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(n);

export default async function StaffAdvancesPage() {
  await requireAdminStaff();
  const admin = createAdminClient();

  const { data: summary } = await admin
    .from("v_staff_advances_outstanding")
    .select("*")
    .gt("outstanding_php", 0)
    .order("outstanding_php", { ascending: false });

  const { data: rows } = await admin
    .from("staff_advances")
    .select("id, staff_id, business_date, original_amount_php, outstanding_balance_php, status, source_adjustment_id")
    .order("business_date", { ascending: false })
    .limit(500);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">Phase 12.C · Admin · Reports</p>
        <h1 className="mt-1 font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">Staff advances</h1>
      </header>

      <section className="mb-6 overflow-x-auto rounded-lg border bg-white shadow-sm">
        <h2 className="px-3 py-2 text-sm font-semibold text-[color:var(--color-brand-navy)]">Outstanding by staff</h2>
        <table className="w-full min-w-[640px] text-sm">
          <thead><tr className="bg-[color:var(--color-bg-mid)] text-left">
            <th className="px-3 py-2">Staff</th>
            <th className="px-3 py-2">Role</th>
            <th className="px-3 py-2">Advances</th>
            <th className="px-3 py-2">Outstanding</th>
            <th className="px-3 py-2">Oldest</th>
          </tr></thead>
          <tbody>
            {(summary ?? []).map((r) => (
              <tr key={r.staff_id as string} className="border-t">
                <td className="px-3 py-2">{r.full_name as string}</td>
                <td className="px-3 py-2">{r.role as string}</td>
                <td className="px-3 py-2">{r.advance_count as number}</td>
                <td className="px-3 py-2 font-mono">{PESO(Number(r.outstanding_php ?? 0))}</td>
                <td className="px-3 py-2">{r.oldest_advance_date as string}</td>
              </tr>
            ))}
            {(summary ?? []).length === 0 && <tr><td colSpan={5} className="px-3 py-4 text-center text-[color:var(--color-brand-text-soft)]">No outstanding advances.</td></tr>}
          </tbody>
        </table>
      </section>

      <section className="overflow-x-auto rounded-lg border bg-white shadow-sm">
        <h2 className="px-3 py-2 text-sm font-semibold text-[color:var(--color-brand-navy)]">Recent advances (most recent 500)</h2>
        <table className="w-full min-w-[720px] text-sm">
          <thead><tr className="bg-[color:var(--color-bg-mid)] text-left">
            <th className="px-3 py-2">Date</th>
            <th className="px-3 py-2">Staff</th>
            <th className="px-3 py-2">Original</th>
            <th className="px-3 py-2">Outstanding</th>
            <th className="px-3 py-2">Status</th>
          </tr></thead>
          <tbody>
            {(rows ?? []).map((r) => (
              <tr key={r.id} className="border-t">
                <td className="px-3 py-2">{r.business_date}</td>
                <td className="px-3 py-2 font-mono text-xs">{(r.staff_id as string).slice(0, 8)}…</td>
                <td className="px-3 py-2 font-mono">{PESO(Number(r.original_amount_php))}</td>
                <td className="px-3 py-2 font-mono">{PESO(Number(r.outstanding_balance_php))}</td>
                <td className="px-3 py-2">{r.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
