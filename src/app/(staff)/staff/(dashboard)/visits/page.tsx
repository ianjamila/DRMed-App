import Link from "next/link";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createClient } from "@/lib/supabase/server";
import { todayManilaISODate } from "@/lib/dates/manila";
import { VisitsTabs } from "./_components/visits-tabs";

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

const PAGE_SIZE = 25;

interface SearchProps {
  searchParams: Promise<{ start?: string; end?: string; page?: string }>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type VisitRow = {
  id: string;
  visit_number: string;
  visit_date: string;
  payment_status: string;
  total_php: number;
  paid_php: number;
  patients: {
    id: string;
    drm_id: string;
    first_name: string;
    last_name: string;
  };
  test_requests: { id: string }[] | null;
  payments:
    | {
        method: string | null;
        voided_at: string | null;
      }[]
    | null;
};

function methodsFor(payments: VisitRow["payments"]): string {
  if (!payments || payments.length === 0) return "—";
  const methods = new Set<string>();
  for (const p of payments) {
    if (p.voided_at !== null) continue;
    if (p.method) methods.add(p.method);
  }
  if (methods.size === 0) return "—";
  return Array.from(methods).join(", ");
}

export default async function VisitsIndexPage({ searchParams }: SearchProps) {
  await requireActiveStaff();
  const params = await searchParams;

  const start = params.start && DATE_RE.test(params.start) ? params.start : "";
  const end = params.end && DATE_RE.test(params.end) ? params.end : "";
  const page = Math.max(1, Number(params.page) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const supabase = await createClient();

  let query = supabase
    .from("visits")
    .select(
      `
        id, visit_number, visit_date, payment_status, total_php, paid_php,
        patients!inner ( id, drm_id, first_name, last_name ),
        test_requests ( id ),
        payments ( method, voided_at )
      `,
      { count: "exact" },
    )
    .order("visit_date", { ascending: false })
    .order("created_at", { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);

  if (start) query = query.gte("visit_date", start);
  if (end) query = query.lte("visit_date", end);

  const { data: visits, count } = await query.returns<VisitRow[]>();

  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);

  function pageHref(p: number) {
    const sp = new URLSearchParams();
    if (start) sp.set("start", start);
    if (end) sp.set("end", end);
    if (p > 1) sp.set("page", String(p));
    const qs = sp.toString();
    return `/staff/visits${qs ? `?${qs}` : ""}`;
  }

  const rangeLabel =
    start && end
      ? `${start} → ${end}`
      : start
        ? `from ${start}`
        : end
          ? `up to ${end}`
          : "all dates";

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-4">
        <h1 className="font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Visits
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          {total} visit{total === 1 ? "" : "s"} · {rangeLabel}
        </p>
      </header>

      <div className="mb-6"><VisitsTabs /></div>

      <form
        className="mb-6 flex flex-wrap items-end gap-3 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4"
        action="/staff/visits"
      >
        <div className="flex flex-col">
          <label
            htmlFor="start"
            className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]"
          >
            Start date
          </label>
          <input
            type="date"
            id="start"
            name="start"
            defaultValue={start}
            max={todayManilaISODate()}
            className="mt-1 rounded-md border border-[color:var(--color-brand-bg-mid)] px-2 py-1.5 text-sm"
          />
        </div>
        <div className="flex flex-col">
          <label
            htmlFor="end"
            className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]"
          >
            End date
          </label>
          <input
            type="date"
            id="end"
            name="end"
            defaultValue={end}
            max={todayManilaISODate()}
            className="mt-1 rounded-md border border-[color:var(--color-brand-bg-mid)] px-2 py-1.5 text-sm"
          />
        </div>
        <button
          type="submit"
          className="min-h-11 rounded-md border border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-cyan)] px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[color:var(--color-brand-cyan-mid)]"
        >
          Apply
        </button>
        {(start || end) && (
          <Link
            href="/staff/visits"
            className="min-h-11 rounded-md border border-[color:var(--color-brand-bg-mid)] px-4 py-1.5 text-sm text-[color:var(--color-brand-text-soft)] transition-colors hover:border-[color:var(--color-brand-cyan)]"
          >
            Clear
          </Link>
        )}
      </form>

