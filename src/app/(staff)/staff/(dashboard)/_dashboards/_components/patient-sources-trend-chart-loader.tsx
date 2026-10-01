"use client";
import dynamic from "next/dynamic";
import type { ChartChannel, ChartDatum } from "@/lib/marketing/patient-sources";

const Chart = dynamic(() => import("./patient-sources-trend-chart").then((m) => m.PatientSourcesTrendChart), {
  ssr: false,
  loading: () => <div className="h-[220px] animate-pulse rounded bg-[color:var(--color-brand-bg)]" />,
});

export function PatientSourcesTrendChartLoader(props: { rows: ChartDatum[]; channels: ChartChannel[]; hasSpend: boolean }) {
  return <Chart {...props} />;
}
