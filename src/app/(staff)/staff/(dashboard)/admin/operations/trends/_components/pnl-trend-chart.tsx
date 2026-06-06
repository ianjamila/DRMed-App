"use client";

import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import type { MonthlyPnlRow } from "@/lib/operations/trends";

const PESO = (n: number) =>
  new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency: "PHP",
    maximumFractionDigits: 0,
  }).format(n);

const compactPeso = (n: number) => {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `₱${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `₱${Math.round(n / 1_000)}k`;
  return `₱${n}`;
};

export function PnlTrendChart({ data }: { data: MonthlyPnlRow[] }) {
  if (data.length === 0) {
    return (
      <EmptyState
        className="mt-6"
        title="No data to chart yet"
        description="There are no posted expenses or revenue in the books."
      />
    );
  }

  return (
    <Card className="mt-4 px-2 py-4 sm:px-4">
      <h2 className="px-2 text-sm font-semibold text-[color:var(--color-brand-navy)]">
        Monthly profit &amp; loss
      </h2>
      <p className="px-2 pb-2 text-xs text-[color:var(--color-brand-text-soft)]">
        Gross profit (lab + consult) vs total expenses, with operational net income.
      </p>
      <div className="h-[320px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11 }}
              interval="preserveStartEnd"
              angle={-30}
              textAnchor="end"
              height={50}
            />
            <YAxis tickFormatter={compactPeso} tick={{ fontSize: 11 }} width={56} />
            <Tooltip formatter={(v) => (typeof v === "number" ? PESO(v) : String(v ?? ""))} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="grossProfit" name="Gross profit" fill="var(--color-brand-navy)" radius={[2, 2, 0, 0]} />
            <Bar dataKey="expenses" name="Expenses" fill="#c0504d" radius={[2, 2, 0, 0]} />
            <Line dataKey="net" name="Net income" type="monotone" stroke="#e9a23b" strokeWidth={2} dot={{ r: 2 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}
