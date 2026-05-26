import Link from "next/link";
import { notFound } from "next/navigation";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { MovementForm } from "./movement-form";

export const metadata = { title: "Inventory item — staff" };
export const dynamic = "force-dynamic";

const PHP = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
});

interface PageProps {
  params: Promise<{ id: string }>;
}

interface ItemRow {
  id: string;
  code: string | null;
  name: string;
  section: string | null;
  unit: string;
  reorder_threshold: number;
  expiry_tracking: boolean;
  notes: string | null;
  is_active: boolean;
  vendors: { name: string } | { name: string }[] | null;
}

interface BalanceRow {
  on_hand: number;
  stock_status: string;
  next_expiry: string | null;
}

interface MovementRow {
  id: string;
  movement_type: string;
  quantity: number;
  unit_cost_php: number | null;
  expiry_date: string | null;
  lot_number: string | null;
  reference: string | null;
  notes: string | null;
  created_at: string;
  staff_profiles: { full_name: string } | { full_name: string }[] | null;
}

const TYPE_LABEL: Record<string, string> = {
  receive: "Receive",
  issue: "Issue",
  adjust: "Adjust",
  expire: "Expire",
  count: "Count",
};

export default async function InventoryItemPage({ params }: PageProps) {
  const session = await requireActiveStaff();
  const canPostMovements =
    session.role === "admin" ||
    session.role === "medtech" ||
    session.role === "xray_technician";

  const { id } = await params;
  const admin = createAdminClient();

  const [{ data: item }, { data: balance }, { data: movements }] =
    await Promise.all([
      admin
        .from("inventory_items")
        .select(
          "id, code, name, section, unit, reorder_threshold, expiry_tracking, notes, is_active, vendors ( name )",
        )
        .eq("id", id)
        .maybeSingle<ItemRow>(),
      admin
        .from("v_inventory_balances")
        .select("on_hand, stock_status, next_expiry")
        .eq("item_id", id)
        .maybeSingle<BalanceRow>(),
      admin
        .from("inventory_movements")
        .select(
          `
          id, movement_type, quantity, unit_cost_php, expiry_date,
          lot_number, reference, notes, created_at,
          staff_profiles:created_by ( full_name )
        `,
        )
        .eq("item_id", id)
        .order("created_at", { ascending: false })
        .limit(50)
        .returns<MovementRow[]>(),
    ]);

  if (!item) notFound();

  const vendor = Array.isArray(item.vendors) ? item.vendors[0] : item.vendors;
  const onHand = Number(balance?.on_hand ?? 0);
  const status = balance?.stock_status ?? "ok";
  const nextExpiry = balance?.next_expiry ?? null;
  // eslint-disable-next-line react-hooks/purity -- per-request snapshot
  const expiryWindowMs = Date.now() + 60 * 86400000;

  const statusBadge =
    status === "ok"
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : status === "low"
        ? "bg-amber-50 text-amber-700 border-amber-200"
        : "bg-red-50 text-red-700 border-red-200";
  const statusLabel =
    status === "ok" ? "OK" : status === "low" ? "Low" : "Out of stock";

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href="/staff/admin/inventory"
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← Inventory
      </Link>
      <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            {item.name}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-[color:var(--color-brand-text-soft)]">
            {item.code ? (
              <span className="font-mono text-xs">{item.code}</span>
            ) : null}
            {item.section ? <span>{item.section}</span> : null}
            <span>Unit: {item.unit}</span>
            <span>Reorder ≤ {Number(item.reorder_threshold).toLocaleString()}</span>
            {vendor ? <span>Vendor: {vendor.name}</span> : null}
            {!item.is_active ? (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-700">
                Retired
              </span>
            ) : null}
          </div>
          {item.notes ? (
            <p className="mt-2 max-w-2xl text-sm text-[color:var(--color-brand-text)]">
              {item.notes}
            </p>
          ) : null}
        </div>
        {session.role === "admin" ? (
          <Link
            href={`/staff/admin/inventory/${item.id}/edit`}
            className="min-h-11 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-2 text-sm font-medium text-[color:var(--color-brand-navy)] hover:border-[color:var(--color-brand-cyan)]"
          >
            Edit item
          </Link>
        ) : null}
      </div>

      <div className="my-6 grid gap-4 sm:grid-cols-3">
        <SummaryTile
          label="On hand"
          value={`${onHand.toLocaleString()} ${item.unit}`}
          hint={`Reorder ≤ ${Number(item.reorder_threshold).toLocaleString()}`}
          tone={status === "ok" ? "ok" : "warn"}
        />
        <SummaryTile
          label="Status"
          value={statusLabel}
          customBadge={statusBadge}
        />
        <SummaryTile
          label="Next expiry"
          value={nextExpiry ?? "—"}
          hint={
            item.expiry_tracking ? "Earliest non-passed lot" : "Not tracked"
          }
          tone={
            nextExpiry && new Date(nextExpiry).getTime() < expiryWindowMs
              ? "warn"
              : "ok"
          }
        />
      </div>

      {canPostMovements ? (
        <section className="mb-8">
          <h2 className="mb-3 font-[family-name:var(--font-heading)] text-xl font-bold text-[color:var(--color-brand-navy)]">
            Record movement
          </h2>
          <MovementForm itemId={item.id} expiryTracking={item.expiry_tracking} />
        </section>
      ) : null}

      <section>
        <h2 className="mb-3 font-[family-name:var(--font-heading)] text-xl font-bold text-[color:var(--color-brand-navy)]">
          Movement history
        </h2>
        <div className="overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
          {(movements ?? []).length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
              No movements yet. Record a receive to set the opening balance.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[800px] text-sm">
                <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                  <tr>
                    <th className="px-4 py-3">When</th>
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3 text-right">Qty</th>
                    <th className="px-4 py-3 text-right">Unit cost</th>
                    <th className="px-4 py-3">Expiry / lot</th>
                    <th className="px-4 py-3">Reference</th>
                    <th className="px-4 py-3">By</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
                  {(movements ?? []).map((m) => {
                    const actor = Array.isArray(m.staff_profiles)
                      ? m.staff_profiles[0]
                      : m.staff_profiles;
                    const qty = Number(m.quantity);
                    const qtyClass =
                      qty > 0 ? "text-emerald-700" : "text-red-700";
                    return (
                      <tr key={m.id}>
                        <td className="px-4 py-2 text-xs text-[color:var(--color-brand-text-soft)]">
                          {m.created_at.slice(0, 16).replace("T", " ")}
                        </td>
                        <td className="px-4 py-2">
                          {TYPE_LABEL[m.movement_type] ?? m.movement_type}
                        </td>
                        <td
                          className={`px-4 py-2 text-right font-mono ${qtyClass}`}
                        >
                          {qty > 0 ? "+" : ""}
                          {qty.toLocaleString()} {item.unit}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-[color:var(--color-brand-text-soft)]">
                          {m.unit_cost_php !== null && m.unit_cost_php !== undefined
                            ? PHP.format(Number(m.unit_cost_php))
                            : "—"}
                        </td>
                        <td className="px-4 py-2 text-xs text-[color:var(--color-brand-text-soft)]">
                          {m.expiry_date ? `exp ${m.expiry_date}` : "—"}
                          {m.lot_number ? ` · ${m.lot_number}` : ""}
                        </td>
                        <td className="px-4 py-2 text-xs text-[color:var(--color-brand-text-soft)]">
                          {m.reference ?? "—"}
                          {m.notes ? (
                            <p className="italic">{m.notes}</p>
                          ) : null}
                        </td>
                        <td className="px-4 py-2 text-xs text-[color:var(--color-brand-text-soft)]">
                          {actor?.full_name ?? "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function SummaryTile({
  label,
  value,
  hint,
  tone = "ok",
  customBadge,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "ok" | "warn";
  customBadge?: string;
}) {
  const accent =
    tone === "warn"
      ? "before:bg-amber-400"
      : "before:bg-[color:var(--color-brand-cyan)]";
  return (
    <article
      className={`relative overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5 before:absolute before:left-0 before:top-0 before:h-full before:w-1 ${accent}`}
    >
      <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        {label}
      </p>
      <p
        className={`mt-2 font-[family-name:var(--font-heading)] ${customBadge ? `inline-block rounded-full border px-3 py-1 text-sm font-bold ${customBadge}` : "text-2xl font-extrabold text-[color:var(--color-brand-navy)]"}`}
      >
        {value}
      </p>
      {hint ? (
        <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
          {hint}
        </p>
      ) : null}
    </article>
  );
}
