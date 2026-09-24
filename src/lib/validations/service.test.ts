import { describe, it, expect } from "vitest";
import { resolveSendOutVendorSelection, type PartnerLabOption } from "./service";

// 0164 — the service form's free-text `send_out_lab` input was replaced with
// a "Partner lab" select. This pins the pure resolver that turns the raw
// `send_out_vendor_id` form field into the {vendorId, labName} pair actually
// persisted, without a DB round trip.

const LABS: PartnerLabOption[] = [
  { id: "11111111-1111-1111-1111-111111111111", name: "Hi Precision" },
  { id: "22222222-2222-2222-2222-222222222222", name: "Micromedic" },
];

describe("resolveSendOutVendorSelection", () => {
  it("always resolves to null/null when the service is not a send-out — even with a vendor id submitted", () => {
    const r = resolveSendOutVendorSelection(false, LABS[0]!.id, LABS);
    expect(r).toEqual({ ok: true, data: { vendorId: null, labName: null } });
  });

  it("resolves to null/null for a send-out with no lab picked (— Not set —)", () => {
    const r = resolveSendOutVendorSelection(true, "", LABS);
    expect(r).toEqual({ ok: true, data: { vendorId: null, labName: null } });
  });

  it("resolves to null/null when the field is missing entirely (undefined)", () => {
    const r = resolveSendOutVendorSelection(true, undefined, LABS);
    expect(r).toEqual({ ok: true, data: { vendorId: null, labName: null } });
  });

  it("resolves the vendor's name for a valid active partner lab", () => {
    const r = resolveSendOutVendorSelection(true, LABS[1]!.id, LABS);
    expect(r).toEqual({
      ok: true,
      data: { vendorId: LABS[1]!.id, labName: "Micromedic" },
    });
  });

  it("rejects a vendor id that isn't in the active partner-lab list", () => {
    const r = resolveSendOutVendorSelection(true, "33333333-3333-3333-3333-333333333333", LABS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/partner lab/i);
  });

  it("rejects a deactivated/unflagged vendor even if it was previously selected", () => {
    // Simulates a vendor that lost is_partner_lab or is_active after being
    // chosen — the active list passed in no longer contains it.
    const r = resolveSendOutVendorSelection(true, LABS[0]!.id, []);
    expect(r.ok).toBe(false);
  });
});
