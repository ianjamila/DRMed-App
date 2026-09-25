import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PaymentLeavesNotice } from "./payment-leaves-notice";
import { NO_RELEASED, type VisitMoney } from "@/lib/visits/payment-edit";

const paid: VisitMoney = { totalPhp: 1000, paidPhp: 1000, paymentStatus: "paid", hmoProviderId: null };
const twoResults = { results: 2, consults: 0, procedures: 0 };

const render = (visit: VisitMoney, amount: number, released = twoResults) =>
  renderToStaticMarkup(
    <PaymentLeavesNotice visit={visit} visitNumber="0043" amount={amount} released={released} className="base" />,
  );

describe("PaymentLeavesNotice (Delete dialog / Move source side)", () => {
  it("warns, emphasised, when released results are left on a visit that owes", () => {
    const html = render(paid, 1000);
    expect(html).toContain("Visit #0043 will then owe ₱1,000, and 2 results on it are already released.");
    expect(html).toContain("font-semibold text-amber-800");
  });

  it("states the balance plainly when nothing went out", () => {
    const html = render(paid, 400, NO_RELEASED);
    expect(html).toContain("Visit #0043 will then owe ₱400.");
    expect(html).not.toContain("amber");
  });

  it("renders nothing when the visit stays paid (recorded twice)", () => {
    expect(render({ ...paid, paidPhp: 2000 }, 1000)).toBe("");
  });

  it("uses HMO wording on an HMO visit", () => {
    const html = render({ ...paid, hmoProviderId: "h1" }, 200);
    expect(html).toContain("released under HMO billing");
    expect(html).not.toMatch(/owe|left to pay/);
  });

  it("uses waived wording on a waived visit", () => {
    const html = render({ ...paid, paymentStatus: "waived", paidPhp: 300 }, 300);
    expect(html).toContain("stays waived; the ₱300 is no longer tracked in Patient AR");
    expect(html).not.toMatch(/will then owe|left to pay/);
  });
});
