// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { FirstNightCheckView } from "./first-night-check";
import { evaluateCheck, type CheckInput, type Counts, type DayInput } from "@/lib/marketing/first-night-check";

afterEach(cleanup);

const c = (confirmed: number, unconfirmed = 0): Counts => ({ confirmed, unconfirmed });
const day = (date: string, n: Counts, over: Partial<DayInput> = {}): DayInput => ({
  date, summary: n, chart: n, tile: n, created: { app: n.confirmed, imported: 0 }, ...over,
});
function report(days: DayInput[], over: Partial<CheckInput> = {}) {
  const sum = days.reduce((s, d) => ({ confirmed: s.confirmed + (d.summary?.confirmed ?? 0), unconfirmed: s.unconfirmed + (d.summary?.unconfirmed ?? 0) }), c(0));
  return evaluateCheck({
    params: { from: days[0].date, to: days[days.length - 1].date, threshold: 40 },
    patientSourcesCard: sum,
    bookingCardText: `${sum.confirmed} confirmed · ${sum.unconfirmed} unconfirmed`,
    chartTotal: sum, days, loadErrors: [],
    sync: { paused: true, lastSyncedAt: null, lastRunStatus: null, undatedRegistrations: 3 },
    ...over,
  });
}
const form = { from: "2026-09-29", to: "2026-09-30", threshold: "40" };
const view = (r: ReturnType<typeof report> | null, extra: Partial<Parameters<typeof FirstNightCheckView>[0]> = {}) =>
  render(<FirstNightCheckView form={form} paramErrors={[]} result={r ? { report: r, durationMs: 1234 } : null} {...extra} />);

describe("FirstNightCheckView", () => {
  it("before a run: just the form, no verdict — a plain visit costs nothing", () => {
    view(null);
    expect(screen.getByLabelText("From")).toHaveProperty("value", "2026-09-29");
    expect(screen.getByLabelText("Spike threshold")).toHaveProperty("value", "40");
    expect(screen.getByRole("button", { name: "Run check" })).toBeTruthy();
    expect(screen.queryByText("All screens agree")).toBeNull();
    const hidden = document.querySelectorAll('input[type="hidden"]');
    expect([...hidden].map((h) => `${(h as HTMLInputElement).name}=${(h as HTMLInputElement).value}`).sort()).toEqual(["run=1", "view=check"]);
  });

  it("shows bad settings in plain English and no verdict", () => {
    view(null, { paramErrors: ["The first day must be on or before the last day."] });
    expect(screen.getByText("The first day must be on or before the last day.")).toBeTruthy();
  });

  it("pass: green 'All screens agree', both tables, links and the CLI command", () => {
    view(report([day("2026-09-29", c(4, 1)), day("2026-09-30", c(2), { created: { app: 2, imported: 560 } })]));
    const alert = screen.getByText("All screens agree").closest('[data-slot="alert"]')!;
    expect(alert.className).toContain("emerald");
    expect(screen.getAllByText("Patient Sources").length).toBeGreaterThan(0);
    expect(screen.getByText("Booking Sources")).toBeTruthy();
    expect(screen.getAllByText("Patient Sources chart").length).toBeGreaterThan(0);
    expect(screen.getByText("Dashboard “New today”")).toBeTruthy();
    expect(screen.getByText("Day-by-day total")).toBeTruthy();
    const row = screen.getByText("Sep 30, 2026").closest("tr")!;
    expect(within(row).getByText("2 / 560")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Open Patient Sources/ }).getAttribute("href")).toBe("/staff/marketing/patients?from=2026-09-29&to=2026-09-30");
    expect(screen.getByRole("link", { name: /Open Booking Sources/ }).getAttribute("href")).toBe("/staff/marketing/sources?from=2026-09-29&to=2026-09-30");
    expect(screen.getByText("npm run first-night:check -- --from 2026-09-29 --to 2026-09-30 --threshold 40")).toBeTruthy();
    expect(screen.getByText(/3 people registered with no date/)).toBeTruthy();
  });

  it("spike: amber alert and the spike day highlighted", () => {
    view(report([day("2026-09-29", c(3)), day("2026-09-30", c(560))]));
    const alert = screen.getByText("A day jumped above 40 new patients").closest('[data-slot="alert"]')!;
    expect(alert.className).toContain("amber");
    const row = screen.getByText("Sep 30, 2026").closest("tr")!;
    expect(row.className).toContain("amber");
    expect(within(row).getByText("Above 40")).toBeTruthy();
    expect(screen.getByText("Sep 29, 2026").closest("tr")!.className).not.toContain("amber");
  });

  it("mismatch: red alert listing each disagreement with both numbers", () => {
    view(report([day("2026-09-29", c(4)), day("2026-09-30", c(2), { tile: c(1) })]));
    const alert = screen.getByText(/^Screens disagree — /).closest('[data-slot="alert"]')!;
    expect(alert.className).toContain("destructive");
    expect(screen.getAllByText(/Dashboard “New today” shows 1 confirmed · 0 unconfirmed but Patient Sources shows 2 confirmed · 0 unconfirmed/).length).toBeGreaterThan(0);
    expect(screen.getByText("Sep 30, 2026").closest("tr")!.className).toContain("red");
    expect(within(screen.getByText("Sep 30, 2026").closest("tr")!).getByText("Screens differ")).toBeTruthy();
  });

  it("error: red alert names what failed, unloaded figures show as unknown, never 0", () => {
    view(report([day("2026-09-29", c(4), { tile: null, created: null }), day("2026-09-30", c(2))], {
      loadErrors: [{ what: "the dashboard tile", date: "2026-09-29", message: "Couldn't load Patient Sources. Reload the page — these figures are unknown, not zero." }],
    }));
    expect(screen.getByText("The check couldn't finish — the dashboard tile could not be loaded")).toBeTruthy();
    const row = screen.getByText("Sep 29, 2026").closest("tr")!;
    expect(within(row).getAllByText("Unknown").length).toBeGreaterThan(0);
    expect(screen.getByText(/the dashboard tile \(Sep 29, 2026\)/)).toBeTruthy();
  });

  it("View-as refusal is shown as the loader's own plain message", () => {
    const msg = "Patient Sources is for admins only. If you are using View as, switch back to Admin.";
    view(report([day("2026-09-30", c(0))], { patientSourcesCard: null, loadErrors: [{ what: "Patient Sources", message: msg }] }));
    expect(screen.getByText(new RegExp("switch back to Admin"))).toBeTruthy();
  });
});
