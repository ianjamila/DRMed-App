import { describe, expect, it } from "vitest";
import { assignIdentities } from "./encounter-identity";
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
});
