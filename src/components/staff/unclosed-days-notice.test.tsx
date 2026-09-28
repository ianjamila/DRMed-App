import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UnclosedDaysNotice } from "./unclosed-days-notice";

const render = (days: string[]) =>
  renderToStaticMarkup(<UnclosedDaysNotice days={days} shiftId="shift-1" />);

const hrefs = (html: string) =>
  [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));

// Shown on Cash In & Out and End of Day. The list is empty while Admin has not
// set a reminders start date, so "off" must render nothing at all.
describe("UnclosedDaysNotice", () => {
  it("renders nothing when no day is flagged", () => {
    expect(render([])).toBe("");
  });

  it("names a single day in the singular", () => {
    const html = render(["2026-09-24"]);
    expect(html).toContain("An earlier day was not closed");
    expect(hrefs(html)).toEqual(["/staff/payments/eod?date=2026-09-24&shift=shift-1"]);
  });

  it("links the newest days first and folds the rest into one link to the oldest", () => {
    const days = ["2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13", "2026-09-14", "2026-09-15", "2026-09-16"];
    const html = render(days);
    expect(html).toContain("7 earlier days were not closed");
    expect(hrefs(html)).toEqual([
      "/staff/payments/eod?date=2026-09-16&shift=shift-1",
      "/staff/payments/eod?date=2026-09-15&shift=shift-1",
      "/staff/payments/eod?date=2026-09-14&shift=shift-1",
      "/staff/payments/eod?date=2026-09-13&shift=shift-1",
      "/staff/payments/eod?date=2026-09-12&shift=shift-1",
      "/staff/payments/eod?date=2026-09-10&shift=shift-1",
    ]);
    expect(html).toContain("and 2 more");
  });
});
