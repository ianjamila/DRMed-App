"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/lib/ui/status-badge";

const PHP = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" });

type Vendor = { id: string; name: string };

type Payment = {
  id: string;
  vendor_id: string;
  vendor_name: string | null;
  payment_number: string;
  payment_date: string;
  method: string;
  amount_php: number;
  cash_account_id: string;
  reference: string | null;
  cheque_number: string | null;
  cheque_date: string | null;
  void_reason: string | null;
  voided_at: string | null;
  created_at: string;
};

type Filter = {
  vendor_id: string;
  method: string;
  q: string;
};

const METHODS = ["cash", "bank_transfer", "gcash", "cheque"] as const;

export function PaymentsIndexClient({
  initialPayments,
  vendors,
  initialFilter,
}: {
  initialPayments: Payment[];
  vendors: Vendor[];
  initialFilter: Filter;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [filter, setFilter] = useState<Filter>(initialFilter);

  function applyFilters() {
    const next = new URLSearchParams();
    if (filter.vendor_id) next.set("vendor_id", filter.vendor_id);
    if (filter.method) next.set("method", filter.method);
    if (filter.q) next.set("q", filter.q);
    startTransition(() => {
      router.push(`/staff/admin/accounting/ap/payments?${next.toString()}`);
    });
  }

  function clearFilters() {
    setFilter({ vendor_id: "", method: "", q: "" });
    startTransition(() => {
      router.push("/staff/admin/accounting/ap/payments");
    });
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-2 md:grid-cols-4">
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
          value={filter.method}
          onChange={(e) => setFilter((f) => ({ ...f, method: e.target.value }))}
          className="min-h-[44px] rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        >
          <option value="">All methods</option>
          {METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>

        <input
          type="search"
          placeholder="Payment # / reference / cheque #"
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
        <table className="w-full min-w-[820px] text-sm">
          <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-3 py-2">Payment #</th>
              <th className="px-3 py-2">Vendor</th>
              <th className="px-3 py-2">Date</th>
              <th className="px-3 py-2">Method</th>
              <th className="px-3 py-2">Reference</th>
              <th className="px-3 py-2 text-right">Amount</th>
              <th className="px-3 py-2">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {initialPayments.map((p) => (
              <tr key={p.id} className={p.voided_at ? "opacity-60" : ""}>
                <td className="px-3 py-2">
                  <Link
                    href={`/staff/admin/accounting/ap/payments/${p.id}`}
                    className="font-medium text-[color:var(--color-brand-navy)] hover:underline"
                  >
                    {p.payment_number}
                  </Link>
                </td>
                <td className="px-3 py-2">{p.vendor_name ?? "—"}</td>
                <td className="px-3 py-2 text-xs">{p.payment_date}</td>
                <td className="px-3 py-2 text-xs">{p.method}</td>
                <td className="px-3 py-2 text-xs">
                  {p.cheque_number ?? p.reference ?? "—"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {PHP.format(p.amount_php)}
                </td>
                <td className="px-3 py-2">
                  {p.voided_at ? <StatusBadge status="voided" /> : <span className="text-xs text-[color:var(--color-brand-text-soft)]">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {initialPayments.length === 0 && (
        <p className="rounded-md border border-dashed border-gray-300 bg-gray-50 p-6 text-center text-sm text-[color:var(--color-brand-text-soft)]">
          No payments match your filters.
        </p>
      )}
    </div>
  );
}
