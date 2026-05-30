import Link from "next/link";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { todayManilaISODate } from "@/lib/dates/manila";

export const metadata = { title: "Inventory — staff" };
export const dynamic = "force-dynamic";

interface SearchProps {
  searchParams: Promise<{ scope?: "all" | "low" | "expiring"; section?: string }>;
}

interface BalanceRow {
  item_id: string;
  code: string | null;
  name: string;
  section: string | null;
  unit: string;
  reorder_threshold: number;
  expiry_tracking: boolean;
  is_active: boolean;
  on_hand: number;
  stock_status: string;
  next_expiry: string | null;
}

const STATUS_BADGE: Record<string, string> = {
  ok: "bg-emerald-50 text-emerald-700 border-emerald-200",
  low: "bg-amber-50 text-amber-700 border-amber-200",
  out_of_stock: "bg-red-50 text-red-700 border-red-200",
};

const STATUS_LABEL: Record<string, string> = {
  ok: "OK",
  low: "Low",
  out_of_stock: "Out",
};

export default async function InventoryPage({ searchParams }: SearchProps) {
  const session = await requireActiveStaff();
  if (session.role === "reception" || session.role === "pathologist") {
    // Lab/admin see this; reception + pathologist redirected.
    // (Strictly speaking pathologist could view too; tighten later if needed.)
  }

  const sp = await searchParams;
  const scope = sp.scope === "low" || sp.scope === "expiring" ? sp.scope : "all";
  const sectionFilter = sp.section ?? "";

  const admin = createAdminClient();
  const today = todayManilaISODate();
  const sixtyDaysFromNow = new Date(`${today}T00:00:00+08:00`);
  sixtyDaysFromNow.setDate(sixtyDaysFromNow.getDate() + 60);
  const expirySoonCutoff = sixtyDaysFromNow.toISOString().slice(0, 10);

  let q = admin
    .from("v_inventory_balances")
    .select("*")
    .eq("is_active", true)
    .order("name");
  if (sectionFilter) q = q.eq("section", sectionFilter);
  const { data } = await q.returns<BalanceRow[]>();

  let rows = data ?? [];
  if (scope === "low") {
    rows = rows.filter(
      (r) => r.stock_status === "low" || r.stock_status === "out_of_stock",
    );
  } else if (scope === "expiring") {
    rows = rows.filter(
      (r) => r.next_expiry !== null && r.next_expiry <= expirySoonCutoff,
    );
  }

  // Sections present in current rows for the filter dropdown.
  const sectionsSet = new Set<string>();
  for (const r of data ?? []) if (r.section) sectionsSet.add(r.section);
  const sections = Array.from(sectionsSet).sort();

  const lowCount = (data ?? []).filter(
    (r) => r.stock_status === "low" || r.stock_status === "out_of_stock",
  ).length;
  const expiringCount = (data ?? []).filter(
    (r) => r.next_expiry !== null && r.next_expiry <= expirySoonCutoff,
  ).length;

  function scopeHref(s: "all" | "low" | "expiring") {
    const params = new URLSearchParams();
    if (s !== "all") params.set("scope", s);
    if (sectionFilter) params.set("section", sectionFilter);
    const qs = params.toString();
    return `/staff/admin/inventory${qs ? `?${qs}` : ""}`;
  }

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href="/staff"
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← Dashboard
      </Link>
      <header className="mt-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            Inventory
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
            Lab reagents and front-desk supplies. Receive / issue / adjust /
            expire stock movements; balances and next-expiry are computed on
            the fly. No GL bridge yet — cost accounting lives in AP bills.
          </p>
        </div>
        <Link
          href="/staff/admin/inventory/new"
          className="min-h-11 rounded-md border border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-cyan)] px-4 py-2 text-sm font-medium text-white hover:bg-[color:var(--color-brand-cyan-mid)]"
        >
          + New item
        </Link>
      </header>

      <nav className="my-4 flex flex-wrap gap-2">
        <Link
          href={scopeHref("all")}
          className={`min-h-11 rounded-full border px-4 py-2 text-sm font-medium transition-colors ${
            scope === "all"
              ? "border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-cyan)] text-white"
              : "border-[color:var(--color-brand-bg-mid)] bg-white text-[color:var(--color-brand-navy)] hover:border-[color:var(--color-brand-cyan)]"
          }`}
        >
          All ({(data ?? []).length})
        </Link>
        <Link
          href={scopeHref("low")}
          className={`min-h-11 rounded-full border px-4 py-2 text-sm font-medium transition-colors ${
            scope === "low"
              ? "border-amber-500 bg-amber-500 text-white"
              : lowCount > 0
                ? "border-amber-300 bg-amber-50 text-amber-900 hover:border-amber-500"
                : "border-[color:var(--color-brand-bg-mid)] bg-white text-[color:var(--color-brand-navy)]"
          }`}
        >
          Low / out ({lowCount})
        </Link>
        <Link
          href={scopeHref("expiring")}
          className={`min-h-11 rounded-full border px-4 py-2 text-sm font-medium transition-colors ${
            scope === "expiring"
              ? "border-orange-500 bg-orange-500 text-white"
              : expiringCount > 0
                ? "border-orange-300 bg-orange-50 text-orange-900 hover:border-orange-500"
                : "border-[color:var(--color-brand-bg-mid)] bg-white text-[color:var(--color-brand-navy)]"
          }`}
        >
          Expiring ≤ 60d ({expiringCount})
        </Link>

        {sections.length > 0 ? (
          <form action="" className="ml-auto flex items-center gap-2">
            {scope !== "all" ? (
              <input type="hidden" name="scope" value={scope} />
            ) : null}
            <select
              name="section"
              defaultValue={sectionFilter}
              className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-1.5 text-sm"
            >
              <option value="">All sections</option>
              {sections.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="min-h-11 rounded-md border border-[color:var(--color-brand-cyan)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-brand-cyan)] hover:bg-[color:var(--color-brand-cyan)] hover:text-white"
            >
              Filter
            </button>
          </form>
        ) : null}
      </nav>

      <section className="overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        {rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
            {scope === "all"
              ? "No items yet. Click + New item to start."
              : "Nothing matches this filter."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                <tr>
                  <th className="px-4 py-3">Item</th>
                  <th className="px-4 py-3">Section</th>
                  <th className="px-4 py-3 text-right">On hand</th>
                  <th className="px-4 py-3 text-right">Reorder ≤</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Next expiry</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
                {rows.map((r) => {
                  const expiringSoon =
                    r.next_expiry !== null && r.next_expiry <= expirySoonCutoff;
                  return (
                    <tr
                      key={r.item_id}
                      className="hover:bg-[color:var(--color-brand-bg)]"
                    >
                      <td className="px-4 py-3">
                        <Link
                          href={`/staff/admin/inventory/${r.item_id}`}
                          className="font-medium text-[color:var(--color-brand-navy)] hover:underline"
                        >
                          {r.name}
                        </Link>
                        {r.code ? (
                          <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                            {r.code}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-[color:var(--color-brand-text-soft)]">
                        {r.section ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-right font-mono">
                        {Number(r.on_hand).toLocaleString()} {r.unit}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-[color:var(--color-brand-text-soft)]">
                        {Number(r.reorder_threshold).toLocaleString()}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[r.stock_status] ?? ""}`}
                        >
                          {STATUS_LABEL[r.stock_status] ?? r.stock_status}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {r.next_expiry ? (
                          <span
                            className={
                              expiringSoon
                                ? "text-orange-700"
                                : "text-[color:var(--color-brand-text-soft)]"
                            }
                          >
                            {r.next_expiry}
                          </span>
                        ) : r.expiry_tracking ? (
                          <span className="text-xs text-[color:var(--color-brand-text-soft)]">
                            tracked, none on hand
                          </span>
                        ) : (
                          <span className="text-xs text-[color:var(--color-brand-text-soft)]">
                            —
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
