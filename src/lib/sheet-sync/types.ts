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
