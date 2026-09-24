/**
 * Test-only model of what sheet_sync_apply_customer_ops (0170) does with a
 * Customers plan, so two-run tests (and the fuzz property test) can replay
 * run 1 and re-plan. It must mirror the SQL contract exactly:
 *
 * - create: inserts the patient (an unknown referral_source id → null; origin
 *   'sheet' when a channel is set). Each link key is inserted with method
 *   'admin' when it is in `admin_link_keys`, else 'auto_exact'; an existing
 *   row is re-pointed (decision 'link', method kept) only when its method is
 *   not admin or it was an admin 'create'.
 * - link: upsert, never over an admin row.
 * - hold: upsert (patient_id null, decision 'review', method 'auto_exact');
 *   an existing non-admin row becomes decision 'review', patient_id null.
 * - fill: skipped for a missing or merged patient; coalesce per column; the
 *   senior/PWD pair only when both are blank; referral_source only when the
 *   patient has none or the sheet owns it (unknown id → null), and the
 *   origin follows the patients_referral_origin_guard trigger.
 * - facts: upsert.
 */
import { isReferralSource } from "../../patients/referral-sources";
import type { CustomerOp, FactsRecord, LinkRecord, PatientRecord } from "../types";

export interface World {
  patients: PatientRecord[];
  links: Map<string, LinkRecord>;
  facts: Map<string, FactsRecord>;
}

export const world = (patients: PatientRecord[], links: LinkRecord[] = []): World =>
  ({ patients, links: new Map(links.map((l) => [l.link_key, l])), facts: new Map() });

const knownSource = (v: string | null | undefined): string | null => (v && isReferralSource(v) ? v : null);

const COALESCE = ["phone", "email", "birthdate", "sex", "address", "referred_by_doctor", "preferred_release_medium"] as const;

export function applyOps(ops: readonly CustomerOp[], w: World): World {
  const patients = w.patients.map((p) => ({ ...p }));
  const byId = new Map(patients.map((p) => [p.id, p]));
  const links = new Map(w.links);
  const facts = new Map(w.facts);
  for (const o of ops) {
    if (o.op === "create") {
      const id = `new:${o.create_key}`;
      const f = o.fields;
      const src = knownSource(f.referral_source);
      const rec: PatientRecord = { id, drm_id: id, first_name: f.first_name, middle_name: f.middle_name, last_name: f.last_name,
        birthdate: f.birthdate ?? null, phone: f.phone ?? null, phone_normalized: null, email: f.email ?? null, sex: f.sex ?? null,
        address: f.address ?? null, referred_by_doctor: f.referred_by_doctor ?? null,
        preferred_release_medium: f.preferred_release_medium ?? null, senior_pwd_id_kind: f.senior_pwd_id_kind ?? null,
        senior_pwd_id_number: f.senior_pwd_id_number ?? null, referral_source: src,
        referral_source_origin: src ? "sheet" : null, merged_into_id: null };
      patients.push(rec); byId.set(id, rec);
      for (const k of o.link_keys) {
        const ex = links.get(k);
        if (ex) {
          if (ex.method === "admin" && ex.decision !== "create") continue;
          links.set(k, { ...ex, patient_id: id, decision: "link" });
        } else {
          links.set(k, { link_key: k, patient_id: id, decision: "link", method: o.admin_link_keys.includes(k) ? "admin" : "auto_exact" });
        }
      }
      facts.set(id, { patient_id: id, registered_on: o.facts.registered_on, sheet_new_repeat: o.facts.new_repeat, source_ref: o.facts.source_ref });
    } else if (o.op === "link") {
      const ex = links.get(o.link_key);
      if (ex && ex.method === "admin") continue;
      links.set(o.link_key, { link_key: o.link_key, patient_id: o.patient_id, decision: "link", method: o.method });
    } else if (o.op === "hold") {
      const ex = links.get(o.link_key);
      if (ex && ex.method === "admin") continue;
      links.set(o.link_key, ex ? { ...ex, patient_id: null, decision: "review" }
        : { link_key: o.link_key, patient_id: null, decision: "review", method: "auto_exact" });
    } else if (o.op === "fill") {
      const p = byId.get(o.patient_id);
      if (!p || p.merged_into_id) continue;
      const f = o.fields;
      for (const c of COALESCE) if (p[c] === null && f[c] !== undefined) p[c] = f[c] || null;
      if (p.senior_pwd_id_kind === null && p.senior_pwd_id_number === null) {
        p.senior_pwd_id_kind = f.senior_pwd_id_kind || null;
        p.senior_pwd_id_number = f.senior_pwd_id_number || null;
      }
      if ("referral_source" in f && (p.referral_source === null || p.referral_source_origin === "sheet")) {
        const v = knownSource(f.referral_source);
        if (v !== p.referral_source) { p.referral_source = v; p.referral_source_origin = v ? "sheet" : null; }
      }
    } else {
      facts.set(o.patient_id, { patient_id: o.patient_id, registered_on: o.registered_on, sheet_new_repeat: o.new_repeat, source_ref: o.source_ref });
    }
  }
  return { patients, links, facts };
}
