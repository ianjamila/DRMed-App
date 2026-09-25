/**
 * Random-world generator and property checks for customer-plan.fuzz.test.ts
 * (review round 2). `checkCase` returns the list of violated properties
 * instead of throwing, so the test can print them and a scratch script can
 * survey many seeds at once. Names are invented.
 */
import { planCustomers } from "../customer-plan";
import { buildPatientIndex } from "../patient-index";
import { phone10 } from "../names";
import { parseCustomersTab } from "../tabs/customers";
import { CUST_HEADER } from "./tab-headers";
import { applyOps, type World } from "./customer-world";
import type { Cell, CustomerOp, CustomerPlan, CustomerRow, FillFields, LinkRecord, PatientRecord, PrevCustomerRow } from "../types";

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SUR = ["Reyes", "Cruz", "Dela Cruz", "Santos"];
const FIRST = ["Ana", "Juan", "Ana Marie"];
const MID: Array<string | null> = [null, "Lopez", "Cruz"];
const DOBS: Array<number | null> = [null, 32874, 33000, 40000];
const PHONES: Array<string | null> = [null, "09171111111", "09172222222", "09173333333", "0639171111111"];
const PDOB: Array<string | null> = [null, "1990-01-01", "1990-05-07", "2009-07-06"];
const PPH: Array<string | null> = [null, "+639171111111", "+639172222222", "+639174444444"];
const SRC = ["", "FACEBOOK", "GOOGLE", "WALK IN"];
const CHANNELS: Array<[string | null, PatientRecord["referral_source_origin"]]> = [
  [null, null], ["walk_in", "staff"], ["online_facebook", "sheet"]];

/** `prev`: last run's mirror rows as the runner passes them (here: rows that since vanished). */
export interface Case { table: Cell[][]; w0: World; prev: PrevCustomerRow[] }

export function makeCase(rnd: () => number, size: { rows: number; patients: number } = { rows: 6, patients: 3 }): Case {
  const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
  const table: Cell[][] = [CUST_HEADER];
  const nrows = 1 + Math.floor(rnd() * size.rows);
  for (let i = 0; i < nrows; i++) {
    const r: Cell[] = new Array(22).fill("");
    const m = pick(MID);
    r[4] = `${pick(SUR)}, ${pick(FIRST)}${m ? ` ${m}` : ""}`;
    r[6] = pick(DOBS) ?? "";
    r[11] = pick(PHONES) ?? "";
    r[12] = rnd() < 0.5 ? `e${i}@example.com` : "";
    r[10] = rnd() < 0.5 ? `Town${i}` : "";
    r[16] = pick(SRC);
    r[19] = rnd() < 0.3 ? "NEW" : "";
    // Few distinct days, so same-day ties (and their tie-break) are common.
    r[20] = rnd() < 0.1 ? "" : 45700 + Math.floor(rnd() * 20);
    table.push(r);
  }
  const patients: PatientRecord[] = [];
  const np = Math.floor(rnd() * (size.patients + 1));
  for (let i = 0; i < np; i++) {
    const [src, origin] = pick(CHANNELS);
    patients.push({ id: `P${i}`, drm_id: `DRM-${i}`, first_name: pick(FIRST), middle_name: pick(MID), last_name: pick(SUR),
      birthdate: pick(PDOB), phone: pick(PPH), phone_normalized: null, email: rnd() < 0.2 ? `own${i}@example.com` : null,
      sex: null, address: null, referred_by_doctor: null, preferred_release_medium: null, senior_pwd_id_kind: null,
      senior_pwd_id_number: null, referral_source: src, referral_source_origin: origin,
      merged_into_id: i > 0 && rnd() < 0.2 ? `P${i - 1}` : null });
  }
  const links = new Map<string, LinkRecord>();
  if (rnd() < 0.35) {
    const keys = parse(table).map((r) => r.linkKey);
    const n = 1 + Math.floor(rnd() * 2);
    for (let i = 0; i < n; i++) {
      const k = pick(keys);
      const target = patients.length ? pick(patients).id : null;
      const kind = Math.floor(rnd() * 4);
      if (kind === 0 && target) links.set(k, { link_key: k, patient_id: target, decision: "link", method: "admin" });
      else if (kind === 1) links.set(k, { link_key: k, patient_id: null, decision: "create", method: "admin" });
      else if (kind === 2 && target) links.set(k, { link_key: k, patient_id: target, decision: "link", method: "auto_exact" });
      else links.set(k, { link_key: k, patient_id: null, decision: "review", method: "auto_exact" });
    }
  }
  const prev: PrevCustomerRow[] = [];
  if (patients.length && rnd() < 0.25) {
    prev.push({ source_key: `vanished-${Math.floor(rnd() * 1e6)}`, patient_id: pick(patients).id,
      phone_norm: phone10(pick(PHONES)), dob: pick(PDOB), link_state: "linked" });
  }
  return { table, w0: { patients, links, facts: new Map() }, prev };
}

