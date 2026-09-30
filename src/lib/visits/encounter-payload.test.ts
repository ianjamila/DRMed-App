import { describe, expect, it } from "vitest";
import { buildEncounterVisit, toCentavos, type EncounterLineInput } from "./encounter-payload";

let n = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const line = (service_id: string, final: number, extra: Partial<EncounterLineInput> = {}): EncounterLineInput => ({
  service_id, base_price_php: final, discount_kind: null, discount_amount_php: 0, final_price_php: final,
  clinic_fee_php: null, doctor_pf_php: null, procedure_description: null, hmo_approved_amount_php: null, ...extra,
});
const hmo = { hmo_provider_id: "h", hmo_approval_date: "2026-09-25", hmo_authorization_no: "A1" };

describe("buildEncounterVisit", () => {
  it("sums the order lines into the visit total", () => {
    const r = buildEncounterVisit({
      lines: [line("s1", 100), line("s2", 250)], decompositions: [], hmo, attendingPhysicianId: null,
      receptionistRemarks: "rm", notes: "n", isSample: false,
    }, nextId);
    expect(r.ok && r.payload.visit.total_php).toBe(350);
  });

  it("turns a package line into a header plus ₱0 components that point at it", () => {
    const r = buildEncounterVisit({
      lines: [line("pkg", 1500, { discount_kind: "senior", discount_amount_php: 300, final_price_php: 1200 })],
      decompositions: [{ headerLine: { service_id: "pkg" }, componentServiceIds: ["c1", "c2"] }],
      hmo, attendingPhysicianId: null, receptionistRemarks: "rm", notes: null, isSample: false,
    }, nextId);
    if (!r.ok) throw new Error(r.error);
    const [header, ...components] = r.payload.lines;
    expect(header).toMatchObject({ service_id: "pkg", is_package_header: true, status: "in_progress", parent_id: null, final_price_php: 1200 });
    expect(components.map((c) => c.service_id)).toEqual(["c1", "c2"]);
    for (const c of components) {
      expect(c).toMatchObject({
        parent_id: header!.id, is_package_header: false, status: "requested", base_price_php: 0,
        discount_kind: null, discount_amount_php: 0, final_price_php: 0, receptionist_remarks: null,
        clinic_fee_php: null, doctor_pf_php: null, procedure_description: null, hmo_approved_amount_php: null,
        hmo_provider_id: "h", hmo_approval_date: "2026-09-25", hmo_authorization_no: "A1",
      });
    }
    expect(r.payload.visit.total_php).toBe(1200);
  });

  it("pairs two lines of the same package with their own decompositions, in order", () => {
    const r = buildEncounterVisit({
      lines: [line("pkg", 100), line("pkg", 200)],
      decompositions: [
        { headerLine: { service_id: "pkg" }, componentServiceIds: ["a"] },
        { headerLine: { service_id: "pkg" }, componentServiceIds: ["b"] },
      ],
      hmo, attendingPhysicianId: null, receptionistRemarks: null, notes: null, isSample: true,
    }, nextId);
    if (!r.ok) throw new Error(r.error);
    const headers = r.payload.lines.filter((l) => l.is_package_header);
    expect(headers.map((h) => h.final_price_php)).toEqual([100, 200]);
    const childOf = (h: { id: string }) => r.payload.lines.filter((l) => l.parent_id === h.id).map((l) => l.service_id);
    expect(headers.map(childOf)).toEqual([["a"], ["b"]]);
    expect(r.payload.visit.is_sample).toBe(true);
  });

  it("refuses a decomposition with no matching order line", () => {
    const r = buildEncounterVisit({
      lines: [line("s1", 100)], decompositions: [{ headerLine: { service_id: "pkg" }, componentServiceIds: ["c"] }],
      hmo, attendingPhysicianId: null, receptionistRemarks: null, notes: null, isSample: false,
    }, nextId);
    expect(r.ok).toBe(false);
  });

  it("sums fractional prices in centavos: 100.10 + 200.20 is 300.3, not 300.29999999999995", () => {
    const r = buildEncounterVisit({
      lines: [line("s1", 100.1), line("s2", 200.2)], decompositions: [], hmo, attendingPhysicianId: null,
      receptionistRemarks: null, notes: null, isSample: false,
    }, nextId);
    expect(r.ok && r.payload.visit.total_php).toBe(300.3);
    expect(100.1 + 200.2).not.toBe(300.3); // the float trap this guards against
  });

  it("normalises a float-noisy discounted line to centavos (99.99 − 20 → 79.99)", () => {
    const noisy = 99.99 - 20; // 79.99000000000001
    const r = buildEncounterVisit({
      lines: [line("s1", noisy, { base_price_php: 99.99, discount_kind: "promo", discount_amount_php: 20 })],
      decompositions: [], hmo, attendingPhysicianId: null, receptionistRemarks: null, notes: null, isSample: false,
    }, nextId);
    if (!r.ok) throw new Error(r.error);
    expect(r.payload.lines[0]!.final_price_php).toBe(79.99);
    expect(r.payload.visit.total_php).toBe(79.99);
  });

  it("each half of a split encounter carries its own centavo total", () => {
    const half = (prices: number[]) => buildEncounterVisit({
      lines: prices.map((p, i) => line(`s${i}`, p)), decompositions: [], hmo, attendingPhysicianId: null,
      receptionistRemarks: null, notes: null, isSample: false,
    }, nextId);
    const doctor = half([0.1, 0.2]);
    const lab = half([100.1]);
    expect(doctor.ok && doctor.payload.visit.total_php).toBe(0.3);
    expect(lab.ok && lab.payload.visit.total_php).toBe(100.1);
  });

  it("toCentavos rounds float noise to the nearest centavo", () => {
    expect(toCentavos(300.29999999999995)).toBe(30030);
    expect(toCentavos(79.99000000000001)).toBe(7999);
    expect(toCentavos(0)).toBe(0);
  });

  it("gives standalone lines status requested and every line an id", () => {
    const r = buildEncounterVisit({
      lines: [line("s1", 100)], decompositions: [], hmo, attendingPhysicianId: "doc",
      receptionistRemarks: null, notes: null, isSample: false,
    }, nextId);
    if (!r.ok) throw new Error(r.error);
    expect(r.payload.lines[0]).toMatchObject({ status: "requested", is_package_header: false, parent_id: null });
    expect(r.payload.lines.every((l) => l.id.length === 36)).toBe(true);
    expect(r.payload.visit.attending_physician_id).toBe("doc");
  });
});
