import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { formatPhp } from "@/lib/marketing/format";

export const metadata = { title: "Discounts — staff" };

export const dynamic = "force-dynamic";

export default async function DiscountsIndex() {
  await requireAdminStaff();
  const admin = createAdminClient();

  const { data: types } = await admin
    .from("discount_types")
    .select(
      "id, code, label, kind, percent, amount_php, is_statutory, active, sort_order",
    )
    .order("active", { ascending: false })
    .order("sort_order", { ascending: true })
    .order("label", { ascending: true });

  const rows = (types ?? []).map((t) => ({
    ...t,
    percent: t.percent != null ? Number(t.percent) : null,
    amount_php: t.amount_php != null ? Number(t.amount_php) : null,
  }));
  const active = rows.filter((t) => t.active);
  const inactive = rows.filter((t) => !t.active);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
            Admin
          </p>
          <h1 className="mt-1 font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            Discounts
          </h1>
          <p className="mt-2 max-w-xl text-sm text-[color:var(--color-brand-text-soft)]">
            The discounts reception can apply per line on a new visit — percent
            off or a fixed peso amount. Senior / PWD is statutory (fixed 20%,
            RA 9994 / RA 10754) and can&apos;t be changed or switched off.
            Deactivate a discount to retire it; past visits keep whatever was
            recorded.
          </p>
        </div>
        <Link
          href="/staff/admin/discounts/new"
          className="shrink-0 rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-white hover:bg-[color:var(--color-brand-cyan)]"
        >
          + New discount
        </Link>
      </header>

      <Section title={`Active (${active.length})`} rows={active} />

      {inactive.length > 0 ? (
        <Section
          title={`Inactive (${inactive.length})`}
          rows={inactive}
          muted
        />
      ) : null}
    </div>
  );
}

interface DiscountRow {
  id: string;
  code: string;
  label: string;
  kind: string;
  percent: number | null;
  amount_php: number | null;
  is_statutory: boolean;
  active: boolean;
  sort_order: number;
}

function rateLabel(t: DiscountRow): string {
  if (t.kind === "percent" && t.percent != null) {
    return `${Number.isInteger(t.percent) ? t.percent : t.percent.toFixed(2)}% off`;
  }
  if (t.kind === "fixed" && t.amount_php != null) {
    return `${formatPhp(t.amount_php)} off`;
  }
  return "Amount typed at the counter";
}

function Section({
  title,
  rows,
  muted = false,
}: {
  title: string;
  rows: DiscountRow[];
  muted?: boolean;
}) {
  return (
    <section className="mt-2">
      <h2 className="font-heading text-sm font-extrabold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        {title}
      </h2>
      {rows.length === 0 ? (
        <p className="mt-2 rounded-lg border border-dashed border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-3 text-sm text-[color:var(--color-brand-text-soft)]">
          No discounts yet.
        </p>
      ) : (
        <ul
          className={`mt-2 divide-y divide-[color:var(--color-brand-bg-mid)] rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white ${
            muted ? "opacity-60" : ""
          }`}
        >
          {rows.map((t) => (
            <li
              key={t.id}
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
            >
              <div className="min-w-0">
                <p className="truncate font-semibold text-[color:var(--color-brand-navy)]">
                  {t.label}
                  {t.is_statutory ? (
                    <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-800">
                      Statutory
                    </span>
                  ) : null}
                </p>
                <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                  {rateLabel(t)}
                  <span className="ml-2 font-mono text-[10px]">{t.code}</span>
                </p>
              </div>
              <Link
                href={`/staff/admin/discounts/${t.id}/edit`}
                className="shrink-0 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-bg)]"
              >
                Edit
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
