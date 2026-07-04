"use client";

// Recharts-backed chart bodies for the ad dashboard, split into their own
// module so recharts loads on demand (see the next/dynamic imports in
// ad-dashboard.tsx) instead of shipping in the route's initial JS bundle.
// Colours and number formatters are passed in as props to keep this file free
// of the dashboard's palette/formatting singletons.

import {
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

export interface DonutDatum {
  name: string;
  spend: number;
}

/** Spend-by-platform donut. */
export function SpendDonut({
  data,
  colorOf,
  formatPeso,
}: {
  data: DonutDatum[];
  colorOf: (name: string) => string;
  formatPeso: (n: number) => string;
}) {
  return (
    <ResponsiveContainer width="100%" height={210}>
      <PieChart>
        <Pie
          data={data}
          dataKey="spend"
          nameKey="name"
          innerRadius={48}
          outerRadius={78}
          paddingAngle={2}
        >
          {data.map((p) => (
            <Cell key={p.name} fill={colorOf(p.name)} />
          ))}
        </Pie>
        <Tooltip formatter={(v) => formatPeso(Number(v))} />
      </PieChart>
    </ResponsiveContainer>
  );
}

export interface TrendDatum {
  date: string;
  label: string;
  spend: number;
  bookings: number;
  leads: number;
}

/** Spend + patients-captured dual-axis trend line. */
export function SpendTrend({
  data,
  colors,
  formatPeso,
  formatInt,
}: {
  data: TrendDatum[];
  colors: { line: string; sub: string; ink: string; accent: string };
  formatPeso: (n: number) => string;
  formatInt: (n: number) => string;
}) {
  return (
    <ResponsiveContainer width="100%" height={232}>
      <LineChart data={data} margin={{ left: -10, right: 8, top: 6 }}>
        <CartesianGrid stroke={colors.line} vertical={false} />
        <XAxis
          dataKey="label"
          tick={{ fontSize: 11, fill: colors.sub }}
          interval="preserveStartEnd"
        />
        <YAxis yAxisId="l" tick={{ fontSize: 11, fill: colors.sub }} />
        <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 11, fill: colors.sub }} />
        <Tooltip
          formatter={(v, n) => (n === "spend" ? formatPeso(Number(v)) : formatInt(Number(v)))}
        />
        <Line
          yAxisId="l"
          type="monotone"
          dataKey="spend"
          stroke={colors.ink}
          strokeWidth={2}
          dot={false}
          name="spend"
        />
        <Line
          yAxisId="r"
          type="monotone"
          dataKey="bookings"
          stroke={colors.accent}
          strokeWidth={2}
          dot={false}
          name="captured"
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
