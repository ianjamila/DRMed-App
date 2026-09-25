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

  it("rejects a NEW pick of a vendor that isn't in the active partner-lab list", () => {
    // Simulates a vendor that lost is_partner_lab or is_active — the active
    // list passed in no longer contains it — and the row's existing lab was
    // something else, so this is a genuinely new selection.
    const r = resolveSendOutVendorSelection(true, LABS[0]!.id, [], {
      vendorId: LABS[1]!.id,
      labName: "Micromedic",
    });
    expect(r.ok).toBe(false);
  });

  it("keeps the row's OWN current lab even if it has since gone inactive/unflagged", () => {
    // Same vendor id the row already had — re-saving an unrelated field must
    // not be blocked just because that lab dropped out of the active list.
    const r = resolveSendOutVendorSelection(true, LABS[0]!.id, [], {
      vendorId: LABS[0]!.id,
      labName: "Hi Precision",
    });
    expect(r).toEqual({ ok: true, data: { vendorId: LABS[0]!.id, labName: "Hi Precision" } });
  });

  it("keeps unmatched legacy free text when left at '— Not set —' on an unrelated save", () => {
    // send_out_vendor_id was already null (legacy free text only) — leaving
    // the select at its default must not erase send_out_lab.
    const r = resolveSendOutVendorSelection(true, "", LABS, {
      vendorId: null,
      labName: "Some Old Lab Inc.",
    });
    expect(r).toEqual({ ok: true, data: { vendorId: null, labName: "Some Old Lab Inc." } });
  });

  it("clears both when a service that HAD a proper vendor link is reset to '— Not set —'", () => {
    // This is a deliberate clear, not an untouched default — the vendor
    // link existed, so resetting the select must actually clear it.
    const r = resolveSendOutVendorSelection(true, "", LABS, {
      vendorId: LABS[0]!.id,
      labName: "Hi Precision",
    });
    expect(r).toEqual({ ok: true, data: { vendorId: null, labName: null } });
  });
});
