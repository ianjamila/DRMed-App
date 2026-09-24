import { describe, expect, it } from "vitest";
import { planCustomers } from "./customer-plan";
import { buildPatientIndex } from "./patient-index";
import { parseCustomersTab } from "./tabs/customers";
import type { CustomerOp, FactsRecord, LinkRecord, PatientRecord } from "./types";

const TODAY = "2026-09-24";
import { CUST_HEADER as HEADER } from "./__fixtures__/tab-headers";
type Spec = { name: string; dob?: number | string; phone?: string | number; ts?: number; src?: string; nr?: string; email?: string; addr?: string };
function rowsOf(...specs: Spec[]) {
  const table = [HEADER, ...specs.map((s) => {
    const r: unknown[] = new Array(22).fill("");
    r[4] = s.name; r[6] = s.dob ?? ""; r[10] = s.addr ?? ""; r[12] = s.email ?? ""; r[11] = s.phone ?? ""; r[16] = s.src ?? ""; r[19] = s.nr ?? ""; r[20] = s.ts ?? 46000;
    return r;
  })];
  return parseCustomersTab(table as never, { today: TODAY, aliases: new Map() }).rows;
}
let n = 0;
function patient(over: Partial<PatientRecord>): PatientRecord {
  n++;
  return { id: `p${n}`, drm_id: `DRM-${n}`, first_name: "Juan", middle_name: "Santos", last_name: "Dela Cruz",
    birthdate: "1990-01-01", phone: null, phone_normalized: null, email: null, sex: null, address: null,
    referred_by_doctor: null, preferred_release_medium: null, senior_pwd_id_kind: null, senior_pwd_id_number: null,
    referral_source: null, referral_source_origin: null, merged_into_id: null, ...over };
}
const plan = (rows: ReturnType<typeof rowsOf>, patients: PatientRecord[], extra: Partial<Parameters<typeof planCustomers>[0]> = {}) =>
  planCustomers({ rows, index: buildPatientIndex(patients), links: new Map(), facts: new Map(), prevRows: [], ...extra });

