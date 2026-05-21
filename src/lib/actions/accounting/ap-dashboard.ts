"use server";

import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { todayManilaISODate } from "@/lib/dates/manila";

type DashboardData = {
  outstanding_total_php: number;
  aging_buckets: { current: number; d1_30: number; d31_60: number; d60_plus: number };
  drafts: { count: number; oldest_age_days: number };
  upcoming_recurring: Array<{
    id: string;
    vendor_name: string;
    description: string;
    next_run_date: string;
    amount_php: number | null;
  }>;
  top_vendors_by_outstanding: Array<{
    vendor_id: string;
    vendor_name: string;
    outstanding_php: number;
  }>;
  wt_accumulated_this_month_php: number;
};

type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

type BillForAging = {
  id: string;
  vendor_id: string;
  due_date: string;
  outstanding_amount: number | null;
  wt_amount: number | null;
  bill_date: string;
  status: string;
  vendors: { name: string } | { name: string }[] | null;
};

type DraftForAge = { id: string; created_at: string };

type UpcomingTemplate = {
  id: string;
  description: string;
  next_run_date: string;
  amount_php: number | null;
  vendors: { name: string } | { name: string }[] | null;
};

type WtBill = { wt_amount: number | null };

function pluckVendor(v: { name: string } | { name: string }[] | null): string {
  if (!v) return "Unknown";
  return Array.isArray(v) ? (v[0]?.name ?? "Unknown") : v.name;
}

export async function getAPDashboardAction(): Promise<ActionResult<DashboardData>> {
  await requireAdminStaff();
  const admin = createAdminClient();

  const today = todayManilaISODate();
  const monthStart = `${today.slice(0, 7)}-01`;

  // -------------------------------------------------------------------------
  // Query 1 — active outstanding bills for aging + vendor summary
  // -------------------------------------------------------------------------
  const { data: billsRaw } = await admin
    .from("bills")
    .select(`
      id,
      vendor_id,
      due_date,
      outstanding_amount,
      wt_amount,
      bill_date,
      status,
      vendors:vendors!vendor_id ( name )
    `)
    .gt("outstanding_amount", 0)
    .neq("status", "voided");

  const bills = (billsRaw ?? []) as BillForAging[];

  const bucket = (dueDate: string): keyof DashboardData["aging_buckets"] => {
    const days = Math.floor((Date.parse(today) - Date.parse(dueDate)) / 86400000);
    if (days <= 0) return "current";
    if (days <= 30) return "d1_30";
    if (days <= 60) return "d31_60";
    return "d60_plus";
  };

  const buckets: DashboardData["aging_buckets"] = { current: 0, d1_30: 0, d31_60: 0, d60_plus: 0 };
  const byVendor = new Map<string, { name: string; outstanding: number }>();
  let outstandingTotal = 0;

  for (const b of bills) {
    const amt = Number(b.outstanding_amount ?? 0);
    outstandingTotal += amt;
    buckets[bucket(b.due_date)] += amt;

    const existing = byVendor.get(b.vendor_id);
    if (existing) {
      existing.outstanding += amt;
    } else {
      byVendor.set(b.vendor_id, { name: pluckVendor(b.vendors), outstanding: amt });
    }
  }

  const topVendors = Array.from(byVendor.entries())
    .sort((a, b) => b[1].outstanding - a[1].outstanding)
    .slice(0, 5)
    .map(([vendor_id, v]) => ({
      vendor_id,
      vendor_name: v.name,
      outstanding_php: v.outstanding,
    }));

  // -------------------------------------------------------------------------
  // Query 2 — drafts for count + oldest age
  // -------------------------------------------------------------------------
  const { data: draftsRaw } = await admin
    .from("bills")
    .select("id, created_at")
    .eq("status", "draft")
    .order("created_at", { ascending: true });

  const drafts = (draftsRaw ?? []) as DraftForAge[];
  const oldestDraft = drafts[0];
  const oldestAgeDays = oldestDraft
    ? Math.floor((Date.now() - Date.parse(oldestDraft.created_at)) / 86400000)
    : 0;

  // -------------------------------------------------------------------------
  // Query 3 — upcoming recurring templates (next 7 days)
  // -------------------------------------------------------------------------
  const nextWeek = new Date();
  nextWeek.setDate(nextWeek.getDate() + 7);

  const { data: upcomingRaw } = await admin
    .from("recurring_bill_templates")
    .select(`
      id,
      description,
      next_run_date,
      amount_php,
      vendors:vendors!vendor_id ( name )
    `)
    .eq("is_active", true)
    .lte("next_run_date", nextWeek.toISOString().slice(0, 10))
    .order("next_run_date");

  const upcomingMapped = ((upcomingRaw ?? []) as UpcomingTemplate[]).map((t) => ({
    id: t.id,
    vendor_name: pluckVendor(t.vendors),
    description: t.description,
    next_run_date: t.next_run_date,
    amount_php: t.amount_php,
  }));

  // -------------------------------------------------------------------------
  // Query 4 — withholding tax accumulated month-to-date
  // -------------------------------------------------------------------------
  const { data: wtRaw } = await admin
    .from("bills")
    .select("wt_amount")
    .gte("bill_date", monthStart)
    .neq("status", "voided");

  const wtTotal = ((wtRaw ?? []) as WtBill[]).reduce(
    (s, b) => s + Number(b.wt_amount ?? 0),
    0
  );

  return {
    ok: true,
    data: {
      outstanding_total_php: outstandingTotal,
      aging_buckets: buckets,
      drafts: { count: drafts.length, oldest_age_days: oldestAgeDays },
      upcoming_recurring: upcomingMapped,
      top_vendors_by_outstanding: topVendors,
      wt_accumulated_this_month_php: wtTotal,
    },
  };
}
