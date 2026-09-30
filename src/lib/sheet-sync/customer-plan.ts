/**
 * Customers identity plan (spec §5.3, plan Task 5): turns a snapshot of
 * Customers rows into ops (create / link / fill / facts), mirror rows and
 * review items. Pure and not server-only: the CLI imports it.
 *
 * Identity is decided per LINK KEY (name_norm ‖ dob), never per row: every
 * row of a key gets the same answer, so one key can never be half linked,
 * half reviewed or half created (and a decision saved for the key is re-tested
 * against every row, every run). When unsure the rows go to review — a wrong
 * link writes one person's phone/email/address/DOB onto another's record, and
 * a wrong create makes a duplicate patient.
 *
 * Order per key group:
 *   0. `review` decision (a HOLD) → always review; never link, create or fill
 *   a. admin `link`  → that patient's survivor (no conflict test); unknown → review
 *   b. `create` decision → create; admin trust for THAT key only
 *   c. auto `link`   → survivor, conflict test on EVERY row; unknown → (d)
 *   d. full-name (1 → conflict test / ≥2 → review) → loose (review) →
 *      corroboration (review) → pending create
 * then a per-patient pass tests every auto-linked row against what the patient
 * will hold AFTER this run's fill — built from the patient, then admin-linked
 * rows, then DOB-confirmed rows, and only then are undated rows tested, so the
 * answer never depends on which row is older — and pending creates become
 * new-person clusters that are checked against each other before any is
 * created.
 *
 * A review that the next run could not reproduce on its own (a batch
 * collision between two new people, or a key whose saved auto link is now
 * doubted) is persisted as a `hold` op, so the next run cannot quietly create
 * or re-link it; only an admin resolve replaces a hold. Every decision here is
 * independent of the order of the sheet rows.
 */
import { isTokenMultisetSuperset, type PatientIndex } from "./patient-index";
import { nameNormOf, phone10 } from "./names";
import type {
  CustomerMirrorRow, CustomerOp, CustomerPlan, CustomerRow, DeletedPatientEvidence, FactsRecord, FillFields, LinkRecord,
  LinkState, PatientRecord, PrevCustomerRow, ReviewItemInput,
} from "./types";

/**
 * The sentinel written to `sheet_patient_links.hold_reason` (and, once a run
 * re-surfaces the hold, to `payload.held_because` — see `resolveHeld` below)
 * for a deleted-patient-match hold (review fix E, owner decision 2026-09-25).
 * A machine slug, not prose, because 0170's SQL matches it literally in two
 * places (the dismiss guard and the "stays dismissed" re-open check) — same
 * shape as the existing 'undone by an admin' sentinel.
 */
export const DELETED_PATIENT_HOLD_REASON = "matches_deleted_patient";

interface Input {
  rows: readonly CustomerRow[];
  index: PatientIndex;
  links: ReadonlyMap<string, LinkRecord>;
  facts: ReadonlyMap<string, FactsRecord>;
  prevRows: readonly PrevCustomerRow[];
  /** 0167 soft-deleted patients' identity evidence (review fix E). Optional — defaults to none, so existing callers/tests are unaffected. */
  deletedPatients?: readonly DeletedPatientEvidence[];
  importedAtIso?: string;       // legacy_intake.imported_at; runner passes the run start
}

type IdentityReview = "ambiguous_patient" | "identity_conflict" | "possible_existing_patient";

type Resolution =
  | { kind: "linked"; patientId: string; trusted: boolean; linkOp: null | "auto_exact" | "auto_loose" }
  | { kind: "create" }
  | { kind: "review"; review: IdentityReview; reason: string; candidates: string[]; extra?: Record<string, unknown>;
      /** decided by names alone (several full-name patients / a similar name): no hold needed */
      nameOnly?: boolean };

interface Group {
  key: string;            // linkKey
  nameNorm: string;
  looseKey: string;
  dob: string | null;
  rows: CustomerRow[];    // sheet order
  res: Resolution;
  /** saved decision for this key (if any) */
  stored: LinkRecord | undefined;
  /** the saved decision is an admin `create`: this key alone carries admin trust */
  adminCreate: boolean;
  /** sent to review because another NEW person in this batch looks like it (held) */
  collision: boolean;
}

interface Cluster {
  groups: Group[];
  nameNorm: string;
  looseKey: string;
  dob: string | null;
  admin: boolean;
}

const STATE: Record<IdentityReview, LinkState> = {
  ambiguous_patient: "ambiguous", identity_conflict: "conflict", possible_existing_patient: "possible_existing",
};

const FILL_COLUMNS = [
  "phone", "email", "birthdate", "sex", "address", "referred_by_doctor",
  "preferred_release_medium", "senior_pwd_id_kind", "senior_pwd_id_number",
] as const;

/**
 * Oldest registration first; undated rows last; ties broken by source key
 * (never by sheet position), so re-sorting or inserting rows in the sheet
 * never changes which row supplies a value.
 */
