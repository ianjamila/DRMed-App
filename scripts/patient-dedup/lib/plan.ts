// scripts/patient-dedup/lib/plan.ts
import { phoneKey, emailKey, normalizeName } from "./normalize";
import type { PatientRow, ClusterPlan, Tier, ReviewReason } from "./types";

/** A bare backfill-created stub: a name with no real identifiers attached. */
function isStub(r: PatientRow): boolean {
  return !r.birthdate && !phoneKey(r.phone) && !emailKey(r.email);
}

/** Normalized given-name tokens (diacritics stripped, lowercased). */
function givenTokens(r: PatientRow): string[] {
  return normalizeName(r.first_name ?? "").split(" ").filter(Boolean);
}

function isPrefix(short: string[], long: string[]): boolean {
  if (short.length === 0 || short.length > long.length) return false;
  return short.every((t, i) => t === long[i]);
}

/** Same person under a partial vs fuller given name (e.g. "Ryza" ⊂ "Ryza Maxine").
 *  Surname + first given token already match (clustering is by matchKey); this
 *  checks the remaining tokens are a prefix in either direction. Requires at least
 *  one given token on each side, so surname-only rows never qualify. */
function nameRefines(a: PatientRow, b: PatientRow): boolean {
  const ta = givenTokens(a), tb = givenTokens(b);
  return isPrefix(ta, tb) || isPrefix(tb, ta);
}

/** Number of populated optional fields — the completeness tiebreak. */
export function completeness(r: PatientRow): number {
  return [r.phone, r.email, r.birthdate, r.sex, r.address, r.middle_name]
    .filter((v) => v != null && String(v).trim() !== "").length;
}

function drmNum(r: PatientRow): number {
  const m = /(\d+)/.exec(r.drm_id ?? "");
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

/** most visits -> most complete -> oldest created_at -> lowest DRM number. */
export function pickCanonical(cluster: PatientRow[]): PatientRow {
  return [...cluster].sort((a, b) => {
    if (b.visit_count !== a.visit_count) return b.visit_count - a.visit_count;
    const ca = completeness(a), cb = completeness(b);
    if (cb !== ca) return cb - ca;
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
    return drmNum(a) - drmNum(b);
  })[0];
}

type Verdict =
  | { action: "auto"; tier: Tier }
  | { action: "review"; reason: ReviewReason };

/** Classify a cluster member against the canonical row. Name already matches
 *  (clustering is by matchKey). Hard conflict guards run first. */
function classify(member: PatientRow, canon: PatientRow): Verdict {
  if (member.birthdate && canon.birthdate && member.birthdate !== canon.birthdate)
    return { action: "review", reason: "dob-conflict" };
  if (member.sex && canon.sex && member.sex !== canon.sex)
    return { action: "review", reason: "sex-conflict" };

  if (member.birthdate && canon.birthdate && member.birthdate === canon.birthdate)
    return { action: "auto", tier: "name+dob" };
  const mp = phoneKey(member.phone), cp = phoneKey(canon.phone);
  if (mp && cp && mp === cp) return { action: "auto", tier: "name+phone" };
  const me = emailKey(member.email), ce = emailKey(canon.email);
  if (me && ce && me === ce) return { action: "auto", tier: "name+email" };

  // Tier 3 (name-stub): a bare name-only stub (no dob/phone/email) of the same
  // person — partial vs fuller given name. The richer row is always the canonical
  // (pickCanonical prefers completeness), so the stub is what gets merged away.
  // Conflict guards above (dob/sex) have already run, so a stub with a contradicting
  // sex never reaches here.
  if (isStub(member) && nameRefines(member, canon))
    return { action: "auto", tier: "name-stub" };

  return { action: "review", reason: "name-only" };
}

/** A bare stub is ambiguous when its given name is a prefix of two or more
 *  DIVERGENT fuller names in the cluster — it could belong to more than one
 *  person, so we must not guess which. */
function isAmbiguousStub(stub: PatientRow, others: PatientRow[]): boolean {
  const ts = givenTokens(stub);
  const extensions = others
    .filter((o) => o.id !== stub.id)
    .map(givenTokens)
    .filter((to) => to.length > ts.length && isPrefix(ts, to));
  for (let i = 0; i < extensions.length; i++)
    for (let j = i + 1; j < extensions.length; j++)
      if (!isPrefix(extensions[i], extensions[j]) && !isPrefix(extensions[j], extensions[i]))
        return true;
  return false;
}

export function planCluster(cluster: PatientRow[]): ClusterPlan {
  const canonical = pickCanonical(cluster);
  const auto: ClusterPlan["auto"] = [];
  const review: ClusterPlan["review"] = [];
  for (const r of cluster) {
    if (r.id === canonical.id) continue;
    let v = classify(r, canonical);
    // Cluster-aware safety: a name-stub merge that's ambiguous across the whole
    // cluster (the stub could refine several divergent names) is held for review
    // rather than guessed. `cluster` includes the canonical, so a shorter stub
    // sees the canonical and every sibling as possible extensions.
    if (v.action === "auto" && v.tier === "name-stub" && isAmbiguousStub(r, cluster))
      v = { action: "review", reason: "name-only" };
    if (v.action === "auto") auto.push({ row: r, tier: v.tier });
    else review.push({ row: r, reason: v.reason });
  }
  return { canonical, auto, review };
}
