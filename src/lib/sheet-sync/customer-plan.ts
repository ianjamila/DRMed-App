/**
 * Customers identity plan (spec §5.3, plan Task 5): turns a snapshot of
 * Customers rows into ops (create / link / fill / facts), mirror rows and
 * review items. Pure and not server-only: the CLI imports it.
 */
import type { PatientIndex } from "./patient-index";
import type {
  CustomerMirrorRow, CustomerOp, CustomerPlan, CustomerRow, FactsRecord, FillFields, LinkRecord,
  LinkState, PatientRecord, PrevCustomerRow, ReviewItemInput,
} from "./types";

interface Input {
  rows: readonly CustomerRow[];
  index: PatientIndex;
  links: ReadonlyMap<string, LinkRecord>;
  facts: ReadonlyMap<string, FactsRecord>;
  prevRows: readonly PrevCustomerRow[];
  importedAtIso?: string;       // legacy_intake.imported_at; runner passes the run start
}

type Resolution =
  | { kind: "linked"; patientId: string; newLink: null | "auto_exact" }
  | { kind: "create"; method: "auto_exact" | "admin" }
  | { kind: "review"; state: LinkState; item: ReviewItemInput };

const FILL_COLUMNS = [
  "phone", "email", "birthdate", "sex", "address", "referred_by_doctor",
  "preferred_release_medium", "senior_pwd_id_kind", "senior_pwd_id_number",
] as const;

