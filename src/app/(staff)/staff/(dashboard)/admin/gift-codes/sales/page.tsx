import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { formatPhp } from "@/lib/marketing/format";

export const metadata = { title: "Gift code sales — staff" };

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ from?: string; to?: string }>;
}

const PAYMENT_LABELS: Record<string, string> = {
  cash: "Cash",
  gcash: "GCash",
  maya: "Maya",
  card: "Card",
  bank_transfer: "Bank transfer",
};

function manilaTodayISO(): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function firstOfMonthISO(): string {
  const today = manilaTodayISO();
  return today.slice(0, 7) + "-01";
}

export default async function SalesPage({ searchParams }: PageProps) {
  await requireAdminStaff();
  const params = await searchParams;
  const from = params.from?.match(/^\d{4}-\d{2}-\d{2}$/)
    ? params.from
    : firstOfMonthISO();
  const to = params.to?.match(/^\d{4}-\d{2}-\d{2}$/)
    ? params.to
    : manilaTodayISO();

  const fromIso = `${from}T00:00:00+08:00`;
  // Inclusive end-of-day so a from=to=2026-05-07 covers the whole day.
  const toIso = new Date(
    new Date(`${to}T00:00:00+08:00`).getTime() + 24 * 60 * 60 * 1000,
  ).toISOString();

  const admin = createAdminClient();
  const { data: rows } = await admin
    .from("gift_codes")
    .select(
      "id, code, face_value_php, status, purchased_at, purchased_by_name, purchased_by_contact, purchase_method, purchase_reference_number, sold_by, batch_label",
    )
    .gte("purchased_at", fromIso)
    .lt("purchased_at", toIso)
    .not("purchased_at", "is", null)
    .order("purchased_at", { ascending: false });

  const sales = rows ?? [];

  const sellerIds = Array.from(
    new Set(sales.map((r) => r.sold_by).filter(Boolean)),
  ) as string[];
  const sellerNames = new Map<string, string>();
  if (sellerIds.length > 0) {
    const { data: profiles } = await admin
      .from("staff_profiles")
      .select("id, full_name")
      .in("id", sellerIds);
    for (const p of profiles ?? []) sellerNames.set(p.id, p.full_name);
  }

  // Per-day totals — small enough at clinic scale to do client-side.
  const byDay = new Map<string, { count: number; total: number }>();
  for (const s of sales) {
    if (!s.purchased_at) continue;
    const day = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Manila",
    }).format(new Date(s.purchased_at));
    const cur = byDay.get(day) ?? { count: 0, total: 0 };
    cur.count += 1;
    cur.total += Number(s.face_value_php);
    byDay.set(day, cur);
  }
  const daily = Array.from(byDay.entries()).sort((a, b) =>
    a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0,
  );
  const grandTotal = sales.reduce(
    (sum, s) => sum + Number(s.face_value_php),
    0,
  );

  const csvHref = `/api/admin/gift-codes/sales.csv?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          <Link
            href="/staff/admin/gift-codes"
            className="hover:text-[color:var(--color-brand-navy)]"
          >
            ← Gift codes
          </Link>
        </p>
        <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Gift code sales
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
          Sales captured at the counter, in date range. Use this view for
          accounting reconciliation; export CSV for spreadsheet handoffs.
        </p>
      </header>

      <form className="mb-6 flex flex-wrap items-end gap-3 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4">
        <div className="grid gap-1">
          <label htmlFor="from" className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            From
          </label>
          <input
            id="from"
            name="from"
            type="date"
            defaultValue={from}
            className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm"
          />
        </div>
        <div className="grid gap-1">
          <label htmlFor="to" className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            To
          </label>
          <input
            id="to"
            name="to"
            type="date"
            defaultValue={to}
            className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm"
          />
        </div>
        <button
          type="submit"
          className="rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold text-white hover:bg-[color:var(--color-brand-cyan)]"
        >
          Apply
        </button>
        <a
          href={csvHref}
          className="ml-auto rounded-md border border-[color:var(--color-brand-navy)] bg-white px-4 py-2 text-sm font-bold text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-bg)]"
        >
          Export CSV
        </a>
      </form>

      <section className="mb-6 grid gap-4 sm:grid-cols-3">
        <Stat label="Sales (count)" value={sales.length.toString()} />
        <Stat label="Total face value" value={formatPhp(grandTotal)} />
        <Stat
          label="Range"
          value={
            from === to
              ? from
              : `${from} → ${to}`
          }
        />
      </section>

      {daily.length > 0 ? (
        <section className="mb-6">
          <h2 className="mb-2 font-[family-name:var(--font-heading)] text-sm font-extrabold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Per day
          </h2>
          <div className="overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
            <table className="w-full text-sm">
              <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                <tr>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3 text-right">Sales</th>
                  <th className="px-4 py-3 text-right">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
                {daily.map(([day, t]) => (
                  <tr key={day} className="hover:bg-[color:var(--color-brand-bg)]">
                    <td className="px-4 py-3 font-mono text-[color:var(--color-brand-navy)]">
                      {day}
                    </td>
                    <td className="px-4 py-3 text-right">{t.count}</td>
                    <td className="px-4 py-3 text-right font-semibold">
                      {formatPhp(t.total)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section>
        <h2 className="mb-2 font-[family-name:var(--font-heading)] text-sm font-extrabold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          Individual sales ({sales.length})
        </h2>
        <div className="overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
          <table className="w-full min-w-[820px] text-sm">
            <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              <tr>
                <th className="px-4 py-3">Sold</th>
                <th className="px-4 py-3">Code</th>
                <th className="px-4 py-3 text-right">Face value</th>
                <th className="px-4 py-3">Buyer</th>
                <th className="px-4 py-3">Method</th>
                <th className="px-4 py-3">Reference</th>
                <th className="px-4 py-3">Sold by</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
              {sales.length === 0 ? (
                <tr>
                  <td
                    colSpan={8}
                    className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                  >
                    No sales in this range.
                  </td>
                </tr>
              ) : (
                sales.map((s) => (
                  <tr key={s.id} className="hover:bg-[color:var(--color-brand-bg)]">
                    <td className="px-4 py-3 whitespace-nowrap text-xs text-[color:var(--color-brand-text-mid)]">
                      {s.purchased_at
                        ? new Intl.DateTimeFormat("en-PH", {
                            timeZone: "Asia/Manila",
                            month: "short",
                            day: "numeric",
                            hour: "numeric",
                            minute: "2-digit",
                          }).format(new Date(s.purchased_at))
                        : "—"}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-[color:var(--color-brand-navy)]">
                      {s.code}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold">
                      {formatPhp(s.face_value_php)}
                    </td>
                    <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                      <p className="font-semibold text-[color:var(--color-brand-navy)]">
                        {s.purchased_by_name ?? "—"}
                      </p>
                      <p className="text-xs">
                        {s.purchased_by_contact ?? ""}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-xs text-[color:var(--color-brand-text-mid)]">
                      {s.purchase_method
                        ? PAYMENT_LABELS[s.purchase_method] ??
                          s.purchase_method
                        : "—"}
                    </td>
                    <td className="px-4 py-3 text-xs text-[color:var(--color-brand-text-soft)]">
                      {s.purchase_reference_number ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-xs text-[color:var(--color-brand-text-mid)]">
                      {s.sold_by
                        ? sellerNames.get(s.sold_by) ?? "—"
                        : "—"}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {s.status === "redeemed" ? (
                        <span className="rounded-md bg-emerald-100 px-2 py-0.5 font-semibold text-emerald-900">
                          Redeemed
                        </span>
                      ) : s.status === "purchased" ? (
                        <span className="rounded-md bg-amber-100 px-2 py-0.5 font-semibold text-amber-900">
                          Outstanding
                        </span>
                      ) : (
                        <span className="rounded-md bg-zinc-100 px-2 py-0.5 font-semibold text-zinc-700">
                          {s.status}
                        </span>
                      )}
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-4">
      <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        {label}
      </p>
      <p className="mt-1 font-[family-name:var(--font-heading)] text-2xl font-extrabold text-[color:var(--color-brand-navy)]">
        {value}
      </p>
    </div>
  );
}
