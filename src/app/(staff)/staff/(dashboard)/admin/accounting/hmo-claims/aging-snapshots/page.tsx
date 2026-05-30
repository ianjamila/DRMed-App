import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { Panel } from "@/components/ui/panel";

export const metadata = { title: "HMO aging snapshots — staff" };
export const dynamic = "force-dynamic";

const PHP = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
});

interface SnapshotRow {
  snapshot_date: string;
  provider_name: string;
  bucket: string;
  kind: string;
  total_php: number;
  item_count: number;
}

export default async function AgingSnapshotsPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  await requireAdminStaff();
  const sp = await searchParams;
  const admin = createAdminClient();

  // 1) Distinct snapshot dates for the picker.
  const { data: dateRows } = await admin
    .from("hmo_aging_snapshots" as never)
    .select("snapshot_date")
    .order("snapshot_date", { ascending: false })
    .returns<{ snapshot_date: string }[]>();
  const distinctDates = Array.from(new Set((dateRows ?? []).map((r) => r.snapshot_date)));
  const selectedDate = sp.date && distinctDates.includes(sp.date) ? sp.date : distinctDates[0] ?? null;

  // 2) Rows for the chosen date.
  let rows: SnapshotRow[] = [];
  if (selectedDate) {
    const { data } = await admin
      .from("hmo_aging_snapshots" as never)
      .select("snapshot_date, provider_name, bucket, kind, total_php, item_count")
      .eq("snapshot_date", selectedDate)
      .returns<SnapshotRow[]>();
    rows = data ?? [];
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-2">
        <Link
          href="/staff/admin/accounting/hmo-claims"
          className="text-xs font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
        >
          ← HMO claims
        </Link>
      </div>
      <header className="mb-6">
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          Phase 12.3 · Aging snapshots
        </p>
        <h1 className="mt-1 font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          HMO aging snapshots
        </h1>
        <p className="mt-2 text-sm text-[color:var(--color-brand-text-soft)]">
          Point-in-time aging rollups. Take a fresh snapshot from the Aging matrix tab.
        </p>
      </header>

      {distinctDates.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[color:var(--color-brand-bg-mid)] bg-white p-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
          No snapshots yet. Take one from the Aging matrix tab on the main HMO claims page.
        </p>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap gap-2">
            {distinctDates.slice(0, 24).map((d) => (
              <Link
                key={d}
                href={`/staff/admin/accounting/hmo-claims/aging-snapshots?date=${d}`}
                className={
                  "min-h-[36px] rounded-md px-3 py-1.5 text-xs font-bold uppercase tracking-wider " +
                  (d === selectedDate
                    ? "bg-[color:var(--color-brand-navy)] text-white"
                    : "border border-[color:var(--color-brand-bg-mid)] bg-white text-[color:var(--color-brand-navy)]")
                }
              >
                {d}
              </Link>
            ))}
          </div>
          <SnapshotTable rows={rows} />
        </>
      )}
    </div>
  );
}

function SnapshotTable({ rows }: { rows: SnapshotRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-[color:var(--color-brand-bg-mid)] bg-white p-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
        No rows in this snapshot.
      </p>
    );
  }
  // Group by provider; within provider, sum by kind across buckets.
  const buckets = ["0-30", "31-60", "61-90", "91-180", "180+"] as const;
  const byProvider = new Map<string, Map<string, Map<string, number>>>(); // provider → kind → bucket → total
  for (const r of rows) {
    if (!byProvider.has(r.provider_name)) byProvider.set(r.provider_name, new Map());
    const byKind = byProvider.get(r.provider_name)!;
    if (!byKind.has(r.kind)) byKind.set(r.kind, new Map());
    byKind.get(r.kind)!.set(r.bucket, Number(r.total_php));
  }
  const providers = Array.from(byProvider.keys()).sort();

  return (
    <Panel className="overflow-x-auto">
      <table className="w-full min-w-[900px] text-sm">
        <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          <tr>
            <th className="px-4 py-3">Provider</th>
            <th className="px-4 py-3">Kind</th>
            {buckets.map((b) => (
              <th key={b} className="px-4 py-3 text-right">{b}</th>
            ))}
            <th className="px-4 py-3 text-right">Total</th>
          </tr>
        </thead>
        <tbody>
          {providers.flatMap((p) => {
            const byKind = byProvider.get(p)!;
            const kinds = Array.from(byKind.keys()).sort();
            return kinds.map((k) => {
              const byBucket = byKind.get(k)!;
              const total = buckets.reduce((s, b) => s + (byBucket.get(b) ?? 0), 0);
              return (
                <tr key={`${p}-${k}`} className="border-t border-[color:var(--color-brand-bg-mid)]">
                  <td className="px-4 py-3">{p}</td>
                  <td className="px-4 py-3 text-xs">
                    <span
                      className={
                        "rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider " +
                        (k === "doctor" ? "bg-indigo-100 text-indigo-800" : "bg-sky-100 text-sky-800")
                      }
                    >
                      {k}
                    </span>
                  </td>
                  {buckets.map((b) => (
                    <td key={b} className="px-4 py-3 text-right font-mono text-xs">
                      {byBucket.has(b) ? PHP.format(byBucket.get(b)!) : "—"}
                    </td>
                  ))}
                  <td className="px-4 py-3 text-right font-semibold">{PHP.format(total)}</td>
                </tr>
              );
            });
          })}
        </tbody>
      </table>
    </Panel>
  );
}
