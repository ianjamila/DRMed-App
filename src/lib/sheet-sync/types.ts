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
  /**
   * 0167's patients.deleted_at. Only meaningful in the customer-world fixture
   * (which mirrors sheet_sync_apply_customer_ops's SQL and so must see the
   * whole patients table, deleted rows included); the real loader
   * (store.ts's loadPatients) filters it out server-side, so a row a live
   * planner run ever sees always has it null. Optional so existing
   * fixtures/tests need no changes.
   */
  deleted_at?: string | null;
  /**
   * 0170's patients.row_version (bumped by trg_patients_referral_origin on
   * every UPDATE). Optional so existing fixtures/tests that don't care about
   * the stale-read guard need no changes; the real loader always sends it.
   */
  row_version?: number;
}

/**
 * A saved identity decision for one link key (sheet_patient_links).
 * "review" is a HOLD: patient_id is null and the sync never auto-decides the
 * key again — every run sends it to review until an admin resolves it (which
 * replaces the row with an admin link or create). The database enforces it
 * too: link and create never overwrite a hold (0170).
 */
export interface LinkRecord {
  link_key: string;
  patient_id: string | null;
  decision: "link" | "create" | "review";
  method: "auto_exact" | "auto_loose" | "admin";
  /** Why a hold was placed (the planner reason, or "undone by an admin"); null otherwise. */
  hold_reason?: string | null;
  /** 0193: the deleted patient a `matches_deleted_patient` hold was placed for (the hold clears patient_id). */
  held_patient_id?: string | null;
}

/**
 * A deleted patient's identity evidence (review fix E) — 0167's soft-deleted
 * patients, loaded SEPARATELY from `PatientRecord`/`loadPatients` and never
 * used as a link/fill target. Only what the name+DOB/name+phone matchers
 * need; store.ts's loader also selects deleted_at/merged_into_id (unused
 * here) to satisfy query-surfaces.test.ts's lifecycle-read convention.
 */
export interface DeletedPatientEvidence {
  id: string;
  first_name: string | null;
  middle_name: string | null;
  last_name: string | null;
  birthdate: string | null;
  phone: string | null;
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
  /**
   * `method` is for reporting only. Each link key is written with method
   * "admin" when it is in `admin_link_keys` (its saved decision was an admin
   * "create") and "auto_exact" otherwise, so a key that merely joined the
   * admin-created person is conflict-tested again on every later run.
   */
  | { op: "create"; create_key: string; method: "auto_exact" | "admin"; link_keys: string[]; admin_link_keys: string[];
      fields: FillFields & { first_name: string; last_name: string; middle_name: string | null };
      legacy_intake: Record<string, unknown>;
      facts: { registered_on: string | null; new_repeat: "new" | "repeat" | null; source_ref: string } }
  /**
   * `expected_row_version` (Codex P1, stale-read guard): the patient's
   * row_version as the planner read it. 0170 skips the op (counted `stale`)
   * when the patient's row_version has since moved — the next run re-plans
   * from a fresh read. Optional: a caller that omits it gets no protection
   * (every real op the planner emits sets it).
   */
  | { op: "link"; link_key: string; patient_id: string; method: "auto_exact" | "auto_loose"; expected_row_version?: number }
  | { op: "fill"; patient_id: string; fields: FillFields; expected_row_version?: number }
  /**
   * `expected_row_version` (review fix D, S2): the SAME guard as link/fill —
   * facts is planned from the same patient read as its sibling link/fill ops,
   * so a stale identity must reject it too, not just them. The planner always
   * sets it (the read version). 0193's SQL accepts the current version when it
   * equals this OR when it is exactly the version this run's own fill for the
   * patient produced from it (a fill bumps row_version by one), whichever
   * chunk the fill landed in; anything else — staff edited the patient, it was
   * deleted/merged — is `stale` and reported in `stale_patient_ids`.
   */
  | { op: "facts"; patient_id: string; registered_on: string | null; new_repeat: "new" | "repeat" | null; source_ref: string; expected_row_version?: number }
  /** Persist a review: upsert (link_key, patient_id null, decision "review"), never over an admin row. */
  | { op: "hold"; link_key: string; reason: string; /** 0193: stored on the link as held_patient_id */ deleted_patient_id?: string };

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
            facts: number; hold: number; review: Record<string, number> };
}