      {!visits || visits.length === 0 ? (
        <div className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
          No visits in this range.
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white md:block">
            <table className="w-full text-sm">
              <thead className="bg-[color:var(--color-brand-bg)] text-[color:var(--color-brand-text-soft)]">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider">
                    Date
                  </th>
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
                    Method
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {visits.map((v) => {
                  const p = v.patients;
                  const testCount = v.test_requests?.length ?? 0;
                  const status = v.payment_status;
                  return (
                    <tr
                      key={v.id}
                      className="border-t border-[color:var(--color-brand-bg-mid)]"
                    >
                      <td className="whitespace-nowrap px-4 py-3 text-[color:var(--color-brand-text-soft)]">
                        {v.visit_date}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">
                        <Link
                          href={`/staff/visits/${v.id}`}
                          className="text-[color:var(--color-brand-cyan)] hover:underline"
                        >
                          #{String(v.visit_number).padStart(4, "0")}
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        <Link
                          href={`/staff/patients/${p.id}`}
                          className="text-[color:var(--color-brand-navy)] hover:underline"
                        >
                          {p.last_name}, {p.first_name}
                        </Link>{" "}
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
                      <td className="px-4 py-3 text-xs text-[color:var(--color-brand-text-soft)]">
                        {methodsFor(v.payments)}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[status] ?? ""}`}
                        >
                          {status}
                        </span>
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
              const status = v.payment_status;
              return (
                <article
                  key={v.id}
                  className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4"
                >
                  <div className="flex items-center justify-between">
                    <Link
                      href={`/staff/visits/${v.id}`}
                      className="font-mono text-xs text-[color:var(--color-brand-cyan)] hover:underline"
                    >
                      #{String(v.visit_number).padStart(4, "0")}
                    </Link>
                    <span
                      className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[status] ?? ""}`}
                    >
                      {status}
                    </span>
                  </div>
                  <Link
                    href={`/staff/patients/${p.id}`}
                    className="mt-1 block font-medium text-[color:var(--color-brand-navy)] hover:underline"
                  >
                    {p.last_name}, {p.first_name}
                  </Link>
                  <div className="text-xs text-[color:var(--color-brand-text-soft)]">
                    {p.drm_id} · {v.visit_date} · {testCount} test
                    {testCount === 1 ? "" : "s"}
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
                  <div className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
                    {methodsFor(v.payments)}
                  </div>
                </article>
              );
            })}
          </div>

          {totalPages > 1 ? (
            <nav className="mt-6 flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-[color:var(--color-brand-text-soft)]">
                Page {safePage} of {totalPages}
              </p>
              <div className="flex gap-2">
                {safePage > 1 ? (
                  <Link
                    href={pageHref(safePage - 1)}
                    className="min-h-11 rounded-md border border-[color:var(--color-brand-bg-mid)] px-4 py-1.5 text-sm transition-colors hover:border-[color:var(--color-brand-cyan)]"
                  >
                    ← Previous
                  </Link>
                ) : (
                  <span className="min-h-11 rounded-md border border-[color:var(--color-brand-bg-mid)] px-4 py-1.5 text-sm text-[color:var(--color-brand-text-soft)] opacity-50">
                    ← Previous
                  </span>
                )}
                {safePage < totalPages ? (
                  <Link
                    href={pageHref(safePage + 1)}
                    className="min-h-11 rounded-md border border-[color:var(--color-brand-bg-mid)] px-4 py-1.5 text-sm transition-colors hover:border-[color:var(--color-brand-cyan)]"
                  >
                    Next →
                  </Link>
                ) : (
                  <span className="min-h-11 rounded-md border border-[color:var(--color-brand-bg-mid)] px-4 py-1.5 text-sm text-[color:var(--color-brand-text-soft)] opacity-50">
                    Next →
                  </span>
                )}
              </div>
            </nav>
          ) : null}
        </>
      )}
    </div>
  );
}
