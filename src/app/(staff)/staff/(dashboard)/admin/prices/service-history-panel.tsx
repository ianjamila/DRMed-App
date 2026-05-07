"use client";

import { useEffect, useState } from "react";
import { formatPhp } from "@/lib/marketing/format";
import {
  fetchServiceHistoryAction,
  type PriceHistoryEntry,
} from "./actions";

const DATE_TIME_FMT = new Intl.DateTimeFormat("en-PH", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Manila",
});

interface Props {
  serviceId: string;
  currentPrice: number;
  currentHmo: number | null;
  currentSenior: number | null;
}

export function ServiceHistoryPanel({ serviceId }: Props) {
  const [entries, setEntries] = useState<PriceHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchServiceHistoryAction(serviceId)
      .then((data) => {
        if (!cancelled) setEntries(data);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [serviceId]);

  if (error) {
    return (
      <p className="text-xs text-red-700">
        Couldn&apos;t load history: {error}
      </p>
    );
  }
  if (entries === null) {
    return (
      <p className="text-xs text-[color:var(--color-brand-text-soft)]">
        Loading history…
      </p>
    );
  }
  if (entries.length === 0) {
    return (
      <p className="text-xs text-[color:var(--color-brand-text-soft)]">
        No history yet for this service.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white">
      <table className="w-full min-w-[560px] text-xs">
        <thead className="bg-[color:var(--color-brand-bg)] text-left font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          <tr>
            <th className="px-3 py-2">When</th>
            <th className="px-3 py-2 text-right">DRMed</th>
            <th className="px-3 py-2 text-right">HMO</th>
            <th className="px-3 py-2 text-right">Senior disc.</th>
            <th className="px-3 py-2">By</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
          {entries.map((h) => (
            <tr key={h.id}>
              <td className="px-3 py-1.5 text-[color:var(--color-brand-text-mid)]">
                {DATE_TIME_FMT.format(new Date(h.effective_from))}
              </td>
              <td className="px-3 py-1.5 text-right font-semibold text-[color:var(--color-brand-navy)]">
                {h.price_php != null ? formatPhp(h.price_php) : "—"}
              </td>
              <td className="px-3 py-1.5 text-right text-[color:var(--color-brand-text-mid)]">
                {h.hmo_price_php != null ? formatPhp(h.hmo_price_php) : "—"}
              </td>
              <td className="px-3 py-1.5 text-right text-[color:var(--color-brand-text-mid)]">
                {h.senior_discount_php != null
                  ? formatPhp(h.senior_discount_php)
                  : "—"}
              </td>
              <td className="px-3 py-1.5 text-[color:var(--color-brand-text-soft)]">
                {h.changed_by_name ?? h.change_reason ?? "system"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
