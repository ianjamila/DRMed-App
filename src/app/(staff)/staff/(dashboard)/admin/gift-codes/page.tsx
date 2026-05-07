import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { Button } from "@/components/ui/button";
import { formatPhp } from "@/lib/marketing/format";
import {
  GIFT_CODE_STATUSES,
  STATUS_BADGE,
  STATUS_LABELS,
  type GiftCodeStatus,
} from "@/lib/gift-codes/labels";

export const metadata = { title: "Gift codes — staff" };

export const dynamic = "force-dynamic";

type StatusFilter = GiftCodeStatus | "all";

const STATUS_FILTERS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: "generated", label: "Generated" },
  { value: "purchased", label: "Purchased" },
  { value: "redeemed", label: "Redeemed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "all", label: "All" },
];

interface PageProps {
  searchParams: Promise<{ status?: string; q?: string; batch_label?: string }>;
}

export default async function GiftCodesAdminPage({ searchParams }: PageProps) {
  await requireAdminStaff();
  const params = await searchParams;
  const status: StatusFilter = (
    [...GIFT_CODE_STATUSES, "all"] as ReadonlyArray<StatusFilter>
  ).includes(params.status as StatusFilter)
    ? (params.status as StatusFilter)
    : "generated";
  const q = params.q?.trim() ?? "";
  const batchLabel = params.batch_label?.trim() ?? "";

  const admin = createAdminClient();

  const counts = Object.fromEntries(
    await Promise.all(
      GIFT_CODE_STATUSES.map(async (s) => {
        const { count } = await admin
          .from("gift_codes")
          .select("id", { count: "exact", head: true })
          .eq("status", s);
        return [s, count ?? 0] as const;
      }),
    ),
  ) as Record<GiftCodeStatus, number>;
  const totalCount =
    counts.generated + counts.purchased + counts.redeemed + counts.cancelled;

  let query = admin
    .from("gift_codes")
    .select(
      "id, code, face_value_php, status, batch_label, generated_at, purchased_at, redeemed_at, purchased_by_name",
    )
    .order("generated_at", { ascending: false })
    .limit(100);

  if (status !== "all") query = query.eq("status", status);
  if (batchLabel) query = query.eq("batch_label", batchLabel);
  if (q) {
    const like = `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`;
    query = query.or(
      [`code.ilike.${like}`, `batch_label.ilike.${like}`].join(","),
    );
  }

  const { data: rows, error } = await query;
  if (error) console.error("gift_codes query failed", error);
  const codes = rows ?? [];

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
            Phase 11 · Admin
          </p>
          <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            Gift codes
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
            Pre-issued vouchers reception sells at the counter and customers
            redeem against future visits. Codes are whole-use — applying a
            ₱500 code to a ₱300 visit forfeits the ₱200 balance.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/staff/admin/gift-codes/sales"
            className="rounded-md border border-[color:var(--color-brand-navy)] bg-white px-4 py-2 text-sm font-bold text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-bg)]"
          >
            Sales report
          </Link>
          <Link
            href="/staff/admin/gift-codes/generate"
            className="rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold text-white hover:bg-[color:var(--color-brand-cyan)]"
          >
            + Generate batch
          </Link>
        </div>
      </header>

      <nav className="mb-4 flex flex-wrap gap-2">
        {STATUS_FILTERS.map((f) => {
          const active = f.value === status;
          const sp = new URLSearchParams();
          if (f.value !== "generated") sp.set("status", f.value);
          if (q) sp.set("q", q);
          if (batchLabel) sp.set("batch_label", batchLabel);
          const qs = sp.toString();
          const href = qs
            ? `/staff/admin/gift-codes?${qs}`
            : "/staff/admin/gift-codes";
          const count =
            f.value === "all" ? totalCount : counts[f.value];
          return (
            <Link
              key={f.value}
              href={href}
              className={`rounded-full border px-3 py-1.5 text-xs font-bold uppercase tracking-wider transition-colors ${
                active
                  ? "border-[color:var(--color-brand-navy)] bg-[color:var(--color-brand-navy)] text-white"
                  : "border-[color:var(--color-brand-bg-mid)] bg-white text-[color:var(--color-brand-text-mid)] hover:border-[color:var(--color-brand-cyan)] hover:text-[color:var(--color-brand-navy)]"
              }`}
            >
              {f.label} · {count}
            </Link>
          );
        })}
      </nav>

      <form className="mb-6 flex max-w-xl gap-2">
        {status !== "generated" ? (
          <input type="hidden" name="status" value={status} />
        ) : null}
        {batchLabel ? (
          <input type="hidden" name="batch_label" value={batchLabel} />
        ) : null}
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Code or batch label"
          className="flex-1 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        />
        <Button
          type="submit"
          className="bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]"
        >
          Search
        </Button>
      </form>

      {batchLabel ? (
        <div className="mb-4 flex items-center gap-2 rounded-md bg-[color:var(--color-brand-bg)] px-3 py-2 text-xs text-[color:var(--color-brand-text-mid)]">
          <span>
            Filtered to batch <strong>{batchLabel}</strong>
          </span>
          <Link
            href={`/staff/admin/gift-codes${
              status !== "generated" ? `?status=${status}` : ""
            }`}
            className="font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
          >
            Clear
          </Link>
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-4 py-3">Code</th>
              <th className="px-4 py-3">Face value</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Batch</th>
              <th className="px-4 py-3">Buyer</th>
              <th className="px-4 py-3">Last event</th>
              <th className="px-4 py-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {codes.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                >
                  No gift codes match.
                </td>
              </tr>
            ) : (
              codes.map((c) => (
                <tr key={c.id} className="hover:bg-[color:var(--color-brand-bg)]">
                  <td className="px-4 py-3 font-mono text-[color:var(--color-brand-navy)]">
                    {c.code}
                  </td>
                  <td className="px-4 py-3 font-semibold">
                    {formatPhp(c.face_value_php)}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
                        STATUS_BADGE[c.status as GiftCodeStatus]
                      }`}
                    >
                      {STATUS_LABELS[c.status as GiftCodeStatus]}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                    {c.batch_label ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                    {c.purchased_by_name ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)] whitespace-nowrap">
                    {formatLastEvent(c)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/staff/admin/gift-codes/${c.id}`}
                      className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-bg)]"
                    >
                      Open
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {codes.length === 100 ? (
        <p className="mt-4 text-xs text-[color:var(--color-brand-text-soft)]">
          Showing the most recent 100. Refine the filters to find older
          codes.
        </p>
      ) : null}
    </div>
  );
}

interface CodeRow {
  generated_at: string;
  purchased_at: string | null;
  redeemed_at: string | null;
}

function formatLastEvent(c: CodeRow): string {
  const iso = c.redeemed_at ?? c.purchased_at ?? c.generated_at;
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    year: "2-digit",
    month: "short",
    day: "numeric",
  }).format(new Date(iso));
}
