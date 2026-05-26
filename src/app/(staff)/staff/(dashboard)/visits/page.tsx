import Link from "next/link";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createClient } from "@/lib/supabase/server";
import { todayManilaISODate } from "@/lib/dates/manila";

export const metadata = {
  title: "Visits — staff",
};

const PHP = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
});

const STATUS_BADGE: Record<string, string> = {
  paid: "bg-green-50 text-green-700 border-green-200",
  partial: "bg-amber-50 text-amber-700 border-amber-200",
  unpaid: "bg-red-50 text-red-700 border-red-200",
  waived: "bg-blue-50 text-blue-700 border-blue-200",
};

interface SearchProps {
  searchParams: Promise<{ date?: string }>;
}

export default async function VisitsIndexPage({ searchParams }: SearchProps) {
  await requireActiveStaff();
  const params = await searchParams;
  const targetDate =
    params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date)
      ? params.date
      : todayManilaISODate();

  const supabase = await createClient();

  const { data: visits } = await supabase
    .from("visits")
    .select(
      `
        id, visit_number, visit_date, payment_status, total_php, paid_php,
        patients!inner ( id, drm_id, first_name, last_name ),
        test_requests ( id )
      `,
    )
    .eq("visit_date", targetDate)
    .order("created_at", { ascending: false })
    .limit(200);

  const isToday = targetDate === todayManilaISODate();

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Reception
          </p>
          <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            Visits {isToday ? "today" : `on ${targetDate}`}
          </h1>
          <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
            {visits?.length ?? 0} visit{visits?.length === 1 ? "" : "s"}{" "}
            registered.
          </p>
        </div>
        <form className="flex items-center gap-2" action="/staff/visits">
          <label
            htmlFor="date"
            className="text-sm text-[color:var(--color-brand-text-soft)]"
          >
            Date
          </label>
          <input
            type="date"
            id="date"
            name="date"
            defaultValue={targetDate}
            max={todayManilaISODate()}
            className="rounded-md border border-[color:var(--color-brand-border)] px-2 py-1 text-sm"
          />
          <button
            type="submit"
            className="rounded-md border border-[color:var(--color-brand-cyan)] px-3 py-1 text-sm font-medium text-[color:var(--color-brand-cyan)] transition-colors hover:bg-[color:var(--color-brand-cyan)] hover:text-white"
          >
            Go
          </button>
        </form>
      </header>

      {!visits || visits.length === 0 ? (
        <div className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
          No visits {isToday ? "today" : `on ${targetDate}`}.
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white md:block">
            <table className="w-full text-sm">
              <thead className="bg-[color:var(--color-brand-bg)] text-[color:var(--color-brand-text-soft)]">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider">
                    Visit #
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider">
                    Patient
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider">
                    Tests
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider">
                    Total
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider">
                    Paid
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {visits.map((v) => {
                  const p = v.patients;
                  const testCount = v.test_requests?.length ?? 0;
                  const status = v.payment_status as string;
                  return (
                    <tr
                      key={v.id}
                      className="border-t border-[color:var(--color-brand-bg-mid)]"
                    >
                      <td className="px-4 py-3 font-mono text-xs">
                        #{String(v.visit_number).padStart(4, "0")}
                      </td>
                      <td className="px-4 py-3">
                        {p.last_name}, {p.first_name}{" "}
                        <span className="text-xs text-[color:var(--color-brand-text-soft)]">
                          ({p.drm_id})
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">{testCount}</td>
                      <td className="px-4 py-3 text-right font-mono">
                        {PHP.format(Number(v.total_php))}
                      </td>
                      <td className="px-4 py-3 text-right font-mono">
                        {PHP.format(Number(v.paid_php))}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[status] ?? ""}`}
                        >
                          {status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link
                          href={`/staff/visits/${v.id}`}
                          className="text-sm text-[color:var(--color-brand-cyan)] hover:underline"
                        >
                          Open →
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile card list */}
          <div className="space-y-3 md:hidden">
            {visits.map((v) => {
              const p = v.patients;
              const testCount = v.test_requests?.length ?? 0;
              const status = v.payment_status as string;
              return (
                <Link
                  key={v.id}
                  href={`/staff/visits/${v.id}`}
                  className="block rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4"
                >
                  <div className="flex items-center justify-between">
                    <div className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                      #{String(v.visit_number).padStart(4, "0")}
                    </div>
                    <span
                      className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[status] ?? ""}`}
                    >
                      {status}
                    </span>
                  </div>
                  <div className="mt-1 font-medium">
                    {p.last_name}, {p.first_name}
                  </div>
                  <div className="text-xs text-[color:var(--color-brand-text-soft)]">
                    {p.drm_id} · {testCount} test{testCount === 1 ? "" : "s"}
                  </div>
                  <div className="mt-2 flex justify-between text-xs">
                    <span>
                      Total:{" "}
                      <span className="font-mono">
                        {PHP.format(Number(v.total_php))}
                      </span>
                    </span>
                    <span>
                      Paid:{" "}
                      <span className="font-mono">
                        {PHP.format(Number(v.paid_php))}
                      </span>
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
