"use client";
/**
 * Dashboard trend (spec §3.2): stacked weekly bars per channel (solid =
 * confirmed, hatched = unconfirmed, as on Patient Sources) and, when ad spend
 * is saved, a cost-per-new-patient line on a second axis. Loaded through
 * patient-sources-trend-chart-loader so recharts stays out of the first bundle.
 */
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ChartChannel, ChartDatum } from "@/lib/marketing/patient-sources";

export function PatientSourcesTrendChart({ rows, channels, hasSpend }: { rows: ChartDatum[]; channels: ChartChannel[]; hasSpend: boolean }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <ComposedChart data={rows} margin={{ top: 8, right: hasSpend ? 0 : 8, bottom: 0, left: 0 }}>
        <defs>
          {channels.map((c) => (
            <pattern key={c.key} id={`trend-hatch-${c.key}`} patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
              <rect width="6" height="6" fill="white" />
              <line x1="0" y1="0" x2="0" y2="6" stroke={c.color} strokeWidth="3" />
            </pattern>
          ))}
        </defs>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={0} />
        <YAxis yAxisId="n" allowDecimals={false} tick={{ fontSize: 10 }} width={28} />
        {hasSpend ? <YAxis yAxisId="php" orientation="right" tick={{ fontSize: 10 }} width={44} tickFormatter={(v: number) => `₱${v}`} /> : null}
        <Tooltip />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        {channels.flatMap((c) => [
          <Bar key={`${c.key}-c`} yAxisId="n" dataKey={`${c.key}__c`} name={c.label} stackId="s" fill={c.color} />,
          <Bar key={`${c.key}-u`} yAxisId="n" dataKey={`${c.key}__u`} name={`${c.label} (unconfirmed)`} stackId="s" fill={`url(#trend-hatch-${c.key})`} legendType="none" />,
        ])}
        {hasSpend ? (
          <Line yAxisId="php" type="monotone" dataKey="__cost" name="Cost per new patient (₱)" stroke="#0f172a" strokeWidth={2} dot connectNulls={false} />
        ) : null}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
