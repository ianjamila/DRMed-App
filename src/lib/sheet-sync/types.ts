/**
 * Shared row / plan / store types for Sheet Sync (spec §4–§5, plan Task 4).
 * Pure and not server-only: the CLI imports it.
 */

export type TabKey = "customers" | "lab" | "consult";

export const SHEET_TAB_NAMES: Record<TabKey, string> = {
  customers: "CUSTOMER LIST2",
  lab: "LAB SERVICE",
  consult: "DOCTOR CONSULTATION",
};

export type Cell = string | number | boolean | null | undefined;
export type RawTabs = Record<TabKey, Cell[][]>;

export type ReviewKind =
  | "ambiguous_patient"
  | "identity_conflict"
  | "possible_existing_patient"
  | "unmapped_source"
  | "unparseable_date"
  | "invalid_row"
  | "suspect_snapshot";

export interface ReviewItemInput {
  kind: ReviewKind;
  item_key: string;
  payload: Record<string, unknown>;
}

export interface CustomerRow {
  sheetRow: number; // 1-based row number as the sheet shows it
  fullNameRaw: string;
  first: string | null;
  middle: string | null;
  last: string | null;
  nameNorm: string;
  looseKey: string;
  linkKey: string;
  tokens: string[];
  phoneE164: string | null;
  phone10: string | null;
  email: string | null;
  dob: string | null;
  sex: "male" | "female" | null;
  address: string | null;
  referredByDoctor: string | null; // "Doctor" column — same field the May import filled
  referredByRaw: string | null; // "Referred By:" column — mirror only (PR 2)
  releaseMedium: string | null;
  releaseMediumRaw: string | null;
  seniorKind: "senior" | "pwd" | null;
  seniorNumber: string | null;
  registeredOn: string | null;
  sourceRaw: string;
  sourceNorm: string;
  referralSourceId: string | null;
  unmappedSource: boolean;
  newRepeat: "new" | "repeat" | null;
  raw: Record<string, string>; // header → cell text, same shape as legacy_intake.raw
  rowHash: string;
  sourceKey: string;
  dupCount: number;
}

export interface EncounterLine {
  tab: "lab" | "consult";
  sheetRow: number;
  serviceDate: string;
  nameRaw: string;
  first: string | null;
  middle: string | null;
  last: string | null;
  nameNorm: string;
  looseKey: string;
  tokens: string[];
  serviceRaw: string | null;
  doctorRaw: string | null;
  hmoRaw: string | null;
  basePhp: number | null;
  finalPhp: number | null;
  clinicFeePhp: number | null;
  revenuePhp: number | null;
  paymentMethodRaw: string | null;
  paymentDetailRaw: string | null;
  releaseMediumRaw: string | null;
  releasedOn: string | null;
  controlNo: string | null;
  testNo: string | null;
  raw: Cell[];
  rowHash: string;
}

export interface TabParse<T> {
  rows: T[];
  rowsRead: number; // named rows in the whole tab (snapshot check basis)
  lastDate: string | null; // "sheet last updated" shown on the admin page
  undated: number;
  issues: ReviewItemInput[];
}

// ---------------------------------------------------------------------------
// Task 5 — patient identity plan (spec §5.3, plan Task 5 Step 1)
// ---------------------------------------------------------------------------

export interface PatientRecord {
  id: string;
  drm_id: string;
  first_name: string | null;
  middle_name: string | null;
  last_name: string | null;
  birthdate: string | null;
  phone: string | null;
  phone_normalized: string | null;
  email: string | null;
  sex: string | null;
  address: string | null;
  referred_by_doctor: string | null;
  preferred_release_medium: string | null;
  senior_pwd_id_kind: string | null;
  senior_pwd_id_number: string | null;
  referral_source: string | null;
  referral_source_origin: "staff" | "patient" | "sheet" | null;
  merged_into_id: string | null;
}

export interface LinkRecord {
  link_key: string;
  patient_id: string | null;
  decision: "link" | "create";
  method: "auto_exact" | "auto_loose" | "admin";
}

export interface FactsRecord {
  patient_id: string;
  registered_on: string | null;
  sheet_new_repeat: "new" | "repeat" | null;
  source_ref: string | null;
}

export interface PrevCustomerRow {
  source_key: string;
  patient_id: string | null;
  phone_norm: string | null;
  dob: string | null;
  link_state: string;
}

export type FillFields = Partial<Record<
  | "phone" | "email" | "birthdate" | "sex" | "address" | "referred_by_doctor"
  | "preferred_release_medium" | "senior_pwd_id_kind" | "senior_pwd_id_number" | "referral_source",
  string | null>>;

export type CustomerOp =
  | { op: "create"; create_key: string; method: "auto_exact" | "admin"; link_keys: string[];
      fields: FillFields & { first_name: string; last_name: string; middle_name: string | null };
      legacy_intake: Record<string, unknown>;
      facts: { registered_on: string | null; new_repeat: "new" | "repeat" | null; source_ref: string } }
  | { op: "link"; link_key: string; patient_id: string; method: "auto_exact" | "auto_loose" }
  | { op: "fill"; patient_id: string; fields: FillFields }
  | { op: "facts"; patient_id: string; registered_on: string | null; new_repeat: "new" | "repeat" | null; source_ref: string };

export type LinkState = "linked" | "ambiguous" | "conflict" | "possible_existing" | "unlinked";

export interface CustomerMirrorRow {
  sheet_row: number; source_key: string; dup_count: number; full_name_raw: string; name_norm: string;
  loose_key: string; link_key: string; phone_norm: string | null; dob: string | null; registered_on: string | null;
  source_raw: string; source_norm: string; referral_source_id: string | null; referred_by_raw: string | null;
  new_repeat: "new" | "repeat" | null; release_medium_raw: string | null;
  patient_id: string | null;          // filled after ops for "create:<key>" rows
  pending_create_key: string | null;  // runner swaps it for the created id; never sent to the DB
  link_state: LinkState; row_hash: string;
}

export interface CustomerPlan {
  ops: CustomerOp[];
  mirror: CustomerMirrorRow[];
  review: ReviewItemInput[];
  counts: { rows: number; linked_existing: number; link_new: number; create: number; fill: number;
            facts: number; review: Record<string, number> };
}