function byEarliest(a: CustomerRow, b: CustomerRow): number {
  if (a.registeredOn !== b.registeredOn) {
    if (a.registeredOn === null) return 1;
    if (b.registeredOn === null) return -1;
    return a.registeredOn < b.registeredOn ? -1 : 1;
  }
  return a.sourceKey < b.sourceKey ? -1 : a.sourceKey > b.sourceKey ? 1 : 0;
}

function candidatePayload(index: PatientIndex, ids: readonly string[]) {
  return ids.map((id) => {
    const p = index.byId.get(id)!;
    return { patient_id: p.id, drm_id: p.drm_id, name: [p.last_name, [p.first_name, p.middle_name].filter(Boolean).join(" ")].join(", "), birthdate: p.birthdate };
  });
}

function rowPayload(r: CustomerRow) {
  return { sheet_row: r.sheetRow, name_raw: r.fullNameRaw, dob: r.dob, registered_on: r.registeredOn,
    phone_last4: r.phone10 ? r.phone10.slice(-4) : null, link_key: r.linkKey };
}

function fieldsOf(r: CustomerRow): Required<FillFields> {
  return {
    phone: r.phoneE164, email: r.email, birthdate: r.dob, sex: r.sex, address: r.address,
    referred_by_doctor: r.referredByDoctor, preferred_release_medium: r.releaseMedium,
    senior_pwd_id_kind: r.seniorKind, senior_pwd_id_number: r.seniorNumber, referral_source: r.referralSourceId,
  };
}

/** First non-null value per field across a patient's rows, earliest row first. */
function aggregate(rows: readonly CustomerRow[]): Required<FillFields> {
  const sorted = [...rows].sort(byEarliest);
  const out = fieldsOf(sorted[0]);
  for (const r of sorted.slice(1)) {
    const f = fieldsOf(r);
    for (const k of Object.keys(out) as Array<keyof typeof out>) if (out[k] === null) out[k] = f[k];
  }
  // Channel = the earliest row that ANSWERED (a blank answer is not an answer).
  out.referral_source = sorted.find((r) => r.sourceNorm !== "")?.referralSourceId ?? null;
  return out;
}

/** What the conditional fill would change — mirrors sheet_sync_apply_customer_ops (0170). */
function fillDiff(p: PatientRecord, want: Required<FillFields>): FillFields {
  const diff: FillFields = {};
  for (const c of FILL_COLUMNS) {
    if (c === "senior_pwd_id_kind" || c === "senior_pwd_id_number") continue;
    if (p[c] === null && want[c] !== null) diff[c] = want[c];
  }
  if (p.senior_pwd_id_kind === null && p.senior_pwd_id_number === null && want.senior_pwd_id_kind && want.senior_pwd_id_number) {
    diff.senior_pwd_id_kind = want.senior_pwd_id_kind;
    diff.senior_pwd_id_number = want.senior_pwd_id_number;
  }
  const sheetMayOwn = p.referral_source === null || p.referral_source_origin === "sheet";
  if (sheetMayOwn && p.referral_source !== want.referral_source) diff.referral_source = want.referral_source;
  return diff;
}

// ---------------------------------------------------------------------------
// Conflict test (spec §5.3): both DOBs present and different ⇒ conflict; both
// phones present and different ⇒ conflict unless both DOBs are present and equal.
// ---------------------------------------------------------------------------

interface Facet { dob: string | null; phone: string | null }

const patientFacet = (p: PatientRecord): Facet => ({ dob: p.birthdate, phone: phone10(p.phone) });

function conflictReason(r: CustomerRow, p: Facet): string | null {
  if (r.dob && p.dob && r.dob !== p.dob) return "date of birth differs";
  const phoneDiffers = !!(r.phone10 && p.phone && r.phone10 !== p.phone);
  const dobMatches = !!(r.dob && p.dob && r.dob === p.dob);
  if (phoneDiffers && !dobMatches) return "phone differs and date of birth cannot confirm";
  return null;
}

function groupConflict(rows: readonly CustomerRow[], p: Facet): string | null {
  for (const r of rows) {
    const why = conflictReason(r, p);
    if (why) return why;
  }
  return null;
}

/** Two rows with phones present and different, and no shared DOB to confirm them. */
function phonesConflict(a: readonly CustomerRow[], b: readonly CustomerRow[]): boolean {
  for (const x of a) for (const y of b) {
    if (x.phone10 && y.phone10 && x.phone10 !== y.phone10 && !(x.dob && y.dob && x.dob === y.dob)) return true;
  }
  return false;
}

const surnameTokensOf = (nameNorm: string) => nameNorm.split("|")[0].split(" ").filter(Boolean);
const firstTokenOf = (looseKey: string) => looseKey.split("|")[1] ?? "";

