import { describe, expect, it } from "vitest";
import { planCustomers } from "./customer-plan";
import { buildPatientIndex } from "./patient-index";
import { parseCustomersTab } from "./tabs/customers";
import type { PatientRecord } from "./types";

const TODAY = "2026-09-24";
import { CUST_HEADER as HEADER } from "./__fixtures__/tab-headers";
function rowsOf(...specs: Array<{ name: string; dob?: number | string; phone?: string | number; ts?: number; src?: string; nr?: string }>) {
  const table = [HEADER, ...specs.map((s) => {
    const r: unknown[] = new Array(22).fill("");
    r[4] = s.name; r[6] = s.dob ?? ""; r[11] = s.phone ?? ""; r[16] = s.src ?? ""; r[19] = s.nr ?? ""; r[20] = s.ts ?? 46000;
    return r;
  })];
  return parseCustomersTab(table as never, { today: TODAY, aliases: new Map() }).rows;
}
let n = 0;
function patient(over: Partial<PatientRecord>): PatientRecord {
  n++;
  return { id: `p${n}`, drm_id: `DRM-${n}`, first_name: "Juan", middle_name: "Santos", last_name: "Dela Cruz",
    birthdate: "1990-01-01", phone: null, phone_normalized: null, email: null, sex: null, address: null,
    referred_by_doctor: null, preferred_release_medium: null, senior_pwd_id_kind: null, senior_pwd_id_number: null,
    referral_source: null, referral_source_origin: null, merged_into_id: null, ...over };
}
const plan = (rows: ReturnType<typeof rowsOf>, patients: PatientRecord[], extra: Partial<Parameters<typeof planCustomers>[0]> = {}) =>
  planCustomers({ rows, index: buildPatientIndex(patients), links: new Map(), facts: new Map(), prevRows: [], ...extra });

