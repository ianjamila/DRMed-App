export type ImportWarning =
  | "dob_missing"
  | "dob_unparseable"
  | "phone_unparseable"
  | "sex_unparseable"
  | "name_unparseable"
  | "senior_pwd_id_missing"
  | { kind: "referral_source_unmapped"; raw: string }
  | { kind: "release_medium_unmapped"; raw: string };

export interface LegacyIntakePayload {
  source: "google_sheet_CUSTOMER_LIST2";
  imported_at: string;          // ISO timestamp
  original_row_index: number;   // 1-based CSV row, header counted as row 1
  raw: Record<string, string>;  // every sheet column verbatim
  import_warnings: ImportWarning[];
  duplicate_of?: number[];      // when collapsed to a canonical row in-sheet
}

export interface ParsedRow {
  first_name: string | null;
  last_name: string | null;
  middle_name: string | null;
  birthdate: string | null;          // ISO yyyy-mm-dd or null
  sex: "male" | "female" | null;
  phone: string | null;              // E.164, e.g. +639171234567
  email: string | null;              // lowercased
  address: string | null;
  referral_source: string | null;    // referral_sources.id
  referred_by_doctor: string | null;
  preferred_release_medium: string | null;
  senior_pwd_id_kind: "senior" | "pwd" | null;
  senior_pwd_id_number: string | null;
  legacy_intake: LegacyIntakePayload;
}
