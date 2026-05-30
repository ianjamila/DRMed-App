import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { todayManilaISODate } from "@/lib/dates/manila";

export const metadata = { title: "Daily revenue — staff" };
export const dynamic = "force-dynamic";

interface SearchParams { from?: string; to?: string }

const PESO = (n: number) =>
  new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(n);

export default async function DailyRevenuePage({
  searchParams,
}: { searchParams: Promise<SearchParams> }) {
  await requireAdminStaff();
  const params = await searchParams;

  const today = todayManilaISODate();
  const monthStart = today.slice(0, 7) + "-01";
  const from = params.from ?? monthStart;
  const to = params.to ?? today;

  const admin = createAdminClient();
  const { data: rows } = await admin
    .from("v_daily_revenue_by_service")
    .select("business_date, service_code, service_name, service_kind, revenue_php, released_count")
    .gte("business_date", from)
    .lte("business_date", to)
    .order("business_date", { ascending: false })
    .order("service_code", { ascending: true });

  // Group by date in JS (simpler than a SQL pivot for v1).
  const byDate = new Map<string, typeof rows>();
  for (const r of rows ?? []) {
    const list = byDate.get(r.business_date as string) ?? [];
    list.push(r);
    byDate.set(r.business_date as string, list);
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">Phase 12.C · Admin · Reports</p>
        <h1 className="mt-1 font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">Daily revenue</h1>
        <form className="mt-3 flex flex-wrap items-end gap-2 text-sm" method="get">
          <label>From <input type="date" name="from" defaultValue={from} className="rounded border px-2 py-1" /></label>
          <label>To <input type="date" name="to" defaultValue={to} className="rounded border px-2 py-1" /></label>
          <button type="submit" className="min-h-[44px] rounded border px-3 py-1">Apply</button>
        </form>
      </header>

      {[...byDate.entries()].map(([date, list]) => {
        const total = list!.reduce((s, r) => s + Number(r.revenue_php ?? 0), 0);
        return (
          <section key={date} className="mb-6 rounded-lg border bg-white p-4 shadow-sm">
            <header className="mb-2 flex justify-between">
              <strong className="text-[color:var(--color-brand-navy)]">{date}</strong>
              <span className="font-mono font-semibold">{PESO(total)}</span>
            </header>
            <ul className="text-sm">
              {list!.map((r) => (
                <li key={r.service_code as string} className="flex justify-between border-t py-1">
                  <span><code className="mr-2">{r.service_code as string}</code>{r.service_name as string} <span className="text-[color:var(--color-brand-text-soft)]">({r.service_kind as string} · {r.released_count} releases)</span></span>
                  <span className="font-mono">{PESO(Number(r.revenue_php ?? 0))}</span>
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      {byDate.size === 0 && <p className="text-sm text-[color:var(--color-brand-text-soft)]">No released revenue in this range.</p>}
    </div>
  );
}
