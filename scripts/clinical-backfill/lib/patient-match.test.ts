import { describe, it, expect } from "vitest";
import { buildPatientIndex, matchPatient, type PatientRow } from "./patient-match";

const patients: PatientRow[] = [
  { id: "p1", last_name: "Quinto", first_name: "Lee Angelo", sex: "male" },
  { id: "p2", last_name: "Dayego", first_name: "John Angelo", sex: "male" },
  { id: "p3", last_name: "Dayego", first_name: "John Patrick", sex: "male" }, // collision on key dayego|john
];
const idx = buildPatientIndex(patients);

describe("matchPatient", () => {
  it("unique match links", () => {
    expect(matchPatient("Quinto, Lee Angelo", "", idx)).toEqual({ kind: "match", patient_id: "p1" });
  });
  it("no candidate -> none", () => {
    expect(matchPatient("Cruz, Maria", "", idx)).toEqual({ kind: "none" });
  });
  it("multiple candidates on the same key -> ambiguous (never auto-pick)", () => {
    const r = matchPatient("Dayego, John", "", idx);
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") expect(r.candidates.sort()).toEqual(["p2", "p3"]);
  });
  it("blank/unparseable name -> none", () => {
    expect(matchPatient("   ", "", idx)).toEqual({ kind: "none" });
  });
});
