import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// M3 end-to-end at the markup level: the pure mapping is covered in
// src/lib/reports/statement-period.test.ts, but what actually broke was that
// the tab bars never handed a query to SectionTabs at all. These assert the
// rendered hrefs, which is the thing a user clicks.
const searchParams = { current: new URLSearchParams() };
vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParams.current,
  usePathname: () => "/staff/admin/operations",
}));

const { OperationsTabs } = await import(
  "@/app/(staff)/staff/(dashboard)/admin/operations/_components/operations-tabs"
);
const { StatementTabs } = await import(
  "@/app/(staff)/staff/(dashboard)/admin/accounting/financial-statements/_components/statement-tabs"
);
const { PaymentsTabs } = await import(
  "@/app/(staff)/staff/(dashboard)/payments/_components/payments-tabs"
);

// Attribute values come back HTML-escaped ("&" → "&amp;"); the browser decodes
// them, so compare the decoded form.
const hrefs = (html: string) =>
  [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1].replaceAll("&amp;", "&"));

function render(node: React.ReactElement, params: string): string[] {
  searchParams.current = new URLSearchParams(params);
  return hrefs(renderToStaticMarkup(node));
}

describe("OperationsTabs", () => {
  it("carries the selected range onto every tab", () => {
    const got = render(<OperationsTabs />, "from=2026-03-01&to=2026-03-31");
    expect(got).toHaveLength(5);
    for (const href of got) expect(href).toContain("?from=2026-03-01&to=2026-03-31");
    expect(got[1]).toBe("/staff/admin/operations/cash?from=2026-03-01&to=2026-03-31");
  });

  it("leaves the hrefs bare when no range is selected", () => {
    expect(render(<OperationsTabs />, "")).toEqual([
      "/staff/admin/operations",
      "/staff/admin/operations/cash",
      "/staff/admin/operations/expenses",
      "/staff/admin/operations/hmo",
      "/staff/admin/operations/trends",
    ]);
  });
});

describe("StatementTabs", () => {
  it("sends a period to the range tabs and its closing date to the balance sheet", () => {
    const [income, balance, cash] = render(
      <StatementTabs />,
      "start=2026-03-01&end=2026-03-31",
    );
    const FS = "/staff/admin/accounting/financial-statements";
    expect(income).toBe(`${FS}?start=2026-03-01&end=2026-03-31`);
    expect(cash).toBe(`${FS}/cash-flow?start=2026-03-01&end=2026-03-31`);
    // NOT ?start=&end= — the balance sheet reads neither.
    expect(balance).toBe(`${FS}/balance-sheet?as_of=2026-03-31`);
  });

  it("maps a balance-sheet as_of back to year-to-date for the range tabs", () => {
    const [income, balance] = render(<StatementTabs />, "as_of=2026-03-31");
    expect(income).toContain("?start=2026-01-01&end=2026-03-31");
    expect(balance).toContain("?as_of=2026-03-31");
  });
});

describe("PaymentsTabs", () => {
  it("renders Cash Drawer | Petty Cash | End of Day, in that order", () => {
    const html = renderToStaticMarkup(<PaymentsTabs />);
    expect(hrefs(html)).toEqual([
      "/staff/payments/cash-drawer",
      "/staff/payments/petty-cash",
      "/staff/payments/eod",
    ]);
    expect(html.replace(/<[^>]+>/g, "|")).toMatch(
      /Cash Drawer\|+Petty Cash\|+End of Day/,
    );
  });

  it("carries date and shift onto every tab, Petty Cash included", () => {
    const got = render(<PaymentsTabs />, "date=2026-05-30&shift=am");
    expect(got).toEqual([
      "/staff/payments/cash-drawer?date=2026-05-30&shift=am",
      "/staff/payments/petty-cash?date=2026-05-30&shift=am",
      "/staff/payments/eod?date=2026-05-30&shift=am",
    ]);
  });

  it("builds a well-formed href when only the shift is set", () => {
    // Regression guard: a shift with no date must not produce "…/eod&shift=am".
    for (const href of render(<PaymentsTabs />, "shift=am")) {
      expect(href).toContain("?shift=am");
      expect(href).not.toContain("&shift");
    }
  });
});