describe("planCustomers — §5.3 identity rules", () => {
  it("auto-links exactly one full-name candidate with no conflict", () => {
    const p = patient({});
    const out = plan(rowsOf({ name: "Dela Cruz, Juan Santos", dob: 32874 }), [p]);
    expect(out.ops).toContainEqual({ op: "link", link_key: "dela cruz|juan santos#1990-01-01", patient_id: p.id, method: "auto_exact" });
    expect(out.mirror[0]).toMatchObject({ patient_id: p.id, link_state: "linked" });
  });
  it("hard DOB conflict → identity_conflict review, no link", () => {
    const out = plan(rowsOf({ name: "Dela Cruz, Juan Santos", dob: 33000 }), [patient({})]);
    expect(out.ops.filter((o) => o.op === "link")).toHaveLength(0);
    expect(out.review[0].kind).toBe("identity_conflict");
  });
  it("different phones are allowed only when the DOB matches", () => {
    const p = patient({ phone: "+639170000000" });
    expect(plan(rowsOf({ name: "Dela Cruz, Juan Santos", dob: 32874, phone: "09171112222" }), [p]).review).toHaveLength(0);
    const q = patient({ birthdate: null, phone: "+639170000000" });
    expect(plan(rowsOf({ name: "Dela Cruz, Juan Santos", phone: "09171112222" }), [q]).review[0].kind).toBe("identity_conflict");
  });
  it("several full-name candidates → ambiguous_patient listing them", () => {
    const a = patient({}); const b = patient({ birthdate: null });
    const out = plan(rowsOf({ name: "Dela Cruz, Juan Santos" }), [a, b]);
    expect(out.review[0].kind).toBe("ambiguous_patient");
    expect((out.review[0].payload.candidates as unknown[]).length).toBe(2);
  });
  it("middle name added in the sheet: no full-name match, loose match → review, never a link or a create", () => {
    const p = patient({ middle_name: null });
    const out = plan(rowsOf({ name: "Dela Cruz, Juan Santos", dob: 32874 }), [p]);
    expect(out.ops.filter((o) => o.op !== "facts")).toHaveLength(0);
    expect(out.review[0].kind).toBe("ambiguous_patient");
  });
  it("surname corrected (no name match) but same phone → possible_existing_patient, not a create", () => {
    const p = patient({ last_name: "Dela Cruzz", phone: "+639171112222" });
    const out = plan(rowsOf({ name: "Dela Cruz, Juan Santos", phone: "09171112222" }), [p]);
    expect(out.ops.some((o) => o.op === "create")).toBe(false);
    expect(out.review[0].kind).toBe("possible_existing_patient");
  });
  it("row linked last run vanished and a new row shares its DOB → possible_existing_patient", () => {
    const p = patient({ last_name: "Delacruz", first_name: "Juan", middle_name: null, birthdate: null });
    const out = plan(rowsOf({ name: "Dela Cruz, Juan Santos", dob: 32874 }), [p], {
      prevRows: [{ source_key: "gone", patient_id: p.id, phone_norm: null, dob: "1990-01-01", link_state: "linked" }] });
    expect(out.review[0].kind).toBe("possible_existing_patient");
  });
  it("creates a patient only with zero full, zero loose and no corroboration", () => {
    const out = plan(rowsOf({ name: "Reyes, Ana Cruz", dob: 32874, src: "FACEBOOK", nr: "NEW" }), []);
    const create = out.ops.find((o) => o.op === "create");
    expect(create).toMatchObject({ op: "create", link_keys: ["reyes|ana cruz#1990-01-01"],
      fields: { first_name: "Ana", last_name: "Reyes", middle_name: "Cruz", birthdate: "1990-01-01", referral_source: "online_facebook" },
      facts: { new_repeat: "new" } });
  });
  it("two sheet rows for the same new person create ONE patient", () => {
    const out = plan(rowsOf({ name: "Reyes, Ana Cruz", dob: 32874, ts: 46000 }, { name: "Reyes, Ana Cruz", ts: 46100 }), []);
    const creates = out.ops.filter((o) => o.op === "create");
    expect(creates).toHaveLength(1);
    expect((creates[0] as { link_keys: string[] }).link_keys.sort()).toEqual(["reyes|ana cruz#", "reyes|ana cruz#1990-01-01"]);
  });
  it("a merged patient's link resolves to its survivor", () => {
    const keep = patient({}); const gone = patient({ merged_into_id: keep.id });
    const links = new Map([["dela cruz|juan santos#1990-01-01", { link_key: "dela cruz|juan santos#1990-01-01", patient_id: gone.id, decision: "link" as const, method: "admin" as const }]]);
    const out = plan(rowsOf({ name: "Dela Cruz, Juan Santos", dob: 32874 }), [keep, gone], { links });
    expect(out.mirror[0].patient_id).toBe(keep.id);
  });
  it("an admin 'create new' decision creates even when a candidate exists", () => {
    const p = patient({});
    const links = new Map([["dela cruz|juan santos#1990-01-01", { link_key: "dela cruz|juan santos#1990-01-01", patient_id: null, decision: "create" as const, method: "admin" as const }]]);
    const out = plan(rowsOf({ name: "Dela Cruz, Juan Santos", dob: 32874 }), [p], { links });
    expect(out.ops.find((o) => o.op === "create")).toMatchObject({ method: "admin" });
  });
  it("fills only blank fields and never touches a staff-owned channel", () => {
    const p = patient({ phone: null, email: "x@example.com", referral_source: "walk_in", referral_source_origin: "staff" });
    const out = plan(rowsOf({ name: "Dela Cruz, Juan Santos", dob: 32874, phone: "09171112222", src: "FACEBOOK" }), [p]);
    const fill = out.ops.find((o) => o.op === "fill");
    expect(fill).toEqual({ op: "fill", patient_id: p.id, fields: { phone: "+639171112222" } });
  });
  it("a sheet-owned channel follows the sheet, including back to blank", () => {
    const p = patient({ referral_source: "online_facebook", referral_source_origin: "sheet" });
    const out = plan(rowsOf({ name: "Dela Cruz, Juan Santos", dob: 32874, src: "" }), [p]);
    expect(out.ops.find((o) => o.op === "fill")).toEqual({ op: "fill", patient_id: p.id, fields: { referral_source: null } });
  });
  it("the earliest dated row supplies a patient's channel and facts", () => {
    const p = patient({});
    const out = plan(rowsOf(
      { name: "Dela Cruz, Juan Santos", dob: 32874, ts: 46100, src: "GOOGLE", nr: "REPEAT" },
      { name: "Dela Cruz, Juan Santos", dob: 32874, ts: 46000, src: "FACEBOOK", nr: "NEW" }), [p]);
    expect(out.ops.find((o) => o.op === "fill")).toMatchObject({ fields: { referral_source: "online_facebook" } });
    expect(out.ops.find((o) => o.op === "facts")).toMatchObject({ registered_on: "2025-12-09", new_repeat: "new" });
  });
  it("sends no op when nothing changed (nightly runs stay small)", () => {
    const p = patient({ referral_source: "online_facebook", referral_source_origin: "sheet", phone: "+639171112222", phone_normalized: "9171112222" });
    const links = new Map([["dela cruz|juan santos#1990-01-01", { link_key: "dela cruz|juan santos#1990-01-01", patient_id: p.id, decision: "link" as const, method: "auto_exact" as const }]]);
    const facts = new Map([[p.id, { patient_id: p.id, registered_on: "2025-12-09", sheet_new_repeat: null, source_ref: "CUSTOMER LIST2 r2" }]]);
    const out = plan(rowsOf({ name: "Dela Cruz, Juan Santos", dob: 32874, phone: "09171112222", src: "FACEBOOK" }), [p], { links, facts });
    expect(out.ops).toEqual([]);
  });
  it("raises one unmapped_source item per answer, with its count", () => {
    const out = plan(rowsOf({ name: "Reyes, Ana", src: "CUSTOMER LIST" }, { name: "Cruz, Ben", src: "customer list" }), []);
    expect(out.review.filter((r) => r.kind === "unmapped_source")).toEqual([
      { kind: "unmapped_source", item_key: "CUSTOMER LIST", payload: { answer: "CUSTOMER LIST", rows: 2 } }]);
  });
});