/** Oldest registration first; undated rows last; then sheet order. */
function byEarliest(a: CustomerRow, b: CustomerRow): number {
  if (a.registeredOn !== b.registeredOn) {
    if (a.registeredOn === null) return 1;
    if (b.registeredOn === null) return -1;
    return a.registeredOn < b.registeredOn ? -1 : 1;
  }
  return a.sheetRow - b.sheetRow;
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
function aggregate(rows: CustomerRow[]): Required<FillFields> {
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

/** What the conditional fill would change — mirrors sheet_sync_apply_customer_ops (0159). */
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

/**
 * Corroboration guard (spec §5.3): a live patient with the SAME DOB as the row
 * AND (the same first given token OR the same surname tokens) — a name typo
 * or reordering that DOB confirms is still the same person, unlike a bare
 * DOB coincidence.
 */
function dobAndNameCorroborates(index: PatientIndex, patientId: string, surnameTokens: readonly string[], firstTok: string): boolean {
  const p = index.byId.get(patientId)!;
  const toks = index.tokens.get(patientId) ?? [];
  const sameFirstToken = toks.includes(firstTok);
  const sameSurnameTokens = !!p.last_name && surnameTokens.every((t) => toks.includes(t));
  return sameFirstToken || sameSurnameTokens;
}

export function planCustomers(input: Input): CustomerPlan {
  const { index, links } = input;
  const ops: CustomerOp[] = [];
  const resolutions = new Map<string, Resolution>(); // by sourceKey

  // Corroboration sources: rows linked last run that vanished from this snapshot.
  const currentKeys = new Set(input.rows.map((r) => r.sourceKey));
  const vanished = input.prevRows.filter((p) => p.patient_id && !currentKeys.has(p.source_key));

  const live = (ids: readonly string[] | undefined) => (ids ?? []).filter((id) => index.isLive(id));

  for (const r of input.rows) {
    const link = links.get(r.linkKey);
    if (link?.decision === "create") { resolutions.set(r.sourceKey, { kind: "create", method: "admin" }); continue; }
    if (link?.decision === "link" && link.patient_id) {
      const s = index.survivor(link.patient_id);
      if (s) { resolutions.set(r.sourceKey, { kind: "linked", patientId: s, newLink: null }); continue; }
    }
    const full = live(index.byFullName.get(r.nameNorm));
    if (full.length === 1) {
      const p = index.byId.get(full[0])!;
      const dobConflict = !!(r.dob && p.birthdate && r.dob !== p.birthdate);
      const pPhone = p.phone_normalized;
      const phoneDiffers = !!(r.phone10 && pPhone && r.phone10 !== pPhone);
      const dobMatches = !!(r.dob && p.birthdate && r.dob === p.birthdate);
      if (dobConflict || (phoneDiffers && !dobMatches)) {
        resolutions.set(r.sourceKey, { kind: "review", state: "conflict", item: { kind: "identity_conflict", item_key: r.linkKey,
          payload: { link_keys: [r.linkKey], rows: [rowPayload(r)], candidates: candidatePayload(index, full),
            reason: dobConflict ? "date of birth differs" : "phone differs and date of birth cannot confirm" } } });
      } else {
        resolutions.set(r.sourceKey, { kind: "linked", patientId: p.id, newLink: "auto_exact" });
      }
      continue;
    }
    if (full.length > 1) {
      resolutions.set(r.sourceKey, { kind: "review", state: "ambiguous", item: { kind: "ambiguous_patient", item_key: r.linkKey,
        payload: { link_keys: [r.linkKey], rows: [rowPayload(r)], candidates: candidatePayload(index, full), reason: "several patients share this full name" } } });
      continue;
    }
    const loose = live(index.byLoose.get(r.looseKey));
    if (loose.length > 0) {
      resolutions.set(r.sourceKey, { kind: "review", state: "ambiguous", item: { kind: "ambiguous_patient", item_key: r.linkKey,
        payload: { link_keys: [r.linkKey], rows: [rowPayload(r)], candidates: candidatePayload(index, loose), reason: "similar name (surname + first name) — not linked automatically" } } });
      continue;
    }
    const surnameTokens = r.nameNorm.split("|")[0].split(" ");
    const firstTok = r.looseKey.split("|")[1];
    const hits = new Set<string>(live(r.phone10 ? index.byPhone.get(r.phone10) : []));
    for (const id of live(r.dob ? index.byDob.get(r.dob) : [])) {
      if (dobAndNameCorroborates(index, id, surnameTokens, firstTok)) hits.add(id);
    }
    for (const v of vanished) {
      if ((r.phone10 && v.phone_norm === r.phone10) || (r.dob && v.dob === r.dob)) {
        const s = index.survivor(v.patient_id!);
        if (s) hits.add(s);
      }
    }
    if (hits.size > 0) {
      resolutions.set(r.sourceKey, { kind: "review", state: "possible_existing", item: { kind: "possible_existing_patient", item_key: r.linkKey,
        payload: { link_keys: [r.linkKey], rows: [rowPayload(r)], candidates: candidatePayload(index, [...hits]), reason: "same phone or date of birth as an existing patient" } } });
      continue;
    }
    resolutions.set(r.sourceKey, { kind: "create", method: "auto_exact" });
  }

  // Merge review items that share a link key (one item per identity, rows listed).
  const reviewByKey = new Map<string, ReviewItemInput>();
  for (const res of resolutions.values()) {
    if (res.kind !== "review") continue;
    const prev = reviewByKey.get(res.item.item_key);
    if (prev) (prev.payload.rows as unknown[]).push(...(res.item.payload.rows as unknown[]));
    else reviewByKey.set(res.item.item_key, structuredClone(res.item));
  }

  // Creates: group by nameNorm; one patient per distinct DOB; undated rows join the
  // single dated group, or go to review when the name has several DOBs.
  const createRows = input.rows.filter((r) => resolutions.get(r.sourceKey)?.kind === "create");
  const createGroups = new Map<string, CustomerRow[]>(); // createKey → rows
  const byName = new Map<string, CustomerRow[]>();
  for (const r of createRows) byName.set(r.nameNorm, [...(byName.get(r.nameNorm) ?? []), r]);
  for (const [nameNorm, rows] of byName) {
    const dobs = [...new Set(rows.map((r) => r.dob).filter((d): d is string => !!d))];
    if (dobs.length <= 1) { createGroups.set(`${nameNorm}#${dobs[0] ?? ""}`, rows); continue; }
    for (const d of dobs) createGroups.set(`${nameNorm}#${d}`, rows.filter((r) => r.dob === d));
    const undated = rows.filter((r) => !r.dob);
    if (undated.length) {
      const key = `${nameNorm}#`;
      for (const r of undated) resolutions.set(r.sourceKey, { kind: "review", state: "ambiguous", item: { kind: "ambiguous_patient", item_key: key, payload: {} } });
      reviewByKey.set(key, { kind: "ambiguous_patient", item_key: key, payload: { link_keys: [key], rows: undated.map(rowPayload), candidates: [],
        reason: "several new patients share this name with different dates of birth; this row has none" } });
    }
  }
  const createKeyBySource = new Map<string, string>();
  for (const [createKey, rows] of createGroups) {
    const agg = aggregate(rows);
    const first = [...rows].sort(byEarliest)[0];
    const methods = rows.map((r) => (resolutions.get(r.sourceKey) as { method: "auto_exact" | "admin" }).method);
    ops.push({
      op: "create", create_key: createKey, method: methods.includes("admin") ? "admin" : "auto_exact",
      link_keys: [...new Set(rows.map((r) => r.linkKey))],
      fields: { first_name: first.first!, last_name: first.last!, middle_name: first.middle, ...agg },
      legacy_intake: { source: "sheet_sync:CUSTOMER LIST2", imported_at: input.importedAtIso ?? null,
        original_row_index: first.sheetRow, raw: first.raw, import_warnings: [] },
      facts: { registered_on: first.registeredOn, new_repeat: rows.slice().sort(byEarliest).find((r) => r.newRepeat)?.newRepeat ?? null,
        source_ref: `CUSTOMER LIST2 r${first.sheetRow}` },
    });
    for (const r of rows) createKeyBySource.set(r.sourceKey, createKey);
  }

  // Linked: new link ops, then per-patient fill + facts diffs.
  const rowsByPatient = new Map<string, CustomerRow[]>();
  for (const r of input.rows) {
    const res = resolutions.get(r.sourceKey);
    if (res?.kind !== "linked") continue;
    rowsByPatient.set(res.patientId, [...(rowsByPatient.get(res.patientId) ?? []), r]);
    const existing = links.get(r.linkKey);
    if (res.newLink && (!existing || existing.patient_id !== res.patientId)) {
      ops.push({ op: "link", link_key: r.linkKey, patient_id: res.patientId, method: res.newLink });
    }
  }
  let fills = 0;
  let factsOps = 0;
  for (const [pid, rows] of rowsByPatient) {
    const p = index.byId.get(pid)!;
    const diff = fillDiff(p, aggregate(rows));
    if (Object.keys(diff).length) { ops.push({ op: "fill", patient_id: pid, fields: diff }); fills++; }
    const sorted = [...rows].sort(byEarliest);
    const want = { registered_on: sorted[0].registeredOn, new_repeat: sorted.find((r) => r.newRepeat)?.newRepeat ?? null,
      source_ref: `CUSTOMER LIST2 r${sorted[0].sheetRow}` };
    const have = input.facts.get(pid);
    if (!have || have.registered_on !== want.registered_on || have.sheet_new_repeat !== want.new_repeat || have.source_ref !== want.source_ref) {
      ops.push({ op: "facts", patient_id: pid, ...want }); factsOps++;
    }
  }
  // Dedupe link ops (several rows can share a link key).
  const seenLink = new Set<string>();
  const dedupedOps = ops.filter((o) => (o.op !== "link" ? true : !seenLink.has(o.link_key) && !!seenLink.add(o.link_key)));

  // Unmapped answers: one item per normalised answer.
  const unmapped = new Map<string, { answer: string; rows: number }>();
  for (const r of input.rows) {
    if (!r.unmappedSource) continue;
    const u = unmapped.get(r.sourceNorm);
    if (u) u.rows += r.dupCount; else unmapped.set(r.sourceNorm, { answer: r.sourceNorm, rows: r.dupCount });
  }
  for (const [norm, u] of unmapped) reviewByKey.set(`unmapped:${norm}`, { kind: "unmapped_source", item_key: norm, payload: u });

  const mirror: CustomerMirrorRow[] = input.rows.map((r) => {
    const res = resolutions.get(r.sourceKey)!;
    const createKey = createKeyBySource.get(r.sourceKey) ?? null;
    return {
      sheet_row: r.sheetRow, source_key: r.sourceKey, dup_count: r.dupCount, full_name_raw: r.fullNameRaw,
      name_norm: r.nameNorm, loose_key: r.looseKey, link_key: r.linkKey, phone_norm: r.phone10, dob: r.dob,
      registered_on: r.registeredOn, source_raw: r.sourceRaw, source_norm: r.sourceNorm,
      referral_source_id: r.referralSourceId, referred_by_raw: r.referredByRaw, new_repeat: r.newRepeat,
      release_medium_raw: r.releaseMediumRaw,
      patient_id: res.kind === "linked" ? res.patientId : null,
      pending_create_key: createKey,
      link_state: res.kind === "linked" || createKey ? "linked" : res.kind === "review" ? res.state : "unlinked",
      row_hash: r.rowHash,
    };
  });

  const reviewList = [...reviewByKey.values()];
  const reviewCounts: Record<string, number> = {};
  for (const i of reviewList) reviewCounts[i.kind] = (reviewCounts[i.kind] ?? 0) + 1;
  const linkedExisting = [...resolutions.values()].filter((x) => x.kind === "linked").length;
  return {
    ops: dedupedOps, mirror, review: reviewList,
    counts: { rows: input.rows.length, linked_existing: linkedExisting,
      link_new: dedupedOps.filter((o) => o.op === "link").length, create: createGroups.size,
      fill: fills, facts: factsOps, review: reviewCounts },
  };
}
