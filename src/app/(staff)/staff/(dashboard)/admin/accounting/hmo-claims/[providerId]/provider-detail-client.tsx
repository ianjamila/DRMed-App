"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { Database } from "@/types/database";

type SummaryRow =
  Database["public"]["Views"]["v_hmo_provider_summary"]["Row"];
type UnbilledRow = Database["public"]["Views"]["v_hmo_unbilled"]["Row"];
type AgingRow = Database["public"]["Views"]["v_hmo_ar_aging"]["Row"];

type BatchRow = Pick<
  Database["public"]["Tables"]["hmo_claim_batches"]["Row"],
  "id" | "status" | "reference_no" | "submitted_at" | "voided_at" | "created_at"
>;

const PHP = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
});

const BUCKET_ORDER = ["0-30", "31-60", "61-90", "91-180", "180+"] as const;

type Tab = "batches" | "unbilled" | "aging";

const TAB_LABELS: Record<Tab, string> = {
  batches: "Batches",
  unbilled: "Unbilled",
  aging: "Aging",
};

export function ProviderDetailClient({
  providerId,
  summary,
  batches,
  unbilled,
  aging,
}: {
  providerId: string;
  summary: SummaryRow | null;
  batches: BatchRow[];
  unbilled: UnbilledRow[];
  aging: AgingRow[];
}) {
  const [tab, setTab] = useState<Tab>("batches");

  return (
    <div className="space-y-4">
      {summary ? <SummaryStrip summary={summary} /> : null}
      <nav className="flex flex-wrap gap-2" aria-label="Provider detail tabs">
        {(Object.keys(TAB_LABELS) as Tab[]).map((t) => {
          const active = t === tab;
          return (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              aria-pressed={active}
              className={
                "min-h-[44px] rounded-md px-3 text-xs font-bold uppercase tracking-wider " +
                (active
                  ? "bg-[color:var(--color-brand-navy)] text-white"
                  : "border border-[color:var(--color-brand-bg-mid)] bg-white text-[color:var(--color-brand-navy)]")
              }
            >
              {TAB_LABELS[t]}
            </button>
          );
        })}
      </nav>
      {tab === "batches" && <BatchesTab batches={batches} />}
      {tab === "unbilled" && (
        <UnbilledTab providerId={providerId} rows={unbilled} />
      )}
      {tab === "aging" && <AgingTab rows={aging} />}
    </div>
  );
}

