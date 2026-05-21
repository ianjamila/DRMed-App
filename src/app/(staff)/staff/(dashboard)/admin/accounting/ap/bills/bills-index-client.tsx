"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TriangleAlert } from "lucide-react";
import { StatusBadge } from "@/lib/ui/status-badge";

const PHP = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" });

type Vendor = { id: string; name: string };

type Bill = {
  id: string;
  bill_number: string;
  vendor_id: string;
  vendor_name: string | null;
  vendor_invoice_number: string | null;
  bill_date: string;
  due_date: string;
  status: string;
  gross_amount: number;
  wt_amount: number;
  net_payable: number;
  paid_amount: number;
  outstanding_amount: number;
  description: string | null;
  created_at: string;
};

type Filter = {
  vendor_id: string;
  status: string;
  has_wt: boolean;
  q: string;
};

const STATUSES = ["draft", "posted", "partially_paid", "paid", "voided"] as const;

const NOW_MS = Date.now();

export function BillsIndexClient({
  initialBills,
  vendors,
  initialFilter,
}: {
  initialBills: Bill[];
  vendors: Vendor[];
  initialFilter: Filter;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [filter, setFilter] = useState<Filter>(initialFilter);

  function applyFilters() {
    const next = new URLSearchParams();
    if (filter.vendor_id) next.set("vendor_id", filter.vendor_id);
    if (filter.status) next.set("status", filter.status);
    if (filter.has_wt) next.set("has_wt", "1");
    if (filter.q) next.set("q", filter.q);
    startTransition(() => {
      router.push(`/staff/admin/accounting/ap/bills?${next.toString()}`);
    });
  }

  function clearFilters() {
    setFilter({ vendor_id: "", status: "", has_wt: false, q: "" });
    startTransition(() => {
      router.push("/staff/admin/accounting/ap/bills");
    });
  }

  const oldDrafts = initialBills.filter(
    (b) =>
      b.status === "draft" &&
      (NOW_MS - Date.parse(b.bill_date)) / 86400000 > 7
  ).length;

  return (
    <div className="space-y-4">
      {oldDrafts > 0 && (
        <Alert>
          <TriangleAlert />
          <AlertDescription>
            {oldDrafts} draft{oldDrafts !== 1 ? "s" : ""} older than 7 days — review and
            post or delete.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-2 md:grid-cols-5">
        <select
          value={filter.vendor_id}
          onChange={(e) => setFilter((f) => ({ ...f, vendor_id: e.target.value }))}
          className="min-h-[44px] rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        >
          <option value="">All vendors</option>
          {vendors.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>

        <select
          value={filter.status}
          onChange={(e) => setFilter((f) => ({ ...f, status: e.target.value }))}
          className="min-h-[44px] rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        <label className="flex min-h-[44px] items-center gap-2 px-3 text-sm text-[color:var(--color-brand-text-soft)]">
          <input
            type="checkbox"
            checked={filter.has_wt}
            onChange={(e) => setFilter((f) => ({ ...f, has_wt: e.target.checked }))}
            className="h-4 w-4"
          />
          Has WT
        </label>

        <input
          type="search"
          placeholder="Bill # / invoice # / desc"
          value={filter.q}
          onChange={(e) => setFilter((f) => ({ ...f, q: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key === "Enter") applyFilters();
          }}
          className="min-h-[44px] rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        />

        <div className="flex gap-2">
          <Button
            type="button"
            variant="brand"
            size="default"
            onClick={applyFilters}
            className="flex-1"
          >
            Apply
          </Button>
          <Button
            type="button"
            variant="outline"
            size="default"
            onClick={clearFilters}
          >
            Clear
          </Button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-md border border-gray-200">
        <table className="w-full min-w-[860px] text-sm">
          <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-3 py-2">Bill #</th>
              <th className="px-3 py-2">Vendor</th>
              <th className="px-3 py-2">Invoice #</th>
              <th className="px-3 py-2">Bill date</th>
              <th className="px-3 py-2">Due</th>
              <th className="px-3 py-2 text-right">Gross</th>
              <th className="px-3 py-2 text-right">WT</th>
              <th className="px-3 py-2 text-right">Outstanding</th>
              <th className="px-3 py-2">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {initialBills.map((b) => (
              <tr key={b.id}>
                <td className="px-3 py-2">
                  <Link
                    href={`/staff/admin/accounting/ap/bills/${b.id}`}
                    className="font-medium text-[color:var(--color-brand-navy)] hover:underline"
                  >
                    {b.bill_number}
                  </Link>
                </td>
                <td className="px-3 py-2">{b.vendor_name ?? "—"}</td>
                <td className="px-3 py-2 text-xs">{b.vendor_invoice_number ?? "—"}</td>
                <td className="px-3 py-2 text-xs">{b.bill_date}</td>
                <td className="px-3 py-2 text-xs">{b.due_date}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {PHP.format(b.gross_amount)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {b.wt_amount > 0 ? PHP.format(b.wt_amount) : "—"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {PHP.format(b.outstanding_amount)}
                </td>
                <td className="px-3 py-2">
                  <StatusBadge status={b.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {initialBills.length === 0 && (
        <p className="rounded-md border border-dashed border-gray-300 bg-gray-50 p-6 text-center text-sm text-[color:var(--color-brand-text-soft)]">
          No bills match your filters.
        </p>
      )}
    </div>
  );
}