// ---------------------------------------------------------------------------
// Adversarial-review defects (C1–C3, I1–I5, M1–M5). Two-run tests replay the
// run-1 ops the way sheet_sync_apply_customer_ops (0165) would, then re-plan.
// ---------------------------------------------------------------------------

interface World { patients: PatientRecord[]; links: Map<string, LinkRecord>; facts: Map<string, FactsRecord> }
const world = (patients: PatientRecord[], links: Array<LinkRecord> = []): World =>
  ({ patients, links: new Map(links.map((l) => [l.link_key, l])), facts: new Map() });

/** Applies run-1 ops like the SQL: creates get id `new:<create_key>`; links never overwrite admin rows. */
function applyOps(ops: readonly CustomerOp[], w: World): World {
  const patients = w.patients.map((p) => ({ ...p }));
  const byId = new Map(patients.map((p) => [p.id, p]));
  const links = new Map(w.links);
  const facts = new Map(w.facts);
  for (const o of ops) {
    if (o.op === "create") {
      const id = `new:${o.create_key}`;
      const f = o.fields;
      const rec: PatientRecord = { id, drm_id: id, first_name: f.first_name, middle_name: f.middle_name, last_name: f.last_name,
        birthdate: f.birthdate ?? null, phone: f.phone ?? null, phone_normalized: null, email: f.email ?? null, sex: f.sex ?? null,
        address: f.address ?? null, referred_by_doctor: f.referred_by_doctor ?? null,
        preferred_release_medium: f.preferred_release_medium ?? null, senior_pwd_id_kind: f.senior_pwd_id_kind ?? null,
        senior_pwd_id_number: f.senior_pwd_id_number ?? null, referral_source: f.referral_source ?? null,
        referral_source_origin: f.referral_source ? "sheet" : null, merged_into_id: null };
      patients.push(rec); byId.set(id, rec);
      for (const k of o.link_keys) {
        const ex = links.get(k);
        if (ex && ex.method === "admin" && ex.decision !== "create") continue;
        links.set(k, { link_key: k, patient_id: id, decision: "link", method: ex?.method ?? (o.method === "admin" ? "admin" : "auto_exact") });
      }
      facts.set(id, { patient_id: id, registered_on: o.facts.registered_on, sheet_new_repeat: o.facts.new_repeat, source_ref: o.facts.source_ref });
    } else if (o.op === "link") {
      const ex = links.get(o.link_key);
      if (ex && ex.method === "admin") continue;
      links.set(o.link_key, { link_key: o.link_key, patient_id: o.patient_id, decision: "link", method: o.method });
    } else if (o.op === "fill") {
      const p = byId.get(o.patient_id)!;
      for (const [k, v] of Object.entries(o.fields) as Array<[keyof typeof o.fields, string | null]>) {
        if (k === "referral_source") { p.referral_source = v; p.referral_source_origin = "sheet"; continue; }
        if (p[k] === null) p[k] = v;
      }
    } else {
      facts.set(o.patient_id, { patient_id: o.patient_id, registered_on: o.registered_on, sheet_new_repeat: o.new_repeat, source_ref: o.source_ref });
    }
  }
  return { patients, links, facts };
}
const planIn = (rows: ReturnType<typeof rowsOf>, w: World, extra: Partial<Parameters<typeof planCustomers>[0]> = {}) =>
  planCustomers({ rows, index: buildPatientIndex(w.patients), links: w.links, facts: w.facts, prevRows: [], ...extra });
const opsOf = (out: ReturnType<typeof planCustomers>, op: CustomerOp["op"]) => out.ops.filter((o) => o.op === op);
const reviewFor = (out: ReturnType<typeof planCustomers>, key: string) => out.review.filter((r) => r.item_key === key);

