"use client";

import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

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
        <Card className="border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-cyan)]/5">
          <CardHeader className="pb-2">
            <CardDescription className="text-xs font-semibold uppercase tracking-wider">Outstanding total</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="font-mono text-lg tabular-nums">{PHP.format(data.outstanding_total_php)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="text-xs font-semibold uppercase tracking-wider">Current (≤ due date)</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="font-mono text-lg tabular-nums">{PHP.format(data.aging_buckets.current)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="text-xs font-semibold uppercase tracking-wider">1–30 days late</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="font-mono text-lg tabular-nums">{PHP.format(data.aging_buckets.d1_30)}</div>
          </CardContent>
        </Card>
        <Card className={data.aging_buckets.d31_60 > 0 ? "border-amber-400 bg-amber-50" : undefined}>
          <CardHeader className="pb-2">
            <CardDescription className="text-xs font-semibold uppercase tracking-wider">31–60 days late</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="font-mono text-lg tabular-nums">{PHP.format(data.aging_buckets.d31_60)}</div>
          </CardContent>
        </Card>
        <Card className={data.aging_buckets.d60_plus > 0 ? "border-amber-400 bg-amber-50" : undefined}>
          <CardHeader className="pb-2">
            <CardDescription className="text-xs font-semibold uppercase tracking-wider">60+ days late</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="font-mono text-lg tabular-nums">{PHP.format(data.aging_buckets.d60_plus)}</div>
          </CardContent>
        </Card>
      </section>

      {/* Drafts */}
      <Card>
        <CardHeader className="flex flex-row items-baseline justify-between gap-2 space-y-0">
          <CardTitle className="font-[family-name:var(--font-heading)] text-lg font-bold">Drafts</CardTitle>
          <Link
            href="/staff/admin/accounting/ap/bills?status=draft"
            className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)] hover:underline"
          >
            View all drafts →
          </Link>
        </CardHeader>
        <CardContent>
          <p className="text-sm">
            {data.drafts.count} draft{data.drafts.count !== 1 ? "s" : ""}
            {data.drafts.oldest_age_days > 7 && (
              <span className="ml-1 text-amber-700">
                · oldest is {data.drafts.oldest_age_days} days old — review or delete
              </span>
            )}
          </p>
        </CardContent>
      </Card>

      {/* Upcoming recurring */}
      <Card>
        <CardHeader className="flex flex-row items-baseline justify-between gap-2 space-y-0">
          <CardTitle className="font-[family-name:var(--font-heading)] text-lg font-bold">Upcoming recurring (next 7 days)</CardTitle>
          <Link
            href="/staff/admin/accounting/ap/recurring"
            className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)] hover:underline"
          >
            Manage templates →
          </Link>
        </CardHeader>
        <CardContent>
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
        </CardContent>
      </Card>

      {/* Top vendors */}
      <Card>
        <CardHeader className="flex flex-row items-baseline justify-between gap-2 space-y-0">
          <CardTitle className="font-[family-name:var(--font-heading)] text-lg font-bold">Top 5 vendors by outstanding</CardTitle>
          <Link
            href="/staff/admin/accounting/ap/vendors"
            className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)] hover:underline"
          >
            All vendors →
          </Link>
        </CardHeader>
        <CardContent>
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
        </CardContent>
      </Card>

      {/* WT MTD */}
      <Card>
        <CardHeader className="flex flex-row items-baseline justify-between gap-2 space-y-0">
          <CardTitle className="font-[family-name:var(--font-heading)] text-lg font-bold">Withholding tax this month</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="font-mono text-2xl tabular-nums text-[color:var(--color-brand-navy)]">
            {PHP.format(data.wt_accumulated_this_month_php)}
          </p>
          <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
            Accrued on bill posting. Remitted via BIR Form 1601-EQ (out of scope this phase).
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

