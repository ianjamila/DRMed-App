import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./actions", () => ({
  updateCashRoutingAction: vi.fn(),
  updateDefaultChangeFundAction: vi.fn(),
  updateEodRemindersStartAction: vi.fn(),
  updatePaymentRoutingAction: vi.fn(),
}));

import { MoneyRoutingClient } from "./money-routing-client";

const render = (eodRemindersStart: string | null, lastChanges = {}) =>
  renderToStaticMarkup(
    <MoneyRoutingClient
      payments={[]}
      cash={[]}
      accounts={[]}
      defaultChangeFund={2000}
      eodRemindersStart={eodRemindersStart}
      cashDrawerInUse={false}
      lastChanges={lastChanges}
    />,
  );

// The owner turns the End of Day "not closed" reminders on by picking the day
// they start counting from; until then (beta) they are off.
describe("End of Day reminders setting", () => {
  it("reads Off with a Set-a-start-date button while no date is set", () => {
    const html = render(null);
    expect(html).toContain("End of Day reminders");
    expect(html).toMatch(/>Off</);
    expect(html).toContain("Set a start date");
  });

  it("names the start date once one is set, with who last changed it", () => {
    const html = render("2026-10-01", {
      eodStart: { by: "Ian Jamila", at: "2026-09-25T02:00:00Z" },
    });
    expect(html).toContain("On — counting from");
    expect(html).not.toContain("Set a start date");
    expect(html).toContain("Last changed by Ian Jamila");
  });
});