export function parse(table: Cell[][]): CustomerRow[] {
  return parseCustomersTab(table, { today: "2026-09-24", aliases: new Map() }).rows;
}
const plan = (rows: readonly CustomerRow[], w: World, prevRows: readonly PrevCustomerRow[]): CustomerPlan =>
  planCustomers({ rows, index: buildPatientIndex(w.patients), links: w.links, facts: w.facts, prevRows });

/** What the runner stores as this run's mirror and passes as next run's prevRows. */
const mirrorAsPrev = (out: CustomerPlan): PrevCustomerRow[] => out.mirror.map((m) => ({ source_key: m.source_key,
  patient_id: m.patient_id ?? (m.pending_create_key ? `new:${m.pending_create_key}` : null),
  phone_norm: m.phone_norm, dob: m.dob, link_state: m.link_state }));

export function shuffled<T>(a: readonly T[], rnd: () => number): T[] {
  const out = [...a];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Everything a decision consists of, minus what only says WHERE in the sheet a row sat. */
function decisions(out: CustomerPlan) {
  const ops = out.ops.map((o: CustomerOp) => {
    if (o.op === "create") {
      return { op: o.op, create_key: o.create_key, method: o.method, link_keys: o.link_keys, admin_link_keys: o.admin_link_keys,
        fields: o.fields, facts: { registered_on: o.facts.registered_on, new_repeat: o.facts.new_repeat } };
    }
    if (o.op === "facts") return { op: o.op, patient_id: o.patient_id, registered_on: o.registered_on, new_repeat: o.new_repeat };
    return o;
  }).map((o) => JSON.stringify(o)).sort();
  const mirror = out.mirror.map((m) => JSON.stringify([m.source_key, m.patient_id, m.pending_create_key, m.link_state])).sort();
  const review = out.review.map((r) => JSON.stringify([r.item_key, r.kind, r.payload.reason ?? null])).sort();
  return { ops, mirror, review };
}

const FIELD_OF: Record<keyof FillFields, (r: CustomerRow) => string | null> = {
  phone: (r) => r.phoneE164, email: (r) => r.email, birthdate: (r) => r.dob, sex: (r) => r.sex, address: (r) => r.address,
  referred_by_doctor: (r) => r.referredByDoctor, preferred_release_medium: (r) => r.releaseMedium,
  senior_pwd_id_kind: (r) => r.seniorKind, senior_pwd_id_number: (r) => r.seniorNumber, referral_source: (r) => r.referralSourceId,
};

function describeCase(i: number, c: Case, rows: readonly CustomerRow[]) {
  return JSON.stringify({ case: i,
    rows: rows.map((r) => [r.sheetRow, r.fullNameRaw, r.dob, r.phone10, r.registeredOn, r.email, r.address]),
    patients: c.w0.patients.map((p) => [p.id, p.last_name, p.first_name, p.middle_name, p.birthdate, p.phone, p.merged_into_id]),
    links: [...c.w0.links.values()].map((l) => [l.link_key, l.decision, l.method, l.patient_id]),
    prev: c.prev.map((v) => [v.patient_id, v.phone_norm, v.dob]) });
}


export interface CaseResult { violations: string[]; orderChecked: boolean }

/** Runs one world through the five properties; `rnd` also drives the row shuffle. */
export function checkCase(i: number, c: Case, rnd: () => number): CaseResult {
  const violations: string[] = [];
  const rows = parse(c.table);
  const ctx = () => describeCase(i, c, rows);
  const fail = (what: string, detail = "") => violations.push(`${what}${detail ? ` — ${detail}` : ""} | ${ctx()}`);
  const out1 = plan(rows, c.w0, c.prev);

  // (1) determinism
  if (JSON.stringify(plan(rows, c.w0, c.prev)) !== JSON.stringify(out1)) fail("nondeterministic");

  // (2) order independence (exact duplicates are merged by the PARSER in sheet
  // order, which is out of scope here — those worlds are skipped)
  const permuted = parse([c.table[0], ...shuffled(c.table.slice(1), rnd)]);
  let orderChecked = false;
  if (rows.every((r) => r.dupCount === 1) && permuted.every((r) => r.dupCount === 1)) {
    orderChecked = true;
    const a = JSON.stringify(decisions(out1)), b = JSON.stringify(decisions(plan(permuted, c.w0, c.prev)));
    if (a !== b) fail("order-dependent", `${a} VS ${b}`);
  }

  // (3) run-2 stability: replaying run 1, the same sheet asks for nothing more
  const w1 = applyChecked(out1.ops, c.w0, fail, "");
  if (!w1) return { violations, orderChecked };
  const out2 = plan(rows, w1, mirrorAsPrev(out1));
  if (out2.ops.length) fail("run-2 ops", JSON.stringify(out2.ops.map((o) => ({ ...o, legacy_intake: undefined }))));

  checkAttachments(out1, rows, c.w0, w1, fail, "");

  // (6) a stranger arrives next run: one more row under an existing name/DOB
  // with a phone, email and address nobody has used. Whatever the saved
  // decisions now say, only an ADMIN's own decision may pour it into a
  // patient it conflicts with (review round 2, C1/C2).
  const keyed = rows.filter((r) => out1.mirror.some((m) => m.link_key === r.linkKey && m.link_state === "linked"));
  if (keyed.length) {
    const base = keyed[Math.floor(rnd() * keyed.length)];
    const extra: Cell[] = new Array(22).fill("");
    extra[4] = base.fullNameRaw; extra[6] = base.dob ? c.table[base.sheetRow - 1][6] : "";
    extra[11] = "09179999999"; extra[12] = "stranger@example.com"; extra[10] = "Strangertown"; extra[20] = 45900;
    const rows2 = parse([...c.table, extra]);
    const outS = plan(rows2, w1, mirrorAsPrev(out1));
    const wS = applyChecked(outS.ops, w1, fail, "stranger: ");
    if (wS) checkAttachments(outS, rows2, c.w0, wS, fail, "stranger: ");
  }
  return { violations, orderChecked };
}

/**
 * Applies a plan through the SQL model and checks (7): a HOLD in the world
 * before the run is exactly the same after it — the planner never re-decides
 * a held key, and 0170 refuses to (a create over a hold raises, which the
 * model turns into a throw, recorded here as a violation).
 */
function applyChecked(ops: readonly CustomerOp[], w: World, fail: (what: string, detail?: string) => void, tag: string): World | null {
  let out: World;
  try {
    out = applyOps(ops, w);
  } catch (e) {
    fail(`${tag}ops rejected by the SQL model`, e instanceof Error ? e.message : String(e));
    return null;
  }
  for (const [k, l] of w.links) {
    if (l.decision !== "review") continue;
    if (JSON.stringify(out.links.get(k)) !== JSON.stringify(l)) fail(`${tag}held key changed`, `${k}: ${JSON.stringify(out.links.get(k))}`);
  }
  return out;
}

/**
 * (4) every filled / created value came from a row attached to that patient;
 * (5) no auto-attached row conflicts with the patient it ends up on. Only the
 * decisions saved BEFORE the sync ran (`w0`, i.e. an admin's own) exempt a row.
 */
function checkAttachments(out1: CustomerPlan, rows: readonly CustomerRow[], w0: World, w1: World,
  fail: (what: string, detail?: string) => void, tag: string) {
  const attached = new Map<string, CustomerRow[]>();
  out1.mirror.forEach((m, j) => {
    if (m.link_state !== "linked") {
      if (m.patient_id !== null || m.pending_create_key !== null) fail(`${tag}reviewed row attached`, m.link_key);
      return;
    }
    const pid = m.patient_id ?? `new:${m.pending_create_key}`;
    attached.set(pid, [...(attached.get(pid) ?? []), rows[j]]);
  });
  for (const o of out1.ops) {
    if (o.op !== "fill" && o.op !== "create") continue;
    const pid = o.op === "fill" ? o.patient_id : `new:${o.create_key}`;
    const mine = attached.get(pid) ?? [];
    for (const k of Object.keys(FIELD_OF) as Array<keyof FillFields>) {
      const v = o.fields[k];
      if (v === undefined || v === null) continue;
      if (!mine.some((r) => FIELD_OF[k](r) === v)) fail(`${tag}value from an unattached row`, `${pid} ${k}=${v}`);
    }
  }

  // (5) no auto-linked or auto-created row conflicts with the patient it ends
  // up on (admin decisions are trusted by design and exempt)
  const byId = new Map(w1.patients.map((p) => [p.id, p]));
  for (const [pid, rs] of attached) {
    const p = byId.get(pid)!;
    for (const r of rs) {
      if (w0.links.get(r.linkKey)?.method === "admin") continue;
      const pPhone = phone10(p.phone);
      // Judge the row by the phone it would actually WRITE when it has one.
      const rPhone = phone10(r.phoneE164) ?? r.phone10;
      if (r.dob && p.birthdate && r.dob !== p.birthdate) fail(`${tag}DOB conflict`, `${pid} row ${r.sheetRow}`);
      if (rPhone && pPhone && rPhone !== pPhone && !(r.dob && p.birthdate && r.dob === p.birthdate)) {
        fail(`${tag}phone conflict`, `${pid} row ${r.sheetRow}`);
      }
    }
  }
}
