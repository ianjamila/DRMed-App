import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { todayManilaISODate } from "@/lib/dates/manila";

export const metadata = { title: "Patient AR aging — staff" };
export const dynamic = "force-dynamic";

const PHP = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
});

type Scope = "non_hmo" | "hmo" | "all";

interface SearchProps {
  searchParams: Promise<{ scope?: Scope }>;
}

interface VisitRow {
  id: string;
  visit_number: string;
  visit_date: string;
  total_php: number;
  paid_php: number;
  payment_status: string;
  hmo_provider_id: string | null;
  patients:
    | { id: string; drm_id: string; first_name: string; last_name: string }
    | { id: string; drm_id: string; first_name: string; last_name: string }[]
    | null;
  hmo_providers: { name: string } | { name: string }[] | null;
}

interface BucketTotals {
  current: { count: number; amount: number };
  d31_60: { count: number; amount: number };
  d61_90: { count: number; amount: number };
  d90_plus: { count: number; amount: number };
}

function bucketFor(visitDate: string, today: string): keyof BucketTotals {
  const days = Math.floor(
    (Date.parse(today) - Date.parse(visitDate)) / 86400000,
  );
  if (days <= 30) return "current";
  if (days <= 60) return "d31_60";
  if (days <= 90) return "d61_90";
  return "d90_plus";
}

