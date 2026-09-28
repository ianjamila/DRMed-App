/**
 * Test-only model of what sheet_sync_apply_customer_ops (0170) does with a
 * Customers plan, so two-run tests (and the fuzz property test) can replay
 * run 1 and re-plan. It must mirror the SQL contract exactly:
 *
 * - create: SKIPPED (no patient, no link; counted `skipped_existing`,
 *   create_key reported in `skippedCreateKeys` — review fix B) when the op
 *   is NOT an admin create and a patient already matches this op's
 *   normalized name (names.ts nameNormOf) plus its birthdate (both present)
 *   — or, when the op has none, its normalized phone (phone10) — a
 *   concurrent registration since the planner read patients, OR (review fix
 *   E, owner decision 2026-09-25) a patient staff DELETED since. Merged
 *   patients are exempt (a merge redirects to a survivor the live index
 *   already resolves — not "gone"). An ADMIN create is exempt from all of
 *   this (its own decision is never second-guessed). Otherwise inserts the
 *   patient (an unknown referral_source id → null; origin 'sheet' when a
 *   channel is set, row_version 0, deleted_at null). Each link key is
 *   written with method 'admin' when it is in `admin_link_keys`, else
 *   'auto_exact' — an existing row takes that method too (SQL:
 *   `method = excluded.method`) and is re-pointed (decision 'link') only
 *   when it is not a hold and its method is not admin or it was an admin
 *   'create'. Any other existing row makes the SQL raise 22023 and roll the
 *   chunk back; here it THROWS, so a plan that would do it fails the test
 *   instead of being modelled.
 * - link: SKIPPED (0167) when the target patient is missing, deleted or
 *   merged — never link to an inactive record — or (same bucket as that
 *   race, counted `stale`, patient id reported in `stalePatientIds` — review
 *   fix D) the op carries `expected_row_version` and it no longer matches
 *   the target's, same stale read as fill below. Otherwise upsert, never
 *   over an admin row or a hold (skipped).
 * - hold: upsert (patient_id null, decision 'review', method 'auto_exact',
 *   hold_reason = the op reason); an existing non-admin row becomes decision
 *   'review', patient_id null, with that reason.
 * - fill: skipped for a missing, deleted (0167) or merged patient
 *   (`skipped`), or (when the op carries `expected_row_version`, counted
 *   `stale`, reported in `stalePatientIds`) a patient whose row_version has
 *   since moved — staff changed it after the planner read it; coalesce per
 *   column; the senior/PWD pair only when both are blank; referral_source
 *   only when the patient has none or the sheet owns it (unknown id →
 *   null), and the origin follows the patients_referral_origin_guard
 *   trigger.
 * - facts: SKIPPED and counted `stale` (patient id reported in
 *   `stalePatientIds`) when the patient is gone/deleted/merged, or (review
 *   fix D) the op carries `expected_row_version` and it no longer matches —
 *   the same stale-read guard as its sibling link/fill ops, since the
 *   planner plans all three from one read. Otherwise upsert.
 */
import { isReferralSource } from "../../patients/referral-sources";
import { nameNormOf, phone10 } from "../names";
import type { CustomerOp, FactsRecord, LinkRecord, PatientRecord } from "../types";

export interface World {
  patients: PatientRecord[];
  links: Map<string, LinkRecord>;
  facts: Map<string, FactsRecord>;
}

/**
 * `applyOps`'s return: the mutated World plus the SQL-shaped side channel
 * (created id map, skipped create keys, stale patient ids, SQL-named
 * counts) `fake-store.ts` forwards as `sheet_sync_apply_customer_ops`'s
 * response, so run.ts's fix-B/C/D handling is exercised the same way it
 * would be against the real RPC.
 */
export interface ApplyOpsResult extends World {
  /** create_key -> new patient id, for creates that actually happened (skipped ones are absent). */
  created: Record<string, string>;
  /** create_key of every create skipped as a live-or-deleted duplicate (never an admin create). */
  skippedCreateKeys: string[];
  /** Deduped patient ids a link/fill/facts op rejected as `stale`. */
  stalePatientIds: string[];
  /** SQL-named counts: created/linked/filled/facts/held/skipped/stale/skipped_existing. */
  counts: Record<string, number>;
}

export const world = (patients: PatientRecord[], links: LinkRecord[] = []): World =>
  ({ patients, links: new Map(links.map((l) => [l.link_key, l])), facts: new Map() });

const knownSource = (v: string | null | undefined): string | null => (v && isReferralSource(v) ? v : null);

const COALESCE = ["phone", "email", "birthdate", "sex", "address", "referred_by_doctor", "preferred_release_medium"] as const;

