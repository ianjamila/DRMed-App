import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
  usePathname: () => "/staff/payments/eod",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("../cash-drawer/actions", () => ({
  closeEodAction: vi.fn(),
  reopenEodCloseAction: vi.fn(),
}));

import { EodClient } from "./eod-client";

const TODAY = "2026-09-25";
const SHIFT = { id: "shift-1", code: "day", label: "Day shift" };

function render(opts: {
  businessDate?: string;
  shifts?: (typeof SHIFT)[];
  closed?: boolean;
  unclosedDays?: string[];
} = {}) {
  return renderToStaticMarkup(
    <EodClient
      isAdmin={false}
      businessDate={opts.businessDate ?? TODAY}
      today={TODAY}
      shiftId={SHIFT.id}
      shifts={opts.shifts ?? [SHIFT]}
      unclosedDays={opts.unclosedDays ?? []}
      state={{
        expected_cash_php: 0,
        closed: opts.closed
          ? {
              id: "close-1",
              closed_at: "2026-09-24T10:00:00Z",
              closed_by: "staff-1",
              counted_cash_php: 0,
              expected_cash_php: 0,
              variance_php: 0,
              variance_reason: null,
              counted_denominations: {},
            }
          : null,
      }}
    />,
  );
}

// The page always read `?date=`, but nothing on screen let reception pick a
// day, so a missed close could only be reached by hand-editing the URL.
describe("End of day picker", () => {
  it("defaults to today and cannot pick a future day", () => {
    const html = render();
    expect(html).toContain('type="date"');
    expect(html).toContain(`value="${TODAY}"`);
    expect(html).toContain(`max="${TODAY}"`);
    expect(html).toContain('aria-label="Day to close"');
  });

  it("shows no Back-to-today link or past-day warning on today", () => {
    const html = render();
    expect(html).not.toContain("Back to today");
    expect(html).not.toContain("This is a past day");
  });

  it("offers Back to today on a past day, keeping the shift", () => {
    const html = render({ businessDate: "2026-09-20" });
    expect(html).toContain(`value="2026-09-20"`);
    expect(html).toContain("Back to today");
    expect(html).toContain(`href="/staff/payments/eod?shift=${SHIFT.id}"`);
  });

  it("warns before counting a past day that is still open", () => {
    const html = render({ businessDate: "2026-09-20" });
    expect(html).toContain("This is a past day");
    expect(html).toContain("Close day");
  });

  it("does not warn on a past day that is already closed", () => {
    const html = render({ businessDate: "2026-09-20", closed: true });
    expect(html).not.toContain("This is a past day");
    expect(html).toContain("Day closed");
  });

  it("lists earlier unclosed days, each linking to its own End of Day", () => {
    expect(render()).not.toContain("not closed");
    const html = render({ unclosedDays: ["2026-09-22", "2026-09-23"] });
    expect(html).toContain("2 earlier days were not closed");
    expect(html).toContain(`href="/staff/payments/eod?date=2026-09-23&amp;shift=${SHIFT.id}"`);
    expect(html).toContain(`href="/staff/payments/eod?date=2026-09-22&amp;shift=${SHIFT.id}"`);
  });

  it("shows a shift picker only when there is more than one shift", () => {
    expect(render()).not.toContain('aria-label="Shift"');
    const html = render({
      shifts: [SHIFT, { id: "shift-2", code: "night", label: "Night shift" }],
    });
    expect(html).toContain('aria-label="Shift"');
    expect(html).toContain("Night shift");
  });
});