export function planCustomers(input: Input): CustomerPlan {
  const { index, links } = input;
  const review = (kind: IdentityReview, reason: string, candidates: readonly string[] = [], extra?: Record<string, unknown>): Resolution =>
    ({ kind: "review", review: kind, reason, candidates: [...new Set(candidates)], extra });
  const nameReview = (reason: string, candidates: readonly string[]): Resolution =>
    ({ kind: "review", review: "ambiguous_patient", reason, candidates: [...new Set(candidates)], nameOnly: true });

  // ---- Group rows by link key (first-appearance order). ----
  const groups: Group[] = [];
  const groupByKey = new Map<string, Group>();
  for (const r of input.rows) {
    let g = groupByKey.get(r.linkKey);
    if (!g) {
      g = { key: r.linkKey, nameNorm: r.nameNorm, looseKey: r.looseKey, dob: r.dob, rows: [], res: { kind: "create" },
        stored: links.get(r.linkKey), adminCreate: false, collision: false };
      groupByKey.set(r.linkKey, g);
      groups.push(g);
    }
    g.rows.push(r);
  }

  // Deleted-patient identity evidence (review fix E): same two matchers the
  // create-op SQL backstop uses (name+DOB, or name+phone when no DOB) — no
  // new fuzzy logic, just the existing simple rule applied to a second,
  // smaller table. `dob` non-null keys the DOB map; phone10 keys the phone
  // map. Collisions (two deleted patients sharing a key) keep the last one —
  // this is a narrow backstop, not a precise match.
  const deletedByNameDob = new Map<string, string>();
  const deletedByNamePhone = new Map<string, string>();
  for (const dp of input.deletedPatients ?? []) {
    const nn = nameNormOf({ first: dp.first_name, middle: dp.middle_name, last: dp.last_name });
    if (dp.birthdate) deletedByNameDob.set(`${nn}#${dp.birthdate}`, dp.id);
    const ph = phone10(dp.phone);
    if (ph) deletedByNamePhone.set(`${nn}|${ph}`, dp.id);
  }
  /** The deleted patient this group's identity matches, if any. */
  function matchDeletedPatient(g: Group): string | null {
    if (g.dob) return deletedByNameDob.get(`${g.nameNorm}#${g.dob}`) ?? null;
    for (const r of g.rows) {
      if (r.phone10) {
        const hit = deletedByNamePhone.get(`${g.nameNorm}|${r.phone10}`);
        if (hit) return hit;
      }
    }
    return null;
  }

  /**
   * The deleted patient a key's SAVED link points at, if any: the linked
   * patient itself, or — a merged-away patient still resolves to its
   * survivor — the survivor at the end of the merge chain when that survivor
   * was deleted. A live chain end returns null (the survivor() path handles
   * it before this is ever asked).
   */
  const deletedById = new Set((input.deletedPatients ?? []).map((dp) => dp.id));
  function savedLinkDeletedPatient(g: Group): string | null {
    let cur: string | null | undefined = g.stored?.patient_id;
    for (let hop = 0; cur && hop < 11; hop++) {
      if (deletedById.has(cur)) return cur;
      const p = index.byId.get(cur);
      cur = p?.merged_into_id;
    }
    return null;
  }

  // Corroboration sources: rows linked last run that vanished from this snapshot.
  const currentKeys = new Set(input.rows.map((r) => r.sourceKey));
  const vanishedByPhone = new Map<string, string[]>();
  const vanishedByDob = new Map<string, string[]>();
  for (const v of input.prevRows) {
    if (!v.patient_id || currentKeys.has(v.source_key)) continue;
    if (v.phone_norm) vanishedByPhone.set(v.phone_norm, [...(vanishedByPhone.get(v.phone_norm) ?? []), v.patient_id]);
    if (v.dob) vanishedByDob.set(v.dob, [...(vanishedByDob.get(v.dob) ?? []), v.patient_id]);
  }

  /** Spec §5.3 corroboration guard (review I5): evidence that a "new" row is an existing patient. */
  function corroborate(g: Group): string[] {
    const hits = new Set<string>();
    for (const r of g.rows) {
      const surname = surnameTokensOf(r.nameNorm);
      const firstTok = firstTokenOf(r.looseKey);
      const phoneUsable = !!r.phone10 && !index.junkOrShared(r.phone10);
      if (phoneUsable) {
        for (const id of index.byPhone.get(r.phone10!) ?? []) {
          const p = index.byId.get(id)!;
          if (r.dob && p.birthdate && r.dob !== p.birthdate) continue; // a relative sharing the line
          hits.add(id);
        }
        for (const pid of vanishedByPhone.get(r.phone10!) ?? []) {
          const s = index.survivor(pid);
          if (s) hits.add(s);
        }
      }
      if (r.dob) {
        for (const id of index.byDob.get(r.dob) ?? []) {
          const names = index.names.get(id) ?? [];
          if (names.some((n) => n.firstToken === firstTok || (n.lastTokens.length > 0 && isTokenMultisetSuperset(n.lastTokens, surname)))) hits.add(id);
        }
        for (const pid of vanishedByDob.get(r.dob) ?? []) {
          const s = index.survivor(pid);
          if (!s) continue;
          const names = index.names.get(s) ?? [];
          if (names.some((n) => n.tokens.some((t) => r.tokens.includes(t)))) hits.add(s);
        }
      }
    }
    return [...hits];
  }

  /** Rule (d): no usable decision. */
  function resolveFresh(g: Group, staleDecision: boolean): Resolution {
    const full = index.byFullName.get(g.nameNorm) ?? [];
    if (full.length === 1) {
      const why = groupConflict(g.rows, patientFacet(index.byId.get(full[0])!));
      return why ? review("identity_conflict", why, full) : { kind: "linked", patientId: full[0], trusted: false, linkOp: "auto_exact" };
    }
    if (full.length > 1) return nameReview("several patients share this full name", full);
    const loose = index.byLoose.get(g.looseKey) ?? [];
    if (loose.length > 0) return nameReview("similar name (surname + first name) — not linked automatically", loose);
    const hits = corroborate(g);
    if (hits.length > 0) return review("possible_existing_patient", "same phone or date of birth as an existing patient", hits);
    // Review fix E: this row would otherwise become a create, but its
    // identity matches a patient staff deleted — hold it for an admin
    // instead of silently re-creating that person. candidates: [] (not the
    // deleted id) — candidatePayload() looks candidates up in the LIVE
    // index, which a deleted patient is never in; the id travels in `extra`
    // instead, which the SQL create-recheck backstop is the last line of
    // defense against as well.
    //
    // S1 (sync review gaps): this check comes BEFORE the stale-decision
    // return. A key whose SAVED auto link points at a patient staff later
    // deleted used to fall into the generic "no longer exists" hold, which
    // SQL refuses to Dismiss and the UI offers no candidates for — leaving
    // "Create a new patient" as the only way out, i.e. re-creating the very
    // person staff deleted. The saved link's own patient (followed through
    // merges to a deleted survivor) is the strongest evidence, so it wins
    // over the name+DOB / name+phone matcher.
    const deletedMatch = (staleDecision ? savedLinkDeletedPatient(g) : null) ?? matchDeletedPatient(g);
    if (deletedMatch) {
      return review("possible_existing_patient", DELETED_PATIENT_HOLD_REASON, [],
        { held_because: DELETED_PATIENT_HOLD_REASON, deleted_patient_id: deletedMatch });
    }
    // A saved link whose patient is gone for another reason (missing from
    // this read): creating would silently re-make someone staff already
    // removed or linked.
    if (staleDecision) return review("ambiguous_patient", "the previously linked patient no longer exists");
    return { kind: "create" };
  }

  /**
   * Rule 0: a HELD key. Candidates are computed as usual so the admin sees
   * them, and a more specific kind this run computes (a DOB conflict, a
   * possible existing patient) is kept — but the answer is always review.
   * A hold placed by an undo ("undone by an admin") never re-links or
   * re-fills: that is what makes the undo stick.
   */
  function resolveHeld(g: Group): Resolution {
    const fresh = resolveFresh(g, false);
    const why = g.stored?.hold_reason ? { held_because: g.stored.hold_reason } : {};
    // The deleted-patient evidence must survive the hold (Codex recheck on S1):
    // applying the hold clears the link's patient_id, and name/DOB/phone matching
    // cannot always find the deleted record again (the sheet row's DOB was edited,
    // say). The hold op therefore persists the deleted id (held_patient_id, 0193)
    // and this run reads it back. It is honoured only while that patient is STILL
    // deleted: once staff restore it, the ordinary path below runs (a live
    // candidate, a normal Link) — and only when the fresh answer has no live
    // candidates of its own to show.
    const heldDeleted = g.stored?.hold_reason === DELETED_PATIENT_HOLD_REASON && g.stored.held_patient_id
      && deletedById.has(g.stored.held_patient_id) ? g.stored.held_patient_id : null;
    if (heldDeleted && (fresh.kind === "create" || (fresh.kind === "review" && fresh.candidates.length === 0 && !fresh.extra?.deleted_patient_id))) {
      return review("possible_existing_patient", "held for an admin decision", [],
        { held_because: DELETED_PATIENT_HOLD_REASON, deleted_patient_id: heldDeleted });
    }
    if (fresh.kind === "review") return review(fresh.review, "held for an admin decision", fresh.candidates, { detail: fresh.reason, ...fresh.extra, ...why });
    return review("ambiguous_patient", "held for an admin decision", fresh.kind === "linked" ? [fresh.patientId] : [], why);
  }

  // ---- Pass 1: one resolution per key group. ----
  for (const g of groups) {
    const link = g.stored;
    if (link?.decision === "review") { g.res = resolveHeld(g); continue; }
    if (link?.decision === "link" && link.method === "admin") {
      // Trusted without a conflict test, whatever its rows say. On an UNDATED
      // key (`name#`) this deliberately accepts every future undated row of
      // that name too (an admin said "the undated rows with this name are this
      // patient"); a DATED key only ever covers rows carrying that DOB.
      const s = link.patient_id ? index.survivor(link.patient_id) : null;
      // A deleted chosen patient (or a survivor deleted after a merge) gets the
      // same deleted-patient review as an auto link (S1, owner rule: never
      // re-create a deleted person silently). No hold op follows — an admin
      // row is never overwritten by the sync — so Keep deleted is a plain
      // dismiss of the item. A truly missing patient keeps the generic hold.
      const deletedChosen = s ? null : savedLinkDeletedPatient(g);
      g.res = s ? { kind: "linked", patientId: s, trusted: true, linkOp: null }
        : deletedChosen
          ? review("possible_existing_patient", DELETED_PATIENT_HOLD_REASON, [],
            { held_because: DELETED_PATIENT_HOLD_REASON, deleted_patient_id: deletedChosen })
          : review("ambiguous_patient", "the chosen patient no longer exists");
      continue;
    }
    if (link?.decision === "create") { g.res = { kind: "create" }; g.adminCreate = true; continue; }
    if (link?.decision === "link") {
      const s = link.patient_id ? index.survivor(link.patient_id) : null;
      if (s) {
        const why = groupConflict(g.rows, patientFacet(index.byId.get(s)!));
        g.res = why ? review("identity_conflict", why, [s])
          : { kind: "linked", patientId: s, trusted: false, linkOp: s !== link.patient_id ? (link.method === "auto_loose" ? "auto_loose" : "auto_exact") : null };
        continue;
      }
      g.res = resolveFresh(g, true);
      continue;
    }
    g.res = resolveFresh(g, false);
  }

  // ---- Pass 2: per patient, test every auto-linked key against what the
  // patient will hold after this run's fill (so run 2 agrees with run 1, and
  // two different people cannot both be poured into one record). The picture
  // is built in trust order — the patient's own values, then admin-linked
  // rows, then rows whose DOB confirms the patient — and only then are rows
  // WITHOUT a DOB tested against it. So an older undated row can never set
  // the phone a DOB-confirmed row is then judged by (review round 2, C1). ----
  const linkedByPatient = new Map<string, Group[]>();
  for (const g of groups) {
    if (g.res.kind !== "linked") continue;
    linkedByPatient.set(g.res.patientId, [...(linkedByPatient.get(g.res.patientId) ?? []), g]);
  }
  for (const [pid, gs] of linkedByPatient) {
    const p = index.byId.get(pid)!;
    const demote = (g: Group, why: string) => {
      g.res = review("identity_conflict", `${why} (compared with this run's other rows for the patient)`, [pid]);
    };
    const isTrusted = (g: Group) => g.res.kind === "linked" && g.res.trusted;
    const trustedRows = gs.filter(isTrusted).flatMap((g) => g.rows);
    const auto = gs.filter((g) => !isTrusted(g));

    // DOB: the patient's, else the admin-linked rows', else the one DOB every
    // dated auto key agrees on; several and nothing to choose → all to review.
    let willDob = p.birthdate ?? (trustedRows.length > 0 ? aggregate(trustedRows).birthdate : null);
    const dated = auto.filter((g) => g.dob);
    if (willDob) {
      for (const g of dated) if (g.dob !== willDob) demote(g, "date of birth differs from the rows an admin linked to this patient");
    } else {
      const dobs = new Set(dated.map((g) => g.dob));
      if (dobs.size >= 2) for (const g of dated) demote(g, "rows with this name carry different dates of birth and the patient has none");
      else if (dobs.size === 1) willDob = [...dobs][0];
    }

    // Phones every surviving row must agree with when it has no DOB to vouch
    // for it: the patient's, the admin-linked rows', the DOB-confirmed rows'.
    const anchors = new Set<string>();
    const own = phone10(p.phone);
    if (own) anchors.add(own);
    const confirmedRows = dated.filter((g) => g.res.kind === "linked").flatMap((g) => g.rows);
    for (const r of [...trustedRows, ...confirmedRows]) if (r.phone10) anchors.add(r.phone10);
    const undated = auto.filter((g) => !g.dob);
    const kept: Group[] = [];
    for (const g of undated) {
      if (g.rows.some((r) => r.phone10 && [...anchors].some((a) => a !== r.phone10))) {
        demote(g, anchors.size > 1 ? "no date of birth, and the patient's rows already carry more than one phone"
          : "phone differs and date of birth cannot confirm");
      } else kept.push(g);
    }
    if (anchors.size === 0) {
      const phones = new Set(kept.flatMap((g) => g.rows.map((r) => r.phone10).filter(Boolean)));
      if (phones.size >= 2) {
        for (const g of kept) if (g.rows.some((r) => r.phone10)) demote(g, "rows without a date of birth carry different phones and the patient has none");
      }
    }
  }

  // ---- Pass 3: pending creates → new-person clusters. ----
  const byName = new Map<string, Group[]>();
  for (const g of groups) byName.set(g.nameNorm, [...(byName.get(g.nameNorm) ?? []), g]);
  const isPending = (g: Group) => g.res.kind === "create";
  const isAdminCreate = (g: Group) => g.res.kind === "create" && g.adminCreate;

  // A sibling key of the same name is linked to a patient (by a saved decision,
  // since the full-name rule would have found it for every key alike): this
  // "new" person may well be that patient.
  for (const g of groups) {
    if (!isPending(g) || isAdminCreate(g)) continue;
    const linked = new Set<string>();
    for (const s of byName.get(g.nameNorm)!) {
      if (s === g || s.res.kind !== "linked") continue;
      const p = index.byId.get(s.res.patientId)!;
      if (g.dob && p.birthdate && g.dob !== p.birthdate) continue;
      linked.add(p.id);
    }
    if (linked.size > 0) g.res = review("possible_existing_patient", "another row with this name is linked to this patient", [...linked]);
  }

  const clusters: Cluster[] = [];
  const datedClustersByName = new Map<string, Cluster[]>();
  const newCluster = (gs: Group[]): Cluster => {
    const c = { groups: gs, nameNorm: gs[0].nameNorm, looseKey: gs[0].looseKey, dob: gs[0].dob, admin: gs.some(isAdminCreate) };
    clusters.push(c);
    return c;
  };
  for (const g of groups) {
    if (!isPending(g) || !g.dob) continue;
    const c = newCluster([g]);
    datedClustersByName.set(g.nameNorm, [...(datedClustersByName.get(g.nameNorm) ?? []), c]);
  }
  for (const g of groups) {
    if (!isPending(g) || g.dob) continue;
    if (isAdminCreate(g)) { newCluster([g]); continue; }
    const phones = new Set(g.rows.map((r) => r.phone10).filter(Boolean));
    if (phones.size >= 2) {
      g.res = review("ambiguous_patient", "rows under this name have different phone numbers and no date of birth to tell them apart");
      continue;
    }
    const datedSiblings = byName.get(g.nameNorm)!.filter((s) => s.dob);
    const datedClusters = datedClustersByName.get(g.nameNorm) ?? [];
    if (datedSiblings.length === 0) { newCluster([g]); continue; }
    // Joining is allowed into an admin-created person too, but the joined key
    // gets no admin trust: it is linked auto_exact and re-tested every run.
    if (datedSiblings.length === 1 && datedClusters.length === 1 && !phonesConflict(g.rows, datedClusters[0].groups.flatMap((x) => x.rows))) {
      datedClusters[0].groups.push(g);
      continue;
    }
    g.res = review("ambiguous_patient", datedClusters.length > 1 || datedSiblings.length > 1
      ? "several rows share this name with different dates of birth; this row has none"
      : datedClusters.length === 1
        ? "this row has no date of birth and its phone differs from the dated row with this name"
        : "this row has no date of birth and the dated row with this name is under review");
  }

  // Cross-cluster check (review I1): two spellings of one new person in the
  // same batch must not both be created.
  const phonesOf = new Map<Cluster, Set<string>>();
  const namesPerPhone = new Map<string, Set<string>>();
  for (const c of clusters) {
    const set = new Set<string>();
    for (const g of c.groups) for (const r of g.rows) if (r.phone10 && !index.junkOrShared(r.phone10)) set.add(r.phone10);
    phonesOf.set(c, set);
    for (const ph of set) namesPerPhone.set(ph, (namesPerPhone.get(ph) ?? new Set()).add(c.nameNorm));
  }
  // A phone on 3+ different people — new names in this batch plus existing
  // patients already on it (a clinic / agent / family line) — proves nothing.
  // Counting the existing patients keeps the answer the same on the next run,
  // when this batch's new people have become existing patients.
  const batchShared = (ph: string) => (namesPerPhone.get(ph)?.size ?? 0) + (index.byPhone.get(ph)?.length ?? 0) >= 3;
  const collide = (a: Cluster, b: Cluster): boolean => {
    // Different names AND different known DOBs on one phone is a family
    // sharing a line (review round 2, I4) — the phone alone says nothing.
    const family = !!(a.dob && b.dob && a.dob !== b.dob) && a.nameNorm !== b.nameNorm && a.looseKey !== b.looseKey;
    if (!family) for (const ph of phonesOf.get(a)!) if (!batchShared(ph) && phonesOf.get(b)!.has(ph)) return true;
    if (a.nameNorm === b.nameNorm) return false; // different DOBs: legitimately different people
    if (a.looseKey === b.looseKey) return true;
    if (a.dob && a.dob === b.dob) {
      const sa = surnameTokensOf(a.nameNorm), sb = surnameTokensOf(b.nameNorm);
      if (firstTokenOf(a.looseKey) === firstTokenOf(b.looseKey)
        || isTokenMultisetSuperset(sa, sb) || isTokenMultisetSuperset(sb, sa)) return true;
    }
    return false;
  };
  const buckets = new Map<string, Cluster[]>();
  const addTo = (k: string, c: Cluster) => buckets.set(k, [...(buckets.get(k) ?? []), c]);
  for (const c of clusters) {
    addTo(`l:${c.looseKey}`, c);
    if (c.dob) addTo(`d:${c.dob}`, c);
    for (const ph of phonesOf.get(c)!) if (!batchShared(ph)) addTo(`p:${ph}`, c);
  }
  const partners = new Map<Cluster, Set<Cluster>>();
  for (const bucket of buckets.values()) {
    for (let i = 0; i < bucket.length; i++) for (let j = i + 1; j < bucket.length; j++) {
      const a = bucket[i], b = bucket[j];
      if (!collide(a, b)) continue;
      partners.set(a, (partners.get(a) ?? new Set()).add(b));
      partners.set(b, (partners.get(b) ?? new Set()).add(a));
    }
  }
  const creating: Cluster[] = [];
  for (const c of clusters) {
    const others = partners.get(c);
    if (!others) { creating.push(c); continue; }
    const similar = [...others].flatMap((o) => o.groups.flatMap((g) => g.rows.map(rowPayload)))
      .sort((x, y) => (x.link_key < y.link_key ? -1 : x.link_key > y.link_key ? 1 : x.sheet_row - y.sheet_row));
    // An admin "create new" is honoured, but only for the keys the admin
    // decided; a key that merely joined it is held like any other new row.
    for (const g of c.groups) {
      if (g.adminCreate) continue;
      g.res = review("possible_existing_patient", "another new row in this sheet looks like the same person", [], { similar_new_rows: similar });
      g.collision = true;
    }
    if (c.admin) { c.groups = c.groups.filter((g) => g.adminCreate); creating.push(c); }
  }

  // ---- Ops. ----
  const ops: CustomerOp[] = [];
  const createKeyByGroup = new Map<Group, string>();
  for (const c of creating) {
    const rows = c.groups.flatMap((g) => g.rows);
    const sorted = [...rows].sort(byEarliest);
    const first = sorted[0];
    const createKey = first.linkKey; // the earliest row's key: independent of sheet order
    ops.push({
      op: "create", create_key: createKey, method: c.admin ? "admin" : "auto_exact",
      link_keys: c.groups.map((g) => g.key).sort(),
      admin_link_keys: c.groups.filter((g) => g.adminCreate).map((g) => g.key).sort(),
      fields: { first_name: first.first!, last_name: first.last!, middle_name: first.middle, ...aggregate(rows) },
      legacy_intake: { source: "sheet_sync:CUSTOMER LIST2", imported_at: input.importedAtIso ?? null,
        original_row_index: first.sheetRow, raw: first.raw, import_warnings: [] },
      facts: { registered_on: first.registeredOn, new_repeat: sorted.find((r) => r.newRepeat)?.newRepeat ?? null,
        source_ref: `CUSTOMER LIST2 r${first.sheetRow}` },
    });
    for (const g of c.groups) createKeyByGroup.set(g, createKey);
  }

  // Linked: link ops, then per-patient fill + facts diffs.
  const rowsByPatient = new Map<string, CustomerRow[]>();
  for (const g of groups) {
    if (g.res.kind !== "linked") continue;
    rowsByPatient.set(g.res.patientId, [...(rowsByPatient.get(g.res.patientId) ?? []), ...g.rows]);
    const existing = links.get(g.key);
    if (g.res.linkOp && (!existing || existing.patient_id !== g.res.patientId)) {
      ops.push({ op: "link", link_key: g.key, patient_id: g.res.patientId, method: g.res.linkOp,
        expected_row_version: index.byId.get(g.res.patientId)!.row_version });
    }
  }

  // Holds: persist every review the next run might not reproduce by itself.
  // That is any review resting on evidence OUTSIDE the key's own name: a
  // batch collision; a key whose saved AUTO link is now in doubt (the link
  // would otherwise keep speaking for the name in the clinical mirror); and
  // every conflict / possible-existing / sibling review — this run's own
  // writes can weaken that evidence (a create puts a phone on a third patient
  // and it stops counting; a filled DOB turns a match into "a relative"; a
  // vanished row is only seen once), and the next run would then create or
  // link what this run flagged. Pure name ambiguity (several full-name
  // patients, or only a similar name) is re-derived identically every run —
  // names only grow — so it is left unheld and still resolves by itself when
  // staff merge duplicates, unless this run CREATES a patient with that exact
  // name (then the next run would see a clean full-name match). Never over an
  // admin decision, and never re-sent for a key already held.
  const createdNames = new Set(creating.map((c) => c.nameNorm));
  let holds = 0;
  for (const g of groups) {
    if (g.res.kind !== "review") continue;
    const s = g.stored;
    if (s && (s.decision !== "link" || s.method === "admin")) continue;
    const settled = g.res.nameOnly && !createdNames.has(g.nameNorm) && s?.decision !== "link" && !g.collision;
    if (!settled) {
      const deletedId = typeof g.res.extra?.deleted_patient_id === "string" ? g.res.extra.deleted_patient_id : undefined;
      ops.push({ op: "hold", link_key: g.key, reason: g.res.reason, ...(deletedId ? { deleted_patient_id: deletedId } : {}) });
      holds++;
    }
  }

  let fills = 0;
  let factsOps = 0;
  for (const [pid, rows] of rowsByPatient) {
    const p = index.byId.get(pid)!;
    const diff = fillDiff(p, aggregate(rows));
    if (Object.keys(diff).length) { ops.push({ op: "fill", patient_id: pid, fields: diff, expected_row_version: p.row_version }); fills++; }
    const sorted = [...rows].sort(byEarliest);
    const want = { registered_on: sorted[0].registeredOn, new_repeat: sorted.find((r) => r.newRepeat)?.newRepeat ?? null,
      source_ref: `CUSTOMER LIST2 r${sorted[0].sheetRow}` };
    // source_ref is written but not compared (review I4): a row inserted or
    // deleted above would otherwise re-send facts for thousands of patients.
    const have = input.facts.get(pid);
    if (!have || have.registered_on !== want.registered_on || have.sheet_new_repeat !== want.new_repeat) {
      // S2: carries the SAME read version as the patient's link/fill ops. A
      // fill earlier in the batch bumps row_version by one; 0193's facts guard
      // accepts that (and only that) self-inflicted bump, so a stale identity
      // rejects the facts write while a successful fill+facts batch — in one
      // chunk or across two — still writes them.
      ops.push({ op: "facts", patient_id: pid, ...want, expected_row_version: p.row_version }); factsOps++;
    }
  }

  // ---- Review items: one per link key; never overwrite, merge instead. ----
  const reviewByKey = new Map<string, ReviewItemInput>();
  const addReview = (item: ReviewItemInput) => {
    const prev = reviewByKey.get(item.item_key);
    if (!prev) { reviewByKey.set(item.item_key, item); return; }
    const rows = prev.payload.rows as Array<{ sheet_row: number }>;
    for (const r of item.payload.rows as Array<{ sheet_row: number }>) if (!rows.some((x) => x.sheet_row === r.sheet_row)) rows.push(r);
    const cands = prev.payload.candidates as Array<{ patient_id: string }>;
    for (const c of item.payload.candidates as Array<{ patient_id: string }>) if (!cands.some((x) => x.patient_id === c.patient_id)) cands.push(c);
  };
  for (const g of groups) {
    if (g.res.kind !== "review") continue;
    addReview({ kind: g.res.review, item_key: g.key, payload: {
      link_keys: [g.key], rows: g.rows.map(rowPayload), candidates: candidatePayload(index, g.res.candidates),
      reason: g.res.reason, ...g.res.extra } });
  }

  // Unmapped answers: one item per normalised answer.
  const unmapped = new Map<string, { answer: string; rows: number }>();
  for (const r of input.rows) {
    if (!r.unmappedSource) continue;
    const u = unmapped.get(r.sourceNorm);
    if (u) u.rows += r.dupCount; else unmapped.set(r.sourceNorm, { answer: r.sourceNorm, rows: r.dupCount });
  }
  for (const [norm, u] of unmapped) reviewByKey.set(`unmapped:${norm}`, { kind: "unmapped_source", item_key: norm, payload: u });

  const mirror: CustomerMirrorRow[] = input.rows.map((r) => {
    const g = groupByKey.get(r.linkKey)!;
    const res = g.res;
    const createKey = createKeyByGroup.get(g) ?? null;
    return {
      sheet_row: r.sheetRow, source_key: r.sourceKey, dup_count: r.dupCount, full_name_raw: r.fullNameRaw,
      name_norm: r.nameNorm, loose_key: r.looseKey, link_key: r.linkKey, phone_norm: r.phone10, dob: r.dob,
      registered_on: r.registeredOn, source_raw: r.sourceRaw, source_norm: r.sourceNorm,
      referral_source_id: r.referralSourceId, referred_by_raw: r.referredByRaw, new_repeat: r.newRepeat,
      release_medium_raw: r.releaseMediumRaw,
      patient_id: res.kind === "linked" ? res.patientId : null,
      pending_create_key: createKey,
      link_state: res.kind === "linked" || createKey ? "linked" : res.kind === "review" ? STATE[res.review] : "unlinked",
      row_hash: r.rowHash,
    };
  });

  const reviewList = [...reviewByKey.values()];
  const reviewCounts: Record<string, number> = {};
  for (const i of reviewList) reviewCounts[i.kind] = (reviewCounts[i.kind] ?? 0) + 1;
  const linkedExisting = input.rows.filter((r) => groupByKey.get(r.linkKey)!.res.kind === "linked").length;
  return {
    ops, mirror, review: reviewList,
    counts: { rows: input.rows.length, linked_existing: linkedExisting,
      link_new: ops.filter((o) => o.op === "link").length, create: creating.length,
      fill: fills, facts: factsOps, hold: holds, review: reviewCounts },
  };
}
