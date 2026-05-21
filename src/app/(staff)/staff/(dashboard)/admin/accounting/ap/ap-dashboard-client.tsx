"use client";

import Link from "next/link";

const PHP = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" });

type AgingBuckets = {
  current: number;
  d1_30: number;
  d31_60: number;
  d60_plus: number;
};

type UpcomingTemplate = {
  id: string;
  vendor_name: string;
  description: string;
  next_run_date: string;
  amount_php: number | null;
};

type TopVendor = {
  vendor_id: string;
  vendor_name: string;
  outstanding_php: number;
};

type Drafts = { count: number; oldest_age_days: number };

type DashboardData = {
  outstanding_total_php: number;
  aging_buckets: AgingBuckets;
  drafts: Drafts;
  upcoming_recurring: UpcomingTemplate[];
  top_vendors_by_outstanding: TopVendor[];
  wt_accumulated_this_month_php: number;
};

export function APDashboardClient({ data }: { data: DashboardData }) {
  return (
    <div className="space-y-6">
      {/* Aging row — 5 cards */}
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Card title="Outstanding total" value={PHP.format(data.outstanding_total_php)} accent />
        <Card title="Current (≤ due date)" value={PHP.format(data.aging_buckets.current)} />
        <Card title="1–30 days late" value={PHP.format(data.aging_buckets.d1_30)} />
        <Card
          title="31–60 days late"
          value={PHP.format(data.aging_buckets.d31_60)}
          highlight={data.aging_buckets.d31_60 > 0}
        />
        <Card
          title="60+ days late"
          value={PHP.format(data.aging_buckets.d60_plus)}
          highlight={data.aging_buckets.d60_plus > 0}
        />
      </section>

      {/* Drafts */}
      <Section
        title="Drafts"
        viewAllHref="/staff/admin/accounting/ap/bills?status=draft"
        viewAllLabel="View all drafts"
      >
        <p className="text-sm">
          {data.drafts.count} draft{data.drafts.count !== 1 ? "s" : ""}
          {data.drafts.oldest_age_days > 7 && (
            <span className="ml-1 text-amber-700">
              · oldest is {data.drafts.oldest_age_days} days old — review or delete
            </span>
          )}
        </p>
      </Section>

      {/* Upcoming recurring */}
      <Section
        title="Upcoming recurring (next 7 days)"
        viewAllHref="/staff/admin/accounting/ap/recurring"
        viewAllLabel="Manage templates"
      >
        {data.upcoming_recurring.length === 0 ? (
          <p className="text-sm text-[color:var(--color-brand-text-soft)]">None scheduled.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {data.upcoming_recurring.map((t) => (
              <li key={t.id} className="py-2 text-sm">
                <span className="font-mono text-[color:var(--color-brand-text-soft)]">{t.next_run_date}</span>
                {" · "}
                <span className="font-medium text-[color:var(--color-brand-navy)]">{t.vendor_name}</span>
                {": "}
                {t.description}
                {t.amount_php != null && (
                  <span className="ml-2 tabular-nums text-[color:var(--color-brand-text-soft)]">
                    ({PHP.format(t.amount_php)})
                  </span>
                )}
                {t.amount_php == null && (
                  <span className="ml-2 text-xs italic text-[color:var(--color-brand-text-soft)]">
                    variable amount
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Top vendors */}
      <Section
        title="Top 5 vendors by outstanding"
        viewAllHref="/staff/admin/accounting/ap/vendors"
        viewAllLabel="All vendors"
      >
        {data.top_vendors_by_outstanding.length === 0 ? (
          <p className="text-sm text-[color:var(--color-brand-text-soft)]">No outstanding bills.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {data.top_vendors_by_outstanding.map((v) => (
              <li key={v.vendor_id} className="flex items-center justify-between py-2 text-sm">
                <Link
                  href={`/staff/admin/accounting/ap/vendors/${v.vendor_id}`}
                  className="font-medium text-[color:var(--color-brand-navy)] hover:underline"
                >
                  {v.vendor_name}
                </Link>
                <span className="font-mono tabular-nums">{PHP.format(v.outstanding_php)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* WT MTD */}
      <Section title="Withholding tax this month">
        <p className="font-mono text-2xl tabular-nums text-[color:var(--color-brand-navy)]">
          {PHP.format(data.wt_accumulated_this_month_php)}
        </p>
        <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
          Accrued on bill posting. Remitted via BIR Form 1601-EQ (out of scope this phase).
        </p>
      </Section>
    </div>
  );
}

function Card({
  title,
  value,
  accent,
  highlight,
}: {
  title: string;
  value: string;
  accent?: boolean;
  highlight?: boolean;
}) {
  const border = accent
    ? "border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-cyan)]/5"
    : highlight
      ? "border-amber-400 bg-amber-50"
      : "border-gray-200 bg-white";
  return (
    <div className={`rounded-md border p-3 ${border}`}>
      <div className="text-xs font-semibold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        {title}
      </div>
      <div className="mt-1 font-mono text-lg tabular-nums text-[color:var(--color-brand-navy)]">
        {value}
      </div>
    </div>
  );
}

function Section({
  title,
  children,
  viewAllHref,
  viewAllLabel,
}: {
  title: string;
  children: React.ReactNode;
  viewAllHref?: string;
  viewAllLabel?: string;
}) {
  return (
    <section className="rounded-md border border-gray-200 bg-white p-4">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-[family-name:var(--font-heading)] text-lg font-bold text-[color:var(--color-brand-navy)]">
          {title}
        </h2>
        {viewAllHref && (
          <Link
            href={viewAllHref}
            className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)] hover:underline"
          >
            {viewAllLabel ?? "View all"} →
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}