function SummaryStrip({ summary }: { summary: SummaryRow }) {
  const cells: { label: string; value: string; tone?: "danger" }[] = [
    {
      label: "Unresolved AR",
      value: PHP.format(summary.total_unresolved_ar_php ?? 0),
    },
    {
      label: "Unbilled",
      value: PHP.format(summary.total_unbilled_php ?? 0),
    },
    {
      label: "Stuck",
      value: PHP.format(summary.total_stuck_php ?? 0),
      tone: (summary.total_stuck_php ?? 0) > 0 ? "danger" : undefined,
    },
    {
      label: "Paid YTD",
      value: PHP.format(summary.paid_ytd_php ?? 0),
    },
  ];
  return (
    <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {cells.map((c) => (
        <div
          key={c.label}
          className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-3"
        >
          <dt className="text-xs uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            {c.label}
          </dt>
          <dd
            className={
              "mt-1 text-lg font-semibold " +
              (c.tone === "danger"
                ? "text-red-600"
                : "text-[color:var(--color-brand-navy)]")
            }
          >
            {c.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone = STATUS_TONE[status] ?? STATUS_TONE.draft;
  return (
    <span
      className={
        "inline-block rounded-full px-2 py-0.5 text-xs font-semibold uppercase tracking-wider " +
        tone
      }
    >
      {status}
    </span>
  );
}

const STATUS_TONE: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700",
  submitted: "bg-blue-100 text-blue-800",
  acknowledged: "bg-indigo-100 text-indigo-800",
  partial_paid: "bg-amber-100 text-amber-800",
  paid: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-800",
  voided: "bg-gray-200 text-gray-500 line-through",
};

function BatchesTab({ batches }: { batches: BatchRow[] }) {
  const [showVoided, setShowVoided] = useState(false);
  const visible = useMemo(
    () => (showVoided ? batches : batches.filter((b) => !b.voided_at)),
    [batches, showVoided],
  );

  if (batches.length === 0) {
    return <EmptyState message="No batches yet — start with a new batch." />;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end">
        <label className="inline-flex min-h-[44px] cursor-pointer items-center gap-2 text-xs font-semibold text-[color:var(--color-brand-navy)]">
          <input
            type="checkbox"
            checked={showVoided}
            onChange={(e) => setShowVoided(e.target.checked)}
            className="h-4 w-4"
          />
          Show voided
        </label>
      </div>
      {visible.length === 0 ? (
        <EmptyState message="No batches matching this filter." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              <tr>
                <th className="px-4 py-3">Reference</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Submitted</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((b) => {
                const isVoided = Boolean(b.voided_at);
                return (
                  <tr
                    key={b.id}
                    className={
                      "border-t border-[color:var(--color-brand-bg-mid)] " +
                      (isVoided ? "opacity-60" : "")
                    }
                  >
                    <td
                      className={
                        "px-4 py-3 font-mono text-xs " +
                        (isVoided ? "line-through" : "")
                      }
                    >
                      {b.reference_no ?? `#${b.id.slice(0, 8)}`}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge
                        status={isVoided ? "voided" : b.status}
                      />
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {b.submitted_at
                        ? new Date(b.submitted_at).toLocaleDateString("en-PH")
                        : "—"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/staff/admin/accounting/hmo-claims/batches/${b.id}`}
                        aria-label={`Open batch ${b.reference_no ?? b.id.slice(0, 8)}`}
                        className="text-xs font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
                      >
                        Open
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function UnbilledTab({
  providerId,
  rows,
}: {
  providerId: string;
  rows: UnbilledRow[];
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const selectableIds = useMemo(
    () =>
      rows
        .map((r) => r.test_request_id)
        .filter((id): id is string => Boolean(id)),
    [rows],
  );

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (selected.size === selectableIds.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(selectableIds));
    }
  }

  const selectedTotal = useMemo(() => {
    let total = 0;
    for (const r of rows) {
      if (r.test_request_id && selected.has(r.test_request_id)) {
        total += r.billed_amount_php ?? 0;
      }
    }
    return total;
  }, [rows, selected]);

  if (rows.length === 0) {
    return <EmptyState message="No unbilled items." />;
  }

  const allSelected =
    selectableIds.length > 0 && selected.size === selectableIds.length;
  const trIds = Array.from(selected).join(",");
  const newBatchHref = `/staff/admin/accounting/hmo-claims/batches/new?providerId=${providerId}&trIds=${trIds}`;

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-4 py-3">
                <label className="inline-flex min-h-[44px] items-center">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    aria-label="Select all unbilled items"
                    className="h-4 w-4"
                  />
                </label>
              </th>
              <th className="px-4 py-3">Released</th>
              <th className="px-4 py-3 text-right">Age (days)</th>
              <th className="px-4 py-3 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const id = r.test_request_id;
              const isSelected = id ? selected.has(id) : false;
              return (
                <tr
                  key={id ?? `${r.visit_id}-${r.released_at}`}
                  className={
                    "border-t border-[color:var(--color-brand-bg-mid)] " +
                    (r.past_threshold ? "bg-amber-50" : "")
                  }
                >
                  <td className="px-4 py-3">
                    <label className="inline-flex min-h-[44px] items-center">
                      <input
                        type="checkbox"
                        disabled={!id}
                        checked={isSelected}
                        onChange={() => id && toggle(id)}
                        aria-label={`Select item ${id ?? ""}`}
                        className="h-4 w-4"
                      />
                    </label>
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {r.released_at
                      ? new Date(r.released_at).toLocaleDateString("en-PH")
                      : "—"}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-xs">
                    {r.days_since_release ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-right font-semibold">
                    {PHP.format(r.billed_amount_php ?? 0)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-3 shadow-sm">
        <div className="text-xs text-[color:var(--color-brand-text-soft)]">
          <span className="font-semibold text-[color:var(--color-brand-navy)]">
            {selected.size}
          </span>{" "}
          selected · total{" "}
          <span className="font-semibold text-[color:var(--color-brand-navy)]">
            {PHP.format(selectedTotal)}
          </span>
        </div>
        {selected.size > 0 ? (
          <Link
            href={newBatchHref}
            className="min-h-[44px] rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-xs font-bold uppercase tracking-wider text-white"
          >
            Add {selected.size} item{selected.size === 1 ? "" : "s"} to new
            batch
          </Link>
        ) : (
          <button
            type="button"
            disabled
            className="min-h-[44px] rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-2 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]"
          >
            Select items to start a batch
          </button>
        )}
      </div>
    </div>
  );
}

const BUCKET_COLORS: Record<(typeof BUCKET_ORDER)[number], string> = {
  "0-30": "bg-emerald-500",
  "31-60": "bg-yellow-500",
  "61-90": "bg-amber-500",
  "91-180": "bg-orange-500",
  "180+": "bg-red-600",
};

function AgingTab({ rows }: { rows: AgingRow[] }) {
  if (rows.length === 0) {
    return <EmptyState message="No aging data." />;
  }
  const byBucket = new Map<string, AgingRow>();
  for (const r of rows) {
    if (r.bucket) byBucket.set(r.bucket, r);
  }
  const bucketTotals = BUCKET_ORDER.map((b) => ({
    bucket: b,
    total: byBucket.get(b)?.total_php ?? 0,
  }));
  const grandTotal = bucketTotals.reduce((sum, x) => sum + x.total, 0);
  const ariaSummary = bucketTotals
    .filter(({ total }) => total > 0)
    .map(
      ({ bucket, total }) =>
        `${Math.round((total / grandTotal) * 100)}% in ${bucket} days`,
    )
    .join(", ");
  return (
    <div className="space-y-4">
      {grandTotal > 0 ? (
        <div className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4">
          <div
            role="img"
            aria-label={`Aging breakdown: ${ariaSummary}`}
            className="flex h-3 w-full overflow-hidden rounded-full bg-[color:var(--color-brand-bg)]"
          >
            {bucketTotals.map(({ bucket, total }) =>
              total > 0 ? (
                <div
                  key={bucket}
                  className={BUCKET_COLORS[bucket]}
                  style={{ width: `${(total / grandTotal) * 100}%` }}
                />
              ) : null,
            )}
          </div>
          <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {bucketTotals.map(({ bucket, total }) => (
              <li key={bucket} className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className={
                    "inline-block h-2.5 w-2.5 rounded-sm " +
                    BUCKET_COLORS[bucket]
                  }
                />
                <span className="font-mono text-[color:var(--color-brand-text-soft)]">
                  {bucket}
                </span>
                <span className="font-semibold text-[color:var(--color-brand-navy)]">
                  {total > 0 ? PHP.format(total) : "—"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        <table className="w-full min-w-[480px] text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-4 py-3">Bucket</th>
              <th className="px-4 py-3 text-right">Items</th>
              <th className="px-4 py-3 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {BUCKET_ORDER.map((b) => {
              const r = byBucket.get(b);
              const count = r?.item_count ?? 0;
              const total = r?.total_php ?? 0;
              return (
                <tr
                  key={b}
                  className="border-t border-[color:var(--color-brand-bg-mid)]"
                >
                  <td className="px-4 py-3 font-mono text-xs">{b}</td>
                  <td className="px-4 py-3 text-right font-mono text-xs">
                    {count}
                  </td>
                  <td className="px-4 py-3 text-right font-semibold">
                    {total > 0 ? PHP.format(total) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-dashed border-[color:var(--color-brand-bg-mid)] bg-white p-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
      {message}
    </div>
  );
}
