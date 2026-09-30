"use client";
/**
 * Stacked bars per channel; each channel has a solid confirmed band and a
 * hatched unconfirmed band (spec §3.2.4). Loaded through channel-chart-loader
 * so recharts is not in the route's first JS bundle (same as ad-charts.tsx).
 */
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ChartChannel, ChartDatum } from "@/lib/marketing/patient-sources";

export function ChannelChart({ rows, channels }: { rows: ChartDatum[]; channels: ChartChannel[] }) {
  return (
    <ResponsiveContainer width="100%" height={320}>
      <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
        <defs>
          {channels.map((c) => (
            <pattern key={c.key} id={`hatch-${c.key}`} patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
              <rect width="6" height="6" fill="white" />
              <line x1="0" y1="0" x2="0" y2="6" stroke={c.color} strokeWidth="3" />
            </pattern>
          ))}
        </defs>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="label" tick={{ fontSize: 11 }} />
        <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={32} />
        <Tooltip />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {channels.flatMap((c) => [
          <Bar key={`${c.key}-c`} dataKey={`${c.key}__c`} name={c.label} stackId="s" fill={c.color} />,
          <Bar key={`${c.key}-u`} dataKey={`${c.key}__u`} name={`${c.label} (unconfirmed)`} stackId="s" fill={`url(#hatch-${c.key})`} legendType="none" />,
        ])}
      </BarChart>
    </ResponsiveContainer>
  );
}
