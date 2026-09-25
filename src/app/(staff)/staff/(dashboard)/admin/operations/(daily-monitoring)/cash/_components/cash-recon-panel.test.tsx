import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildCashReconRows, type EodCloseRow } from "@/lib/operations/cash-report";
import { CashReconPanel } from "./cash-recon-panel";
import { CashSummaryCards } from "./cash-summary-cards";
import { buildCollectionsMatrix } from "@/lib/operations/cash-report";

const DAYS = ["2026-09-21", "2026-09-22", "2026-09-23"];
const CLOSED: EodCloseRow[] = [
  {
    id: "close-1",
    business_date: "2026-09-23",
    expected_cash_php: "1000",
    counted_cash_php: "1000",
    variance_php: "0",
  },
];

const panel = (notClosed: Map<string, string[]>, eod: EodCloseRow[] = CLOSED) =>
  renderToStaticMarkup(<CashReconPanel rows={buildCashReconRows(eod, DAYS, notClosed)} />);

// Once Admin sets an End of Day reminders start date, a day that moved cash and
// was never closed shows up here instead of silently not existing.
describe("Cash reconciliation — days not closed", () => {
  it("shows a Not closed row linking to that day's End of Day on its shift", () => {
    const html = panel(new Map([["2026-09-22", ["shift-1"]]]));
    expect(html).toContain("Not closed");
    expect(html).toContain('href="/staff/payments/eod?date=2026-09-22&amp;shift=shift-1"');
    // The closed day still renders as before; the unflagged day does not.
    expect(html).toContain('href="/staff/payments/eod?date=2026-09-23"');
    expect(html).not.toContain("2026-09-21");
  });

  it("is unchanged while the reminders are off", () => {
    const html = panel(new Map());
    expect(html).not.toContain("Not closed");
    expect(html).toContain("2026-09-23");
  });

  it("shows flagged days even when nothing in the range was ever closed", () => {
    const html = panel(new Map([["2026-09-21", ["shift-1"]]]), []);
    expect(html).not.toContain("No end-of-day closes recorded");
    expect(html).toContain("Close this day");
  });

  it("keeps the empty state when nothing is closed and nothing is flagged", () => {
    expect(panel(new Map(), [])).toContain("No end-of-day closes recorded");
  });

  it("counts flagged days on the summary cards only when there are some", () => {
    const matrix = buildCollectionsMatrix([], DAYS, []);
    const withDays = renderToStaticMarkup(
      <CashSummaryCards
        matrix={matrix}
        reconRows={buildCashReconRows(CLOSED, DAYS, new Map([["2026-09-21", ["s"]], ["2026-09-22", ["s"]]]))}
      />,
    );
    expect(withDays).toContain("Days not closed");
    expect(withDays).toMatch(/Days not closed<\/div><div[^>]*>2</);
    const off = renderToStaticMarkup(
      <CashSummaryCards matrix={matrix} reconRows={buildCashReconRows(CLOSED, DAYS)} />,
    );
    expect(off).not.toContain("Days not closed");
  });
});