describe("planCustomers — identity per link key (review defects)", () => {
  it("C1: a later row of an already-linked no-DOB key is conflict-tested (run 2 raises review, no fill)", () => {
    const p = patient({ first_name: "Maria", middle_name: null, last_name: "Santos", birthdate: null, phone: "+639171111111" });
    const run1Rows = rowsOf({ name: "Santos, Maria", phone: "09171111111", ts: 46100 });
    const w0 = world([p]);
    const out1 = planIn(run1Rows, w0);
    expect(out1.ops).toContainEqual({ op: "link", link_key: "santos|maria#", patient_id: p.id, method: "auto_exact" });
    const w1 = applyOps(out1.ops, w0);
    const run2Rows = rowsOf({ name: "Santos, Maria", phone: "09171111111", ts: 46100 },
      { name: "Santos, Maria", phone: "09172222222", ts: 46000, email: "other@example.com", addr: "Othertown" });
    const out2 = planIn(run2Rows, w1);
    expect(opsOf(out2, "fill")).toEqual([]);
    expect(reviewFor(out2, "santos|maria#")).toHaveLength(1);
    expect(reviewFor(out2, "santos|maria#")[0]).toMatchObject({ kind: "identity_conflict" });
    expect((reviewFor(out2, "santos|maria#")[0].payload.rows as unknown[]).length).toBe(2);
    expect(out2.mirror.every((m) => m.link_state === "conflict" && m.patient_id === null)).toBe(true);
  });
  it("C1: sibling rows of one no-DOB key get ONE resolution in a single run", () => {
    const p = patient({ first_name: "Maria", middle_name: null, last_name: "Santos", birthdate: null, phone: "+639171111111" });
    const out = plan(rowsOf({ name: "Santos, Maria", phone: "09171111111", ts: 46100 },
      { name: "Santos, Maria", phone: "09172222222", ts: 46000, email: "other@example.com" }), [p]);
    expect(out.ops).toEqual([]);
    expect(out.review.map((r) => r.kind)).toEqual(["identity_conflict"]);
  });
  it("C1: a patient with no phone does not absorb two no-DOB rows that disagree on phone", () => {
    const p = patient({ first_name: "Maria", middle_name: null, last_name: "Santos", birthdate: null });
    const out = plan(rowsOf({ name: "Santos, Maria", phone: "09171111111", ts: 46000 },
      { name: "Santos, Maria", phone: "09172222222", ts: 46100, email: "other@example.com" }), [p]);
    expect(opsOf(out, "fill")).toEqual([]);
    expect(opsOf(out, "link")).toEqual([]);
    expect(out.review.map((r) => r.kind)).toEqual(["identity_conflict"]);
  });
  it("C1: a patient with no DOB does not absorb two rows with different DOBs (both go to review)", () => {
    const p = patient({ birthdate: null });
    const out = plan(rowsOf({ name: "Dela Cruz, Juan Santos", dob: 32874, ts: 46000 },
      { name: "Dela Cruz, Juan Santos", dob: 33000, ts: 46100 }), [p]);
    expect(opsOf(out, "fill")).toEqual([]);
    expect(opsOf(out, "link")).toEqual([]);
    expect(out.review.map((r) => r.kind)).toEqual(["identity_conflict", "identity_conflict"]);
  });
  it("C1: a no-DOB key whose phone disagrees with what the patient will hold after this run's fill → review", () => {
    const p = patient({ phone: null }); // DOB 1990-01-01, no phone yet
    const rows = rowsOf({ name: "Dela Cruz, Juan Santos", dob: 32874, phone: "09171111111", ts: 46000 },
      { name: "Dela Cruz, Juan Santos", phone: "09172222222", ts: 46100, email: "other@example.com" });
    const w0 = world([p]);
    const out1 = planIn(rows, w0);
    expect(reviewFor(out1, "dela cruz|juan santos#")[0]).toMatchObject({ kind: "identity_conflict" });
    expect(opsOf(out1, "fill")).toEqual([{ op: "fill", patient_id: p.id, fields: { phone: "+639171111111" } }]);
    // Stable: run 2 reaches the same answer and writes nothing new.
    const out2 = planIn(rows, applyOps(out1.ops, w0));
    expect(opsOf(out2, "fill")).toEqual([]);
    expect(reviewFor(out2, "dela cruz|juan santos#")[0]).toMatchObject({ kind: "identity_conflict" });
  });
  it("C2: an undated row with a different phone never joins a dated new patient", () => {
    const out = plan(rowsOf({ name: "Garcia, Jose", dob: 32874, phone: "09170000001", ts: 46000 },
      { name: "Garcia, Jose", phone: "09179999999", ts: 46100, email: "b@example.com" }), []);
    const creates = opsOf(out, "create") as Array<Extract<CustomerOp, { op: "create" }>>;
    expect(creates).toHaveLength(1);
    expect(creates[0].link_keys).toEqual(["garcia|jose#1990-01-01"]);
    expect(creates[0].fields.email).toBeNull();
    expect(reviewFor(out, "garcia|jose#")[0]).toMatchObject({ kind: "ambiguous_patient", payload: { candidates: [] } });
  });
  it("C2: an undated row joins the single dated new patient when phones agree", () => {
    const out = plan(rowsOf({ name: "Garcia, Jose", dob: 32874, phone: "09170000001", ts: 46000 },
      { name: "Garcia, Jose", phone: "09170000001", ts: 46100, email: "b@example.com" }), []);
    const creates = opsOf(out, "create") as Array<Extract<CustomerOp, { op: "create" }>>;
    expect(creates).toHaveLength(1);
    expect(creates[0].link_keys.sort()).toEqual(["garcia|jose#", "garcia|jose#1990-01-01"]);
    expect(creates[0].fields.email).toBe("b@example.com");
  });
  it("C2: two undated rows of one new name with different phones → review, not one merged patient", () => {
    const out = plan(rowsOf({ name: "Garcia, Jose", phone: "09170000001", ts: 46000 },
      { name: "Garcia, Jose", phone: "09179999999", ts: 46100 }), []);
    expect(opsOf(out, "create")).toEqual([]);
    expect(out.review.map((r) => r.kind)).toEqual(["ambiguous_patient"]);
  });
  it("C3: a sheet row spelled like a merged-away patient links to the survivor (no duplicate)", () => {
    const keep = patient({ first_name: "Juan", middle_name: null, last_name: "Delacruz", birthdate: "1990-01-01" });
    const gone = patient({ first_name: "Juan", middle_name: null, last_name: "Dela Cruz", birthdate: null, merged_into_id: keep.id });
    const out = plan(rowsOf({ name: "Dela Cruz, Juan", ts: 46000 }), [keep, gone]);
    expect(opsOf(out, "create")).toEqual([]);
    expect(out.ops).toContainEqual({ op: "link", link_key: "dela cruz|juan#", patient_id: keep.id, method: "auto_exact" });
  });
  it("C3: a merged patient's phone still corroborates to the survivor", () => {
    const keep = patient({ first_name: "Pedro", middle_name: null, last_name: "Ramos", birthdate: null });
    const gone = patient({ first_name: "Pedro", middle_name: null, last_name: "Ramoss", birthdate: null, phone: "+639175551234", merged_into_id: keep.id });
    const out = plan(rowsOf({ name: "Ramirez, Pete", phone: "09175551234" }), [keep, gone]);
    expect(opsOf(out, "create")).toEqual([]);
    expect(out.review[0]).toMatchObject({ kind: "possible_existing_patient" });
    expect((out.review[0].payload.candidates as Array<{ patient_id: string }>).map((c) => c.patient_id)).toEqual([keep.id]);
  });
  it("I1: two spellings of one NEW person in a batch are not both created", () => {
    const out = plan(rowsOf({ name: "Reyes, Ana Cruz", dob: 32874, phone: "09175550000", ts: 46000 },
      { name: "Reyes, Ana", dob: 32874, phone: "09175550000", ts: 46100 }), []);
    expect(opsOf(out, "create")).toEqual([]);
    expect(out.review.map((r) => r.kind).sort()).toEqual(["possible_existing_patient", "possible_existing_patient"]);
    const item = reviewFor(out, "reyes|ana#1990-01-01")[0];
    expect(item.payload.candidates).toEqual([]);
    expect((item.payload.similar_new_rows as Array<{ link_key: string }>).map((r) => r.link_key)).toEqual(["reyes|ana cruz#1990-01-01"]);
  });
  it("I1: new names that differ only by loose key collide even without phone or DOB", () => {
    const out = plan(rowsOf({ name: "Reyes, Ana Cruz", ts: 46000 }, { name: "Reyes, Ana", ts: 46100 }), []);
    expect(opsOf(out, "create")).toEqual([]);
  });
  it("I1: same new name with different DOBs is two people (two creates) unless they share a phone", () => {
    const two = plan(rowsOf({ name: "Tan, Leo", dob: 32874, ts: 46000 }, { name: "Tan, Leo", dob: 33000, ts: 46100 }), []);
    expect(opsOf(two, "create")).toHaveLength(2);
    const shared = plan(rowsOf({ name: "Tan, Leo", dob: 32874, phone: "09171234567", ts: 46000 },
      { name: "Tan, Leo", dob: 33000, phone: "09171234567", ts: 46100 }), []);
    expect(opsOf(shared, "create")).toEqual([]);
    expect(shared.review.map((r) => r.kind)).toEqual(["possible_existing_patient", "possible_existing_patient"]);
  });
  it("I1: two-run — a created patient is found on run 2 and nothing new is created", () => {
    const rows = rowsOf({ name: "Reyes, Ana Cruz", dob: 32874, phone: "09175550000", ts: 46000, src: "FACEBOOK" },
      { name: "Reyes, Ana Cruz", phone: "09175550000", ts: 46100 });
    const w0 = world([]);
    const out1 = planIn(rows, w0);
    expect(opsOf(out1, "create")).toHaveLength(1);
    const out2 = planIn(rowsOf({ name: "Reyes, Ana Cruz", dob: 32874, phone: "09175550000", ts: 46000, src: "FACEBOOK" },
      { name: "Reyes, Ana Cruz", phone: "09175550000", ts: 46100 }, { name: "Reyes, Ana Cruz", ts: 46200 }), applyOps(out1.ops, w0));
    expect(opsOf(out2, "create")).toEqual([]);
    expect(out2.review).toEqual([]);
    expect(out2.mirror.every((m) => m.patient_id === "new:reyes|ana cruz#1990-01-01")).toBe(true);
  });
  it("I2: rows of one link key never split into review + create", () => {
    const other = patient({ first_name: "Other", middle_name: null, last_name: "Person", birthdate: null, phone: "+639173334444" });
    const out = plan(rowsOf({ name: "Lim, Carla", phone: "09173334444", ts: 46000 }, { name: "Lim, Carla", ts: 46100 }), [other]);
    expect(opsOf(out, "create")).toEqual([]);
    expect(out.review).toHaveLength(1);
    expect(out.review[0]).toMatchObject({ kind: "possible_existing_patient", item_key: "lim|carla#" });
    expect((out.review[0].payload.rows as unknown[]).length).toBe(2);
    expect(out.mirror.map((m) => m.link_state)).toEqual(["possible_existing", "possible_existing"]);
  });
  it("I4: facts are not re-sent when only the sheet row number shifted", () => {
    const p = patient({});
    const w0 = world([p]);
    const out1 = planIn(rowsOf({ name: "Dela Cruz, Juan Santos", dob: 32874, nr: "NEW" }), w0);
    expect(opsOf(out1, "facts")).toHaveLength(1);
    const w1 = applyOps(out1.ops, w0);
    const shifted = rowsOf({ name: "Someone, Else", dob: 33000 }, { name: "Dela Cruz, Juan Santos", dob: 32874, nr: "NEW" })
      .filter((r) => r.nameNorm.startsWith("dela cruz"));
    expect(shifted[0].sheetRow).toBe(3);
    const out2 = planIn(shifted, w1);
    expect(out2.ops).toEqual([]);
  });
  it("I4: facts ARE re-sent when registered_on or new/repeat changes", () => {
    const p = patient({});
    const facts = new Map([[p.id, { patient_id: p.id, registered_on: "2025-12-09", sheet_new_repeat: null, source_ref: "CUSTOMER LIST2 r9" }]]);
    const out = plan(rowsOf({ name: "Dela Cruz, Juan Santos", dob: 32874, nr: "REPEAT" }), [p], { facts });
    expect(opsOf(out, "facts")).toEqual([{ op: "facts", patient_id: p.id, registered_on: "2025-12-09", new_repeat: "repeat", source_ref: "CUSTOMER LIST2 r2" }]);
  });
  it("I5: a family member's phone is not corroboration when both DOBs are known and differ", () => {
    const mom = patient({ first_name: "Rosa", middle_name: null, last_name: "Bautista", birthdate: "1970-01-01", phone: "+639178887777" });
    const out = plan(rowsOf({ name: "Villanueva, Paolo", dob: 40000, phone: "09178887777" }), [mom]);
    expect(opsOf(out, "create")).toHaveLength(1);
    expect(out.review).toEqual([]);
  });
  it("I5: a phone shared by three or more patients (clinic / family line) is not corroboration", () => {
    const shared = ["Alpha", "Bravo", "Charlie"].map((f) => patient({ first_name: f, middle_name: null, last_name: "Mendoza", birthdate: null, phone: "+639170001111" }));
    const out = plan(rowsOf({ name: "Navarro, Liza", phone: "09170001111" }), shared);
    expect(opsOf(out, "create")).toHaveLength(1);
  });
  it("I5: an all-same-digit phone is junk and never corroborates", () => {
    const p = patient({ first_name: "Alpha", middle_name: null, last_name: "Mendoza", birthdate: null, phone: "0000000000" });
    const out = plan(rowsOf({ name: "Navarro, Liza", phone: "0000000000" }), [p]);
    expect(opsOf(out, "create")).toHaveLength(1);
    expect(buildPatientIndex([p]).junkOrShared("0000000000")).toBe(true);
  });
  it("I5: the row's surname matched against a patient's MIDDLE name is not corroboration", () => {
    const p = patient({ first_name: "Maria", middle_name: "Reyes", last_name: "Cruz", birthdate: "1990-01-01" });
    const out = plan(rowsOf({ name: "Reyes, Ana", dob: 32874 }), [p]);
    expect(opsOf(out, "create")).toHaveLength(1);
  });
  it("I5: DOB + same last name still corroborates (a corrected first name)", () => {
    const p = patient({ first_name: "Maria", middle_name: null, last_name: "Reyes", birthdate: "1990-01-01" });
    const out = plan(rowsOf({ name: "Reyes, Mariah", dob: 32874 }), [p]);
    expect(opsOf(out, "create")).toEqual([]);
    expect(out.review[0].kind).toBe("possible_existing_patient");
  });
  it("I5: a vanished row sharing only a DOB with an unrelated new name is not corroboration", () => {
    const p = patient({ first_name: "Zed", last_name: "Alpha", middle_name: null });
    const out = plan(rowsOf({ name: "Omega, Kai", dob: 32874 }), [p], {
      prevRows: [{ source_key: "old", patient_id: p.id, phone_norm: null, dob: "1990-01-01", link_state: "linked" }] });
    expect(opsOf(out, "create")).toHaveLength(1);
  });
  it("M1: an admin link to a patient no longer in the index → review, never a create", () => {
    const links = new Map([["tan|leo#", { link_key: "tan|leo#", patient_id: "gone-id", decision: "link" as const, method: "admin" as const }]]);
    const out = plan(rowsOf({ name: "Tan, Leo" }), [], { links });
    expect(opsOf(out, "create")).toEqual([]);
    expect(out.review[0]).toMatchObject({ kind: "ambiguous_patient", item_key: "tan|leo#", payload: { reason: "the chosen patient no longer exists" } });
  });
  it("M1: a stale AUTO link with no other candidate also goes to review instead of creating", () => {
    const links = new Map([["tan|leo#", { link_key: "tan|leo#", patient_id: "gone-id", decision: "link" as const, method: "auto_exact" as const }]]);
    const out = plan(rowsOf({ name: "Tan, Leo" }), [], { links });
    expect(opsOf(out, "create")).toEqual([]);
    expect(out.review[0].kind).toBe("ambiguous_patient");
  });
  it("M1: a stale AUTO link falls through to a live full-name match", () => {
    const p = patient({ first_name: "Leo", middle_name: null, last_name: "Tan", birthdate: null });
    const links = new Map([["tan|leo#", { link_key: "tan|leo#", patient_id: "gone-id", decision: "link" as const, method: "auto_exact" as const }]]);
    const out = plan(rowsOf({ name: "Tan, Leo" }), [p], { links });
    expect(out.ops).toContainEqual({ op: "link", link_key: "tan|leo#", patient_id: p.id, method: "auto_exact" });
  });
  it("M2: an admin 'create' on an undated key is honoured even when the name has two DOBs", () => {
    const links = new Map([["uy|kim#", { link_key: "uy|kim#", patient_id: null, decision: "create" as const, method: "admin" as const }]]);
    const out = plan(rowsOf({ name: "Uy, Kim", dob: 32874 }, { name: "Uy, Kim", dob: 33000 }, { name: "Uy, Kim" }), [], { links });
    const creates = opsOf(out, "create") as Array<Extract<CustomerOp, { op: "create" }>>;
    expect(creates.map((c) => c.link_keys.join(",")).sort()).toEqual(["uy|kim#", "uy|kim#1990-01-01", "uy|kim#1990-05-07"]);
    expect(creates.find((c) => c.link_keys[0] === "uy|kim#")!.method).toBe("admin");
    expect(out.review).toEqual([]);
  });
  it("M2: an admin link skips the conflict test", () => {
    const p = patient({ birthdate: "1985-05-05" });
    const links = new Map([["dela cruz|juan santos#1990-01-01", { link_key: "dela cruz|juan santos#1990-01-01", patient_id: p.id, decision: "link" as const, method: "admin" as const }]]);
    const out = plan(rowsOf({ name: "Dela Cruz, Juan Santos", dob: 32874 }), [p], { links });
    expect(out.review).toEqual([]);
    expect(out.mirror[0]).toMatchObject({ patient_id: p.id, link_state: "linked" });
  });
  it("M2: an AUTO link whose rows now conflict goes to review (decision is not blindly trusted)", () => {
    const p = patient({ birthdate: "1985-05-05" });
    const links = new Map([["dela cruz|juan santos#1990-01-01", { link_key: "dela cruz|juan santos#1990-01-01", patient_id: p.id, decision: "link" as const, method: "auto_exact" as const }]]);
    const out = plan(rowsOf({ name: "Dela Cruz, Juan Santos", dob: 32874 }), [p], { links });
    expect(out.ops).toEqual([]);
    expect(out.review[0].kind).toBe("identity_conflict");
  });
  it("M3: the patient's phone is read from phone, not a stale phone_normalized", () => {
    const p = patient({ birthdate: null, phone: "+639170000000", phone_normalized: null });
    const out = plan(rowsOf({ name: "Dela Cruz, Juan Santos", phone: "09171112222" }), [p]);
    expect(out.review[0].kind).toBe("identity_conflict");
    const junk = patient({ birthdate: null, phone: "0917 000 0000 / 0918 111 2222", phone_normalized: "9181112222" });
    expect(buildPatientIndex([junk]).byPhone.size).toBe(0);
  });
  it("extra: a new key whose same-name sibling is admin-linked to a patient is not created", () => {
    const p = patient({ first_name: "Anne", middle_name: null, last_name: "Li", birthdate: null });
    const links = new Map([["lee|ann#", { link_key: "lee|ann#", patient_id: p.id, decision: "link" as const, method: "admin" as const }]]);
    const out = plan(rowsOf({ name: "Lee, Ann", ts: 46000 }, { name: "Lee, Ann", dob: 32874, ts: 46100 }), [p], { links });
    expect(opsOf(out, "create")).toEqual([]);
    expect(reviewFor(out, "lee|ann#1990-01-01")[0]).toMatchObject({ kind: "possible_existing_patient" });
    expect((reviewFor(out, "lee|ann#1990-01-01")[0].payload.candidates as Array<{ patient_id: string }>)[0].patient_id).toBe(p.id);
  });
  it("extra: an undated new row whose dated same-name row is under review is not created", () => {
    const other = patient({ first_name: "Other", middle_name: null, last_name: "Person", birthdate: null, phone: "+639173334444" });
    const out = plan(rowsOf({ name: "Lee, Ann", dob: 32874, phone: "09173334444", ts: 46000 }, { name: "Lee, Ann", ts: 46100 }), [other]);
    expect(opsOf(out, "create")).toEqual([]);
    expect(reviewFor(out, "lee|ann#")[0]).toMatchObject({ kind: "ambiguous_patient" });
  });
  it("extra: a phone typed on three different new names (a family / clinic line) does not block their creates", () => {
    const out = plan(rowsOf({ name: "Aquino, Bea", dob: 32874, phone: "09176660000" }, { name: "Bernal, Carlo", dob: 33000, phone: "09176660000" },
      { name: "Castro, Dina", dob: 40000, phone: "09176660000" }), []);
    expect(opsOf(out, "create")).toHaveLength(3);
  });
  it("extra: an auto link to a merged-away patient is re-pointed at the survivor", () => {
    const keep = patient({}); const gone = patient({ merged_into_id: keep.id });
    const links = new Map([["dela cruz|juan santos#1990-01-01", { link_key: "dela cruz|juan santos#1990-01-01", patient_id: gone.id, decision: "link" as const, method: "auto_exact" as const }]]);
    const out = plan(rowsOf({ name: "Dela Cruz, Juan Santos", dob: 32874 }), [keep, gone], { links });
    expect(out.ops).toContainEqual({ op: "link", link_key: "dela cruz|juan santos#1990-01-01", patient_id: keep.id, method: "auto_exact" });
  });
  it("extra: an admin-linked key is never demoted, but an auto key disagreeing with it is", () => {
    const p = patient({ birthdate: null });
    const links = new Map([["dela cruz|juan santos#1990-01-01", { link_key: "dela cruz|juan santos#1990-01-01", patient_id: p.id, decision: "link" as const, method: "admin" as const }]]);
    const out = plan(rowsOf({ name: "Dela Cruz, Juan Santos", dob: 32874, ts: 46000 }, { name: "Dela Cruz, Juan Santos", dob: 33000, ts: 46100 }), [p], { links });
    expect(out.mirror.map((m) => m.link_state)).toEqual(["linked", "conflict"]);
    expect(opsOf(out, "fill")).toEqual([{ op: "fill", patient_id: p.id, fields: { birthdate: "1990-01-01" } }]);
  });
});