function pluckPatient<T extends { id: string; drm_id: string; first_name: string; last_name: string }>(
  v: T | T[] | null,
): T | null {
  if (!v) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

function pluckProviderName(
  v: { name: string } | { name: string }[] | null,
): string | null {
  if (!v) return null;
  const row = Array.isArray(v) ? v[0] : v;
  return row?.name ?? null;
}

const SCOPE_LABEL: Record<Scope, string> = {
  non_hmo: "Non-HMO (patient pays)",
  hmo: "HMO co-pay residue",
  all: "All outstanding",
};

const TABS: Scope[] = ["non_hmo", "hmo", "all"];

export default async function PatientArPage({ searchParams }: SearchProps) {
  await requireAdminStaff();
  const sp = await searchParams;
  const scope: Scope =
    sp.scope === "hmo" || sp.scope === "all" ? sp.scope : "non_hmo";

  const today = todayManilaISODate();
  const admin = createAdminClient();

  let query = admin
    .from("visits")
    .select(
      `
        id, visit_number, visit_date, total_php, paid_php, payment_status, hmo_provider_id,
        patients ( id, drm_id, first_name, last_name ),
        hmo_providers ( name )
      `,
    )
    .in("payment_status", ["unpaid", "partial"])
    .order("visit_date", { ascending: true })
    .limit(500);

  if (scope === "non_hmo") query = query.is("hmo_provider_id", null);
  else if (scope === "hmo") query = query.not("hmo_provider_id", "is", null);

  const { data } = await query.returns<VisitRow[]>();
  const rows = data ?? [];

  const totals: BucketTotals = {
    current: { count: 0, amount: 0 },
    d31_60: { count: 0, amount: 0 },
    d61_90: { count: 0, amount: 0 },
    d90_plus: { count: 0, amount: 0 },
  };

  const enriched = rows.map((v) => {
    const outstanding = Number(v.total_php ?? 0) - Number(v.paid_php ?? 0);
    const bucket = bucketFor(v.visit_date, today);
    if (outstanding > 0) {
      totals[bucket].count += 1;
      totals[bucket].amount += outstanding;
    }
    const days = Math.floor(
      (Date.parse(today) - Date.parse(v.visit_date)) / 86400000,
    );
    return { v, outstanding, bucket, days };
  });

  const grandTotal =
    totals.current.amount +
    totals.d31_60.amount +
    totals.d61_90.amount +
    totals.d90_plus.amount;
  const grandCount =
    totals.current.count +
    totals.d31_60.count +
    totals.d61_90.count +
    totals.d90_plus.count;

  function tabHref(s: Scope) {
    const params = new URLSearchParams();
    if (s !== "non_hmo") params.set("scope", s);
    const qs = params.toString();
    return `/staff/admin/accounting/patient-ar${qs ? `?${qs}` : ""}`;
  }

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <Link
          href="/staff"
          className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
        >
          ← Dashboard
        </Link>
        <h1 className="mt-3 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Patient AR aging
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          Outstanding balances on unpaid / partially-paid visits, bucketed by
          age of service date. Showing {SCOPE_LABEL[scope].toLowerCase()}.
        </p>
      </header>

      <nav className="mb-6 flex flex-wrap gap-2">
        {TABS.map((s) => {
          const active = scope === s;
          return (
            <Link
              key={s}
              href={tabHref(s)}
              className={`min-h-11 rounded-full border px-4 py-2 text-sm font-medium transition-colors ${
                active
                  ? "border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-cyan)] text-white"
                  : "border-[color:var(--color-brand-bg-mid)] bg-white text-[color:var(--color-brand-navy)] hover:border-[color:var(--color-brand-cyan)]"
              }`}
            >
              {SCOPE_LABEL[s]}
            </Link>
          );
        })}
      </nav>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <article className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5">
          <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Grand total
          </p>
          <p className="mt-2 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            {PHP.format(grandTotal)}
          </p>
          <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
            {grandCount} visit{grandCount === 1 ? "" : "s"}
          </p>
        </article>
        <BucketCard label="0–30 days" totals={totals.current} tone="ok" />
        <BucketCard label="31–60 days" totals={totals.d31_60} tone="warn" />
        <BucketCard label="61–90 days" totals={totals.d61_90} tone="hot" />
        <BucketCard label="90+ days" totals={totals.d90_plus} tone="critical" />
      </div>

      <section className="overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        {enriched.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
            No outstanding visits in this scope.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                <tr>
                  <th className="px-4 py-3">Visit date</th>
                  <th className="px-4 py-3">Age</th>
                  <th className="px-4 py-3">Visit #</th>
                  <th className="px-4 py-3">Patient</th>
                  <th className="px-4 py-3">HMO</th>
                  <th className="px-4 py-3 text-right">Outstanding</th>
                  <th className="px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
                {enriched.map(({ v, outstanding, days }) => {
                  const p = pluckPatient(v.patients);
                  const providerName = pluckProviderName(v.hmo_providers);
                  return (
                    <tr key={v.id} className="hover:bg-[color:var(--color-brand-bg)]">
                      <td className="whitespace-nowrap px-4 py-3 text-[color:var(--color-brand-text-soft)]">
                        {v.visit_date}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <span
                          className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${ageBadge(days)}`}
                        >
                          {days}d
                        </span>
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
                        {p ? (
                          <Link
                            href={`/staff/patients/${p.id}`}
                            className="text-[color:var(--color-brand-navy)] hover:underline"
                          >
                            {p.last_name}, {p.first_name}
                          </Link>
                        ) : (
                          <span className="italic text-[color:var(--color-brand-text-soft)]">
                            Walk-in
                          </span>
                        )}
                        {p ? (
                          <span className="ml-2 font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                            {p.drm_id}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-xs text-[color:var(--color-brand-text-soft)]">
                        {providerName ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-right font-mono">
                        {PHP.format(outstanding)}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${statusBadge(v.payment_status)}`}
                        >
                          {v.payment_status}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {rows.length === 500 ? (
        <p className="mt-3 text-xs text-[color:var(--color-brand-text-soft)]">
          Showing first 500 oldest visits. Narrow the scope or build pagination
          if this becomes routinely truncated.
        </p>
      ) : null}
    </div>
  );
}

const TONE_BAR: Record<"ok" | "warn" | "hot" | "critical", string> = {
  ok: "before:bg-emerald-400",
  warn: "before:bg-amber-400",
  hot: "before:bg-orange-500",
  critical: "before:bg-red-500",
};

function BucketCard({
  label,
  totals,
  tone,
}: {
  label: string;
  totals: { count: number; amount: number };
  tone: "ok" | "warn" | "hot" | "critical";
}) {
  return (
    <article
      className={`relative overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5 before:absolute before:left-0 before:top-0 before:h-full before:w-1 ${TONE_BAR[tone]}`}
    >
      <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        {label}
      </p>
      <p className="mt-2 font-[family-name:var(--font-heading)] text-2xl font-extrabold text-[color:var(--color-brand-navy)]">
        {PHP.format(totals.amount)}
      </p>
      <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
        {totals.count} visit{totals.count === 1 ? "" : "s"}
      </p>
    </article>
  );
}

function ageBadge(days: number): string {
  if (days <= 30) return "bg-emerald-50 text-emerald-700 border border-emerald-200";
  if (days <= 60) return "bg-amber-50 text-amber-700 border border-amber-200";
  if (days <= 90) return "bg-orange-50 text-orange-700 border border-orange-200";
  return "bg-red-50 text-red-700 border border-red-200";
}

function statusBadge(status: string): string {
  if (status === "partial") return "bg-amber-50 text-amber-700 border-amber-200";
  if (status === "unpaid") return "bg-red-50 text-red-700 border-red-200";
  return "";
}
