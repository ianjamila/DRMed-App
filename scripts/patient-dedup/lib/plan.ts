// scripts/patient-dedup/lib/plan.ts
import { phoneKey, emailKey } from "./normalize";
import type { PatientRow, ClusterPlan, Tier, ReviewReason } from "./types";

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

  return { action: "review", reason: "name-only" };
}

export function planCluster(cluster: PatientRow[]): ClusterPlan {
  const canonical = pickCanonical(cluster);
  const auto: ClusterPlan["auto"] = [];
  const review: ClusterPlan["review"] = [];
  for (const r of cluster) {
    if (r.id === canonical.id) continue;
    const v = classify(r, canonical);
    if (v.action === "auto") auto.push({ row: r, tier: v.tier });
    else review.push({ row: r, reason: v.reason });
  }
  return { canonical, auto, review };
}
