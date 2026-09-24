import { describe, expect, it } from "vitest";
import { assignIdentities, isTokenMultisetSuperset } from "./encounter-identity";
import { buildPatientIndex } from "./patient-index";
import type { EncounterLine, PatientRecord } from "./types";

const p = (id: string, over: Partial<PatientRecord> = {}): PatientRecord => ({ id, drm_id: id, first_name: "Juan", middle_name: "Santos",
  last_name: "Dela Cruz", birthdate: null, phone: null, phone_normalized: null, email: null, sex: null, address: null,
  referred_by_doctor: null, preferred_release_medium: null, senior_pwd_id_kind: null, senior_pwd_id_number: null,
  referral_source: null, referral_source_origin: null, merged_into_id: null, ...over });
const line = (first: string, middle: string | null, last = "Dela Cruz"): EncounterLine => ({
  tab: "consult", sheetRow: 3, serviceDate: "2026-06-01", nameRaw: `${last}, ${first}`, first, middle, last,
  nameNorm: `${last.toLowerCase()}|${[first, middle].filter(Boolean).join(" ").toLowerCase()}`,
  looseKey: `${last.toLowerCase()}|${first.toLowerCase()}`,
  tokens: [...last.toLowerCase().split(" "), first.toLowerCase(), ...(middle ? [middle.toLowerCase()] : [])],
  serviceRaw: null, doctorRaw: null, hmoRaw: null, basePhp: 1, finalPhp: 1, clinicFeePhp: 1, revenuePhp: 1,
  paymentMethodRaw: null, paymentDetailRaw: null, releaseMediumRaw: null, releasedOn: null, controlNo: null,
  testNo: null, raw: [], rowHash: "h" });

describe("assignIdentities", () => {
  it("exact full name → patient", () => {
    const [a] = assignIdentities([line("Juan", "Santos")], buildPatientIndex([p("A")]), new Map());
    expect(a).toMatchObject({ patientId: "A", identityKey: "patient:A" });
  });
  it("loose fallback: consult typed without the middle name → the one superset patient", () => {
    const [a] = assignIdentities([line("Juan", null)], buildPatientIndex([p("A")]), new Map());
    expect(a.identityKey).toBe("patient:A");
  });
  it("loose fallback refuses when two patients share the loose key", () => {
    const [a] = assignIdentities([line("Juan", null)], buildPatientIndex([p("A"), p("B", { middle_name: "Reyes" })]), new Map());
    expect(a).toMatchObject({ patientId: null, identityKey: "name:dela cruz|juan" });
  });
  it("a link decision for the name wins when all its links agree", () => {
    const links = new Map([["dela cruz|juan#1990-01-01", { link_key: "dela cruz|juan#1990-01-01", patient_id: "B", decision: "link" as const, method: "admin" as const }]]);
    const [a] = assignIdentities([line("Juan", null)], buildPatientIndex([p("A"), p("B", { middle_name: null })]), links);
    expect(a.patientId).toBe("B");
  });
  it("unlinked lab and consult spellings of one person share one name identity", () => {
    const [a, b] = assignIdentities([line("Ana", "Cruz", "Reyes"), line("Ana", null, "Reyes")], buildPatientIndex([]), new Map());
    expect(a.identityKey).toBe(b.identityKey);
  });
  it("I3: a DOB-keyed AUTO decision does not pick one of two live patients sharing the name", () => {
    const links = new Map([["dela cruz|juan#1990-01-01", { link_key: "dela cruz|juan#1990-01-01", patient_id: "A", decision: "link" as const, method: "auto_exact" as const }]]);
    const idx = buildPatientIndex([p("A", { middle_name: null, birthdate: "1990-01-01" }), p("B", { middle_name: null, birthdate: "1985-05-05" })]);
    const [a] = assignIdentities([line("Juan", null)], idx, links);
    expect(a).toMatchObject({ patientId: null, identityKey: "name:dela cruz|juan" });
  });
  it("I3: an undated-key decision (name#) applies whatever its method", () => {
    const links = new Map([["dela cruz|juan#", { link_key: "dela cruz|juan#", patient_id: "B", decision: "link" as const, method: "auto_exact" as const }]]);
    const idx = buildPatientIndex([p("A", { middle_name: null }), p("B", { middle_name: null })]);
    expect(assignIdentities([line("Juan", null)], idx, links)[0].patientId).toBe("B");
  });
  it("I3: step 1 is skipped when the decisions point at two different patients", () => {
    const links = new Map([
      ["dela cruz|juan#", { link_key: "dela cruz|juan#", patient_id: "A", decision: "link" as const, method: "auto_exact" as const }],
      ["dela cruz|juan#1985-05-05", { link_key: "dela cruz|juan#1985-05-05", patient_id: "B", decision: "link" as const, method: "admin" as const }]]);
    const idx = buildPatientIndex([p("A", { middle_name: null }), p("B", { middle_name: null })]);
    expect(assignIdentities([line("Juan", null)], idx, links)[0].patientId).toBeNull();
  });
  it("C3: a line spelled like a merged-away patient resolves to the survivor", () => {
    const idx = buildPatientIndex([p("S", { last_name: "Delacruz", middle_name: null }), p("M", { middle_name: null, merged_into_id: "S" })]);
    expect(assignIdentities([line("Juan", null)], idx, new Map())[0].identityKey).toBe("patient:S");
  });
  it("M4: the loose fallback needs a MULTISET superset (a repeated token must appear twice)", () => {
    expect(isTokenMultisetSuperset(["dela", "cruz", "juan", "santos"], ["dela", "cruz", "juan", "dela"])).toBe(false);
    expect(isTokenMultisetSuperset(["dela", "cruz", "juan", "dela"], ["dela", "cruz", "juan", "dela"])).toBe(true);
    expect(isTokenMultisetSuperset(["dela", "cruz", "juan", "santos"], ["dela", "cruz", "juan"])).toBe(true);
    const [a] = assignIdentities([line("Juan", "Dela")], buildPatientIndex([p("A")]), new Map());
    expect(a.patientId).toBeNull();
  });
});
