"use client";

import { useState, useMemo } from "react";
import Link from "next/link";

const PHP = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" });

type Vendor = {
  id: string;
  name: string;
  tin: string | null;
  is_active: boolean;
  outstanding_php: number;
  ytd_spend_php: number;
  last_bill_date: string | null;
};

export function VendorsIndexClient({ initialVendors }: { initialVendors: Vendor[] }) {
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);

  const filtered = useMemo(() => {
    return initialVendors.filter((v) => {
      if (!showInactive && !v.is_active) return false;
      if (search && !v.name.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [initialVendors, search, showInactive]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          placeholder="Search vendors"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="min-h-[44px] min-w-0 flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        />
        <label className="flex min-h-[44px] items-center gap-2 text-sm text-[color:var(--color-brand-text-soft)]">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
            className="h-4 w-4"
          />
          Include inactive
        </label>
      </div>

      <div className="overflow-x-auto rounded-md border border-gray-200">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">TIN</th>
              <th className="px-3 py-2 text-right">Outstanding</th>
              <th className="px-3 py-2 text-right">YTD spend</th>
              <th className="px-3 py-2">Last bill</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filtered.map((v) => (
              <tr key={v.id} className={v.is_active ? "" : "opacity-60"}>
                <td className="px-3 py-2">
                  <Link
                    href={`/staff/admin/accounting/ap/vendors/${v.id}`}
                    className="font-medium text-[color:var(--color-brand-navy)] hover:underline"
                  >
                    {v.name}
                  </Link>
                  {!v.is_active && (
                    <span className="ml-2 text-xs text-gray-500">(inactive)</span>
                  )}
                </td>
                <td className="px-3 py-2 text-xs text-[color:var(--color-brand-text-soft)]">
                  {v.tin ?? "—"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {PHP.format(v.outstanding_php)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {PHP.format(v.ytd_spend_php)}
                </td>
                <td className="px-3 py-2 text-xs">
                  {v.last_bill_date ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {filtered.length === 0 && (
        <p className="rounded-md border border-dashed border-gray-300 bg-gray-50 p-6 text-center text-sm text-[color:var(--color-brand-text-soft)]">
          {initialVendors.length === 0
            ? "No vendors yet. Add the first one above."
            : "No vendors match your filters."}
        </p>
      )}
    </div>
  );
}
