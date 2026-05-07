import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import {
  CHANNEL_LABELS,
  STATUS_LABELS,
  type InquiryChannel,
  type InquiryStatus,
} from "@/lib/inquiries/labels";

export const metadata = {
  title: "Inquiries — staff",
};

export const dynamic = "force-dynamic";

type StatusFilter = InquiryStatus | "all";

const STATUS_FILTERS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: "pending", label: "Pending" },
  { value: "confirmed", label: "Confirmed" },
  { value: "dropped", label: "Dropped" },
  { value: "all", label: "All" },
];

interface PageProps {
  searchParams: Promise<{ status?: string; q?: string }>;
}

export default async function InquiriesPage({ searchParams }: PageProps) {
  await requireActiveStaff();
  const params = await searchParams;
  const status: StatusFilter = (
    ["pending", "confirmed", "dropped", "all"] as const
  ).includes(params.status as StatusFilter)
    ? (params.status as StatusFilter)
    : "pending";
  const q = params.q?.trim() ?? "";

  const supabase = await createClient();

  // Counts per status — drives the filter chips. Cheap (small table, indexed).
  const [pending, confirmed, dropped] = await Promise.all([
    supabase.from("inquiries").select("id", { count: "exact", head: true }).eq("status", "pending"),
    supabase.from("inquiries").select("id", { count: "exact", head: true }).eq("status", "confirmed"),
    supabase.from("inquiries").select("id", { count: "exact", head: true }).eq("status", "dropped"),
  ]);
  const counts = {
    pending: pending.count ?? 0,
    confirmed: confirmed.count ?? 0,
    dropped: dropped.count ?? 0,
    all: (pending.count ?? 0) + (confirmed.count ?? 0) + (dropped.count ?? 0),
  } as const;

  let query = supabase
    .from("inquiries")
    .select(
      "id, caller_name, contact, channel, called_at, status, notes, received_by_id, linked_appointment_id, linked_visit_id",
    )
    .order("called_at", { ascending: false })
    .limit(50);

  if (status !== "all") query = query.eq("status", status);

  if (q) {
    const like = `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`;
    query = query.or(
      [
        `caller_name.ilike.${like}`,
        `contact.ilike.${like}`,
        `service_interest.ilike.${like}`,
      ].join(","),
    );
  }

  const { data: rows, error } = await query;
  if (error) console.error("inquiries query failed", error);

  const inquiries = rows ?? [];

  // Resolve received_by names via staff_profiles (FK is to auth.users; we
  // join through staff_profiles.id).
  const receivedIds = Array.from(
    new Set(inquiries.map((r) => r.received_by_id).filter(Boolean)),
  ) as string[];
  const nameMap = new Map<string, string>();
  if (receivedIds.length > 0) {
    const { data: profiles } = await supabase
      .from("staff_profiles")
      .select("id, full_name")
      .in("id", receivedIds);
    for (const p of profiles ?? []) nameMap.set(p.id, p.full_name);
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
            Phase 10 · Reception
          </p>
          <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            Inquiries
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
            Phone leads, FB messages, and walk-ins that haven&apos;t booked yet.
            Confirm them when reception books an appointment, or drop with a
            reason if they decided not to push through.
          </p>
        </div>
        <Link
          href="/staff/inquiries/new"
          className="rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold text-white hover:bg-[color:var(--color-brand-cyan)]"
        >
          + New inquiry
        </Link>
      </header>

      <nav className="mb-4 flex flex-wrap gap-2">
        {STATUS_FILTERS.map((f) => {
          const active = f.value === status;
          const href = (() => {
            const sp = new URLSearchParams();
            if (f.value !== "pending") sp.set("status", f.value);
            if (q) sp.set("q", q);
            const qs = sp.toString();
            return qs ? `/staff/inquiries?${qs}` : "/staff/inquiries";
          })();
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
              {f.label} · {counts[f.value]}
            </Link>
          );
        })}
      </nav>

      <form className="mb-6 flex max-w-xl gap-2">
        {status !== "pending" ? (
          <input type="hidden" name="status" value={status} />
        ) : null}
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Caller name, phone, or service interest"
          className="flex-1 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        />
        <Button
          type="submit"
          className="bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]"
        >
          Search
        </Button>
      </form>

      <div className="overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-4 py-3">Caller</th>
              <th className="px-4 py-3">Contact</th>
              <th className="px-4 py-3">Channel</th>
              <th className="px-4 py-3">Called</th>
              <th className="px-4 py-3">Received by</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Notes</th>
              <th className="px-4 py-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {inquiries.length === 0 ? (
              <tr>
                <td
                  colSpan={8}
                  className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                >
                  {q
                    ? "No inquiries match this search."
                    : status === "pending"
                      ? "No pending inquiries — nice."
                      : "Nothing here yet."}
                </td>
              </tr>
            ) : (
              inquiries.map((r) => (
                <tr
                  key={r.id}
                  className="align-top hover:bg-[color:var(--color-brand-bg)]"
                >
                  <td className="px-4 py-3 font-semibold text-[color:var(--color-brand-navy)]">
                    {r.caller_name}
                  </td>
                  <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                    {r.contact}
                  </td>
                  <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                    {CHANNEL_LABELS[r.channel as InquiryChannel] ?? r.channel}
                  </td>
                  <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)] whitespace-nowrap">
                    {formatCalled(r.called_at)}
                  </td>
                  <td className="px-4 py-3 text-[color:var(--color-brand-text-mid)]">
                    {r.received_by_id
                      ? nameMap.get(r.received_by_id) ?? "—"
                      : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={r.status as InquiryStatus} />
                  </td>
                  <td className="max-w-xs px-4 py-3 text-xs text-[color:var(--color-brand-text-soft)]">
                    {r.notes ? (
                      <span className="line-clamp-2">{r.notes}</span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/staff/inquiries/${r.id}/edit`}
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

      {inquiries.length === 50 ? (
        <p className="mt-4 text-xs text-[color:var(--color-brand-text-soft)]">
          Showing the most recent 50. Refine your search to find older
          inquiries.
        </p>
      ) : null}
    </div>
  );
}

function formatCalled(iso: string): string {
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

function StatusBadge({ status }: { status: InquiryStatus }) {
  const cls = {
    pending: "bg-amber-100 text-amber-900",
    confirmed: "bg-emerald-100 text-emerald-900",
    dropped: "bg-zinc-100 text-zinc-700",
  }[status];
  return (
    <span
      className={`rounded-md px-2 py-0.5 text-xs font-semibold ${cls}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}
