import { describe, it, expect } from "vitest";
import { mapConsultRow, mapProcedureRow, type ConsultRowSource, type ProcedureRowSource } from "./mappers";

// ---- Shared fixtures --------------------------------------------------------

const consultBase: ConsultRowSource = {
  visit_number: "V-0001",
  test_number: 42,
  patient_full_name: "Dela Cruz, Juan",
  hmo_provider_name: null,
  hmo_approval_date: null,
  doctor_consultant: null,
  base_price_php: 500,
  discount_kind: null,
  discount_amount_php: 0,
  final_price_php: 500,
  clinic_fee_php: 150,
  payment_status: "paid",
  payment_references: "",
  receptionist_remarks: null,
};

const procedureBase: ProcedureRowSource = {
  visit_date: "2026-08-01",
  patient_full_name: "Dela Cruz, Juan",
  hmo_provider_name: null,
  hmo_approval_date: null,
  procedure_description: "Ear irrigation",
  doctor_consultant: null,
  hmo_approved_amount_php: null,
};

// ---- Doctor Consultant column position --------------------------------------
// Spec order: Control No | Test No | Patient Name | HMO? | HMO Provider |
// HMO Approval Date | Doctor Consultant | ... (index 6)

describe("mapConsultRow — doctor_consultant column", () => {
  it("places the resolved doctor name at column index 6", () => {
    const row = mapConsultRow({ ...consultBase, doctor_consultant: "Dr. Santos, Maria" });
    expect(row[6]).toBe("Dr. Santos, Maria");
  });

  it("renders null as an empty string, not literal 'null'", () => {
    const row = mapConsultRow({ ...consultBase, doctor_consultant: null });
    expect(row[6]).toBe("");
  });

  it("doesn't disturb neighboring columns", () => {
    const row = mapConsultRow({ ...consultBase, doctor_consultant: "Dr. Santos, Maria" });
    expect(row[5]).toBe(""); // hmo_approval_date
    expect(row[7]).toBe(500); // base_price_php
  });
});

// ---- Doctor Procedures HMO — doctor_consultant column -----------------------
// Spec order: Date | Patient Name | HMO Provider | Approval Date |
// Service Description | Doctor Consultant | Approved Amount (index 5)

describe("mapProcedureRow — doctor_consultant column", () => {
  it("places the resolved doctor name at column index 5", () => {
    const row = mapProcedureRow({ ...procedureBase, doctor_consultant: "Dr. Reyes, Carlo" });
    expect(row[5]).toBe("Dr. Reyes, Carlo");
  });

  it("renders null as an empty string, not literal 'null'", () => {
    const row = mapProcedureRow({ ...procedureBase, doctor_consultant: null });
    expect(row[5]).toBe("");
  });

  it("doesn't disturb neighboring columns", () => {
    const row = mapProcedureRow({ ...procedureBase, doctor_consultant: "Dr. Reyes, Carlo" });
    expect(row[4]).toBe("Ear irrigation"); // procedure_description
    expect(row[6]).toBe(""); // hmo_approved_amount_php
  });
});
