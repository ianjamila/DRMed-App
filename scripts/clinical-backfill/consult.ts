import { run } from "./engine";
import type { TabConfig } from "./lib/types";

// DOCTOR CONSULTATION column map (1-based) — verified from doctor-consultations.ts.
// CORRECTION C: date_paid is set to posting_date column (1) rather than column 21
// (date_submitted). The DOCTOR CONSULTATION tab has no reliable "date paid" column
// (12.B set date_paid: null for consults). Using posting_date ensures the engine's
// `received_at = r.date_paid ?? r.posting_date` resolves to the visit date rather
// than importing the wrong date.
const cfg: TabConfig = {
  tab: "DOCTOR CONSULTATION", sheetName: "DOCTOR CONSULTATION", isConsult: true,
  cols: {
    posting_date: 1, control_no: 2, test_no: 3, patient_name: 4, hmo_flag: 5,
    hmo_provider: 6, service: 8, base: 9, final: 12, clinic_fee: 13, doctor_pf: 17,
    mop: 14, or_number: 23, date_paid: 1,
  },
};
run(cfg).catch((e) => { console.error("FATAL:", e); process.exit(1); });