describe("planCustomers — §5.3 identity rules", () => {
  it("auto-links exactly one full-name candidate with no conflict", () => {
    const p = patient({});
    const out = plan(rowsOf({ name: "Dela Cruz, Juan Santos", dob: 32874 }), [p]);
    expect(out.ops).toContainEqual({ op: "link", link_key: "dela cruz|juan santos#1990-01-01", patient_id: p.id, method: "auto_exact" });
    expect(out.mirror[0]).toMatchObject({ patient_id: p.id, link_state: "linked" });
  });
  it("hard DOB conflict → identity_conflict review, no link", () => {
    const out = plan(rowsOf({ name: "Dela Cruz, Juan Santos", dob: 33000 }), [patient({})]);
    expect(out.ops.filter((o) => o.op === "link")).toHaveLength(0);
    expect(out.review[0].kind).toBe("identity_conflict");
  });
  it("different phones are allowed only when the DOB matches", () => {
    const p = patient({ phone_normalized: "9170000000" });
    expect(plan(rowsOf({ name: "Dela Cruz, Juan Santos", dob: 32874, phone: "09171112222" }), [p]).review).toHaveLength(0);
    const q = patient({ birthdate: null, phone_normalized: "9170000000" });
    expect(plan(rowsOf({ name: "Dela Cruz, Juan Santos", phone: "09171112222" }), [q]).review[0].kind).toBe("identity_conflict");
  });
  it("several full-name candidates → ambiguous_patient listing them", () => {
    const a = patient({}); const b = patient({ birthdate: null });
    const out = plan(rowsOf({ name: "Dela Cruz, Juan Santos" }), [a, b]);
    expect(out.review[0].kind).toBe("ambiguous_patient");
    expect((out.review[0].payload.candidates as unknown[]).length).toBe(2);
  });
  it("middle name added in the sheet: no full-name match, loose match → review, never a link or a create", () => {
    const p = patient({ middle_name: null });
    const out = plan(rowsOf({ name: "Dela Cruz, Juan Santos", dob: 32874 }), [p]);
    expect(out.ops.filter((o) => o.op !== "facts")).toHaveLength(0);
    expect(out.review[0].kind).toBe("ambiguous_patient");
  });
  it("surname corrected (no name match) but same phone → possible_existing_patient, not a create", () => {
    const p = patient({ last_name: "Dela Cruzz", phone_normalized: "9171112222" });
    const out = plan(rowsOf({ name: "Dela Cruz, Juan Santos", phone: "09171112222" }), [p]);
    expect(out.ops.some((o) => o.op === "create")).toBe(false);
    expect(out.review[0].kind).toBe("possible_existing_patient");
  });
  it("row linked last run vanished and a new row shares its DOB → possible_existing_patient", () => {
    const p = patient({ last_name: "Somebody Else", first_name: "Other" });
    const out = plan(rowsOf({ name: "Dela Cruz, Juan Santos", dob: 32874 }), [p], {
      prevRows: [{ source_key: "gone", patient_id: p.id, phone_norm: null, dob: "1990-01-01", link_state: "linked" }] });
    expect(out.review[0].kind).toBe("possible_existing_patient");
  });
  it("creates a patient only with zero full, zero loose and no corroboration", () => {
    const out = plan(rowsOf({ name: "Reyes, Ana Cruz", dob: 32874, src: "FACEBOOK", nr: "NEW" }), []);
    const create = out.ops.find((o) => o.op === "create");
    expect(create).toMatchObject({ op: "create", link_keys: ["reyes|ana cruz#1990-01-01"],
      fields: { first_name: "Ana", last_name: "Reyes", middle_name: "Cruz", birthdate: "1990-01-01", referral_source: "online_facebook" },
      facts: { new_repeat: "new" } });
  });
  it("two sheet rows for the same new person create ONE patient", () => {
    const out = plan(rowsOf({ name: "Reyes, Ana Cruz", dob: 32874, ts: 46000 }, { name: "Reyes, Ana Cruz", ts: 46100 }), []);
    const creates = out.ops.filter((o) => o.op === "create");
    expect(creates).toHaveLength(1);
    expect((creates[0] as { link_keys: string[] }).link_keys.sort()).toEqual(["reyes|ana cruz#", "reyes|ana cruz#1990-01-01"]);
  });
  it("a merged patient's link resolves to its survivor", () => {
    const keep = patient({}); const gone = patient({ merged_into_id: keep.id });
    const links = new Map([["dela cruz|juan santos#1990-01-01", { link_key: "dela cruz|juan santos#1990-01-01", patient_id: gone.id, decision: "link" as const, method: "admin" as const }]]);
    const out = plan(rowsOf({ name: "Dela Cruz, Juan Santos", dob: 32874 }), [keep, gone], { links });
    expect(out.mirror[0].patient_id).toBe(keep.id);
  });
  it("an admin 'create new' decision creates even when a candidate exists", () => {
    const p = patient({});
    const links = new Map([["dela cruz|juan santos#1990-01-01", { link_key: "dela cruz|juan santos#1990-01-01", patient_id: null, decision: "create" as const, method: "admin" as const }]]);
    const out = plan(rowsOf({ name: "Dela Cruz, Juan Santos", dob: 32874 }), [p], { links });
    expect(out.ops.find((o) => o.op === "create")).toMatchObject({ method: "admin" });
  });
  it("fills only blank fields and never touches a staff-owned channel", () => {
    const p = patient({ phone: null, email: "x@example.com", referral_source: "walk_in", referral_source_origin: "staff" });
    const out = plan(rowsOf({ name: "Dela Cruz, Juan Santos", dob: 32874, phone: "09171112222", src: "FACEBOOK" }), [p]);
    const fill = out.ops.find((o) => o.op === "fill");
    expect(fill).toEqual({ op: "fill", patient_id: p.id, fields: { phone: "+639171112222" } });
  });
  it("a sheet-owned channel follows the sheet, including back to blank", () => {
    const p = patient({ referral_source: "online_facebook", referral_source_origin: "sheet" });
    const out = plan(rowsOf({ name: "Dela Cruz, Juan Santos", dob: 32874, src: "" }), [p]);
    expect(out.ops.find((o) => o.op === "fill")).toEqual({ op: "fill", patient_id: p.id, fields: { referral_source: null } });
  });
  it("the earliest dated row supplies a patient's channel and facts", () => {
    const p = patient({});
    const out = plan(rowsOf(
      { name: "Dela Cruz, Juan Santos", dob: 32874, ts: 46100, src: "GOOGLE", nr: "REPEAT" },
      { name: "Dela Cruz, Juan Santos", dob: 32874, ts: 46000, src: "FACEBOOK", nr: "NEW" }), [p]);
    expect(out.ops.find((o) => o.op === "fill")).toMatchObject({ fields: { referral_source: "online_facebook" } });
    expect(out.ops.find((o) => o.op === "facts")).toMatchObject({ registered_on: "2025-12-09", new_repeat: "new" });
  });
  it("sends no op when nothing changed (nightly runs stay small)", () => {
    const p = patient({ referral_source: "online_facebook", referral_source_origin: "sheet", phone: "+639171112222", phone_normalized: "9171112222" });
    const links = new Map([["dela cruz|juan santos#1990-01-01", { link_key: "dela cruz|juan santos#1990-01-01", patient_id: p.id, decision: "link" as const, method: "auto_exact" as const }]]);
    const facts = new Map([[p.id, { patient_id: p.id, registered_on: "2025-12-09", sheet_new_repeat: null, source_ref: "CUSTOMER LIST2 r2" }]]);
    const out = plan(rowsOf({ name: "Dela Cruz, Juan Santos", dob: 32874, phone: "09171112222", src: "FACEBOOK" }), [p], { links, facts });
    expect(out.ops).toEqual([]);
  });
  it("raises one unmapped_source item per answer, with its count", () => {
    const out = plan(rowsOf({ name: "Reyes, Ana", src: "CUSTOMER LIST" }, { name: "Cruz, Ben", src: "customer list" }), []);
    expect(out.review.filter((r) => r.kind === "unmapped_source")).toEqual([
      { kind: "unmapped_source", item_key: "CUSTOMER LIST", payload: { answer: "CUSTOMER LIST", rows: 2 } }]);
  });
});
