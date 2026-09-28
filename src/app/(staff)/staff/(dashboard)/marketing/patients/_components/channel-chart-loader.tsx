"use client";
import dynamic from "next/dynamic";
import type { ChartChannel, ChartDatum } from "@/lib/marketing/patient-sources";

const ChannelChart = dynamic(() => import("./channel-chart").then((m) => m.ChannelChart), {
  ssr: false,
  loading: () => <div className="h-[320px] animate-pulse rounded bg-[color:var(--color-brand-bg)]" />,
});

export function ChannelChartLoader(props: { rows: ChartDatum[]; channels: ChartChannel[] }) {
  return <ChannelChart {...props} />;
}