export function applyOps(ops: readonly CustomerOp[], w: World): ApplyOpsResult {
  const patients = w.patients.map((p) => ({ ...p }));
  const byId = new Map(patients.map((p) => [p.id, p]));
  const links = new Map(w.links);
  const facts = new Map(w.facts);
  const created: Record<string, string> = {};
  const skippedCreateKeys: string[] = [];
  const stalePatientIdSet = new Set<string>();
  const counts: Record<string, number> = {
    created: 0, linked: 0, filled: 0, facts: 0, held: 0, skipped: 0, stale: 0, skipped_existing: 0,
  };
  for (const o of ops) {
    if (o.op === "create") {
      const f = o.fields;
      // Concurrent-registration guard (Codex P2) + review fix E: mirrors the
      // SQL's inline normalized-name (nameNormOf) equality plus the same
      // birthdate (both present) or, when this op has none, the same
      // normalized phone — against EVERY patient, live or deleted; only a
      // merged one is exempt (a merge redirects to its survivor, which the
      // live index already resolves elsewhere — it is not "gone").
      // Exempt for an ADMIN create (o.method === "admin"): an admin's own
      // decision is never second-guessed by this heuristic.
      const opNorm = nameNormOf({ first: f.first_name, middle: f.middle_name, last: f.last_name });
      const opDob = f.birthdate ?? null;
      const opPhone = phone10(f.phone ?? null);
      const dupe = o.method === "admin" ? undefined : patients.find((p) => {
        if (p.merged_into_id) return false;
        if (nameNormOf({ first: p.first_name, middle: p.middle_name, last: p.last_name }) !== opNorm) return false;
        if (opDob) return p.birthdate === opDob;
        return !!opPhone && phone10(p.phone) === opPhone;
      });
      if (dupe) { skippedCreateKeys.push(o.create_key); counts.skipped_existing++; continue; }
      const id = `new:${o.create_key}`;
      const src = knownSource(f.referral_source);
      const rec: PatientRecord = { id, drm_id: id, first_name: f.first_name, middle_name: f.middle_name, last_name: f.last_name,
        birthdate: f.birthdate ?? null, phone: f.phone ?? null, phone_normalized: null, email: f.email ?? null, sex: f.sex ?? null,
        address: f.address ?? null, referred_by_doctor: f.referred_by_doctor ?? null,
        preferred_release_medium: f.preferred_release_medium ?? null, senior_pwd_id_kind: f.senior_pwd_id_kind ?? null,
        senior_pwd_id_number: f.senior_pwd_id_number ?? null, referral_source: src,
        referral_source_origin: src ? "sheet" : null, merged_into_id: null, deleted_at: null, row_version: 0 };
      patients.push(rec); byId.set(id, rec);
      for (const k of o.link_keys) {
        const ex = links.get(k);
        if (ex && (ex.decision === "review" || (ex.method === "admin" && ex.decision !== "create"))) {
          throw new Error(`create over a ${ex.decision === "review" ? "hold" : "admin decision"} (${k}): 0170 raises 22023`);
        }
        links.set(k, { link_key: k, patient_id: id, decision: "link", method: o.admin_link_keys.includes(k) ? "admin" : "auto_exact", hold_reason: null });
      }
      facts.set(id, { patient_id: id, registered_on: o.facts.registered_on, sheet_new_repeat: o.facts.new_repeat, source_ref: o.facts.source_ref });
      created[o.create_key] = id;
      counts.created++;
    } else if (o.op === "link") {
      const ex = links.get(o.link_key);
      if (ex && (ex.method === "admin" || ex.decision === "review")) { counts.skipped++; continue; }
      const target = byId.get(o.patient_id);
      // 0167: never link to a missing, deleted or merged patient — same
      // "stale read" bucket as a changed row_version below.
      if (!target || target.deleted_at || target.merged_into_id) { counts.stale++; stalePatientIdSet.add(o.patient_id); continue; }
      if (o.expected_row_version !== undefined && target.row_version !== o.expected_row_version) { // stale read
        counts.stale++; stalePatientIdSet.add(o.patient_id); continue;
      }
      links.set(o.link_key, { link_key: o.link_key, patient_id: o.patient_id, decision: "link", method: o.method, hold_reason: null });
      counts.linked++;
    } else if (o.op === "hold") {
      const ex = links.get(o.link_key);
      if (ex && ex.method === "admin") { counts.skipped++; continue; }
      const hold_reason = o.reason ? o.reason.slice(0, 400) : null;
      links.set(o.link_key, ex ? { ...ex, patient_id: null, decision: "review", hold_reason }
        : { link_key: o.link_key, patient_id: null, decision: "review", method: "auto_exact", hold_reason });
      counts.held++;
    } else if (o.op === "fill") {
      const p = byId.get(o.patient_id);
      if (!p || p.deleted_at || p.merged_into_id) { counts.skipped++; continue; }
      if (o.expected_row_version !== undefined && p.row_version !== o.expected_row_version) { // stale read
        counts.stale++; stalePatientIdSet.add(o.patient_id); continue;
      }
      const f = o.fields;
      for (const c of COALESCE) if (p[c] === null && f[c] !== undefined) p[c] = f[c] || null;
      // the pair: only when both are blank on the patient AND both are in the op
      if (p.senior_pwd_id_kind === null && p.senior_pwd_id_number === null && f.senior_pwd_id_kind && f.senior_pwd_id_number) {
        p.senior_pwd_id_kind = f.senior_pwd_id_kind;
        p.senior_pwd_id_number = f.senior_pwd_id_number;
      }
      if ("referral_source" in f && (p.referral_source === null || p.referral_source_origin === "sheet")) {
        const v = knownSource(f.referral_source);
        if (v !== p.referral_source) { p.referral_source = v; p.referral_source_origin = v ? "sheet" : null; }
      }
      counts.filled++;
    } else {
      // facts
      const p = byId.get(o.patient_id);
      if (!p || p.deleted_at || p.merged_into_id) { counts.stale++; stalePatientIdSet.add(o.patient_id); continue; } // 0170 counts it `stale`
      if (o.expected_row_version !== undefined && p.row_version !== o.expected_row_version) { // review fix D: same stale-read guard as link/fill
        counts.stale++; stalePatientIdSet.add(o.patient_id); continue;
      }
      facts.set(o.patient_id, { patient_id: o.patient_id, registered_on: o.registered_on, sheet_new_repeat: o.new_repeat, source_ref: o.source_ref });
      counts.facts++;
    }
  }
  return { patients, links, facts, created, skippedCreateKeys, stalePatientIds: [...stalePatientIdSet], counts };
}
