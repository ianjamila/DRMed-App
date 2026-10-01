import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("./patient-sources-trend-chart-loader", () => ({
  PatientSourcesTrendChartLoader: () => <div data-testid="chart" />,
}));

import { PatientSourcesTrendCard } from "./patient-sources-trend-card";
import { trendCardData, trendWeeks } from "@/lib/marketing/patient-sources";

const weeks = trendWeeks("2026-10-01", 8);
const ok = (spend: { ok: true; rows: never[] } | { ok: false } = { ok: true, rows: [] }) => ({
  ok: true as const,
  data: {
    weeks,
    newByDay: [{ bucket_start: "2026-09-22", channel: "walk_in", confirmed: 3, unconfirmed: 0 }],
    spend,
    readAt: "2026-10-01T01:14:00Z",
    todayISO: "2026-10-01",
  },
});
const html = (t: Parameters<typeof PatientSourcesTrendCard>[0]["trend"]) =>
  renderToStaticMarkup(<PatientSourcesTrendCard trend={t} />);

describe("PatientSourcesTrendCard", () => {
  it("shows the headline, this week so far, the stamp and the no-spend footnote", () => {
    const h = html(ok());
    expect(h).toMatch(/Last week 3/);
    expect(h).toContain("(none the week before)");
    expect(h).toContain("This week so far: 0");
    expect(h).toContain("Numbers as of");
    expect(h).toContain("appears once ad spend is saved");
    expect(h).toContain(
      'href="/staff/marketing/patients?from=2026-08-03&amp;to=2026-09-27&amp;grain=week&amp;mode=new"',
    );
    expect(h).toContain("Open Patient Sources");
    expect(h).toMatch(/role="img" aria-label="[^"]*Last week 3/);
    expect(h).toContain('data-testid="chart"');
  });
  it("says when ad spend could not be loaded", () => {
    expect(html(ok({ ok: false }))).toMatch(/Couldn(&#x27;|')t load ad spend/);
  });
  it("degrades to the standard couldn't-load state when the report failed", () => {
    const h = html({ ok: false, kind: "error", message: "x" });
    expect(h).toMatch(/Couldn(&#x27;|')t load/);
    expect(h).not.toContain('data-testid="chart"');
  });
  it("trendCardData is what the card draws", () => {
    expect(trendCardData(ok().data.newByDay, [], weeks).lastWeek).toBe(3);
  });
});
