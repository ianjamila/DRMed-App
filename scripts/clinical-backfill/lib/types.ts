// Shared types for the clinical backfill importers.

/** One raw service line read from a master-sheet tab. */
export interface RawRow {
  row_number: number;
  posting_date: string | null; // ISO yyyy-mm-dd
  control_no: string;
  test_no: string;
  patient_name: string;
  hmo_flag: string;
  hmo_provider: string;
  service: string;
  base: number;
  final: number;
  clinic_fee: number; // consult only; 0 for lab
  doctor_pf: number;  // consult only; 0 for lab
  mop: string;
  or_number: string;
  date_paid: string | null;
}

export type Tab = "LAB SERVICE" | "DOCTOR CONSULTATION";

/** Column indices (1-based, ExcelJS) + per-tab build rules. */
export interface TabConfig {
  tab: Tab;
  sheetName: string;
  isConsult: boolean;
  cols: {
    posting_date: number; control_no: number; test_no: number; patient_name: number;
    hmo_flag: number; hmo_provider: number; service: number; base: number; final: number;
    clinic_fee?: number; doctor_pf?: number; mop: number; or_number: number; date_paid: number;
  };
}

export interface MatchedPatient {
  patient_id: string;            // existing or freshly-created
  created: boolean;              // true if we minted a new patient
}

export type RowClass =
  | "postable"
  | "out_of_window"
  | "bad_date"
  | "zero_amount";
