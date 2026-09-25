import { describe, it, expect } from "vitest";
import { renderStatementEmail, type StatementEmailInput } from "./statement-email";

const line = (
  id: string,
  name: string,
  final: number,
  extra: Partial<{ parentId: string; isPackageHeader: boolean; discount: number }> = {},
) => ({
  id,
  svc: { code: name.toUpperCase().replace(/\W+/g, "_"), name },
  base: final + (extra.discount ?? 0),
  discount: extra.discount ?? 0,
  final,
  parentId: extra.parentId ?? null,
  isPackageHeader: extra.isPackageHeader ?? false,
});

function input(over: Partial<StatementEmailInput> = {}): StatementEmailInput {
  return {
    patient: { first_name: "Ana", middle_name: null, last_name: "Reyes", drm_id: "DRM-00123" },
    visit: { visit_number: "0042", visit_date: "2026-09-24" },
    hmoName: null,
    lines: [
      line("pkg", "Executive Package", 3500, { isPackageHeader: true }),
      line("cbc", "CBC", 0, { parentId: "pkg" }),
      line("xr", "Chest X-Ray", 450, { discount: 50 }),
    ],
    subtotal: 4000,
    totalDiscount: 50,
    total: 3950,
    payments: [
      { amount_php: 2000, method: "cash", reference_number: null, received_at: "2026-09-24T02:00:00Z" },
    ],
    summary: { charges: 3950, paid: 2000, balance: 1950, balanceLabel: "Balance due" },
    issuedAt: new Date("2026-09-25T03:00:00Z"),
    ...over,
  };
}

describe("renderStatementEmail", () => {
  it("names the visit in the subject", () => {
    expect(renderStatementEmail(input()).subject).toBe(
      "Your DRMed statement of account — visit #0042",
    );
  });

  it("carries every line, payment and the balance in the text body", () => {
    const { text } = renderStatementEmail(input());
    expect(text).toContain("Hi Ana,");
    expect(text).toContain("Reyes, Ana (DRM-00123)");
    expect(text).toContain("Executive Package");
    expect(text).toMatch(/Chest X-Ray\s+₱450/);
    expect(text).toContain("Total charges: ₱3,950");
    expect(text).toMatch(/Cash\s+₱2,000/);
    expect(text).toContain("Total paid: ₱2,000");
    expect(text).toContain("Balance due: ₱1,950");
    expect(text).toContain("not an official receipt");
  });

  it("lists an included test under its package without an amount", () => {
    const { text } = renderStatementEmail(input());
    expect(text).toMatch(/Executive Package\s+₱3,500\n\s+· CBC\n/);
  });

  it("never carries a portal PIN", () => {
    const { text, html } = renderStatementEmail(input());
    expect(`${text}${html}`).not.toMatch(/PIN/i);
  });

  it("escapes patient-controlled text in the HTML", () => {
    const { html } = renderStatementEmail(
      input({ patient: { first_name: "<b>x</b>", middle_name: null, last_name: "Reyes", drm_id: "DRM-1" } }),
    );
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  it("says the HMO settles an open HMO balance", () => {
    const { text, html } = renderStatementEmail(
      input({
        hmoName: "Maxicare",
        summary: { charges: 3950, paid: 0, balance: 3950, balanceLabel: "Balance" },
        payments: [],
      }),
    );
    expect(text).toContain("Balance: ₱3,950");
    expect(text).toContain("settled through the Maxicare claim");
    expect(text).toContain("No payments recorded.");
    expect(html).toContain("Maxicare");
  });

  it("shows an overpayment as a positive figure under its label", () => {
    const { text } = renderStatementEmail(
      input({ summary: { charges: 3950, paid: 4000, balance: -50, balanceLabel: "Overpaid" } }),
    );
    expect(text).toContain("Overpaid: ₱50");
  });
});
