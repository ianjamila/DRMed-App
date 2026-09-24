import { mapReferralSource } from "../legacy-import/vocabulary-mapper";
import { mapAnswer } from "./referral-mapper";

export interface ResortInput {
  id: string;
  answer: string;
  referral_source: string | null;
  referral_source_origin: "staff" | "patient" | "sheet" | null;
}
export interface ResortGroup {
  answerNorm: string;
  sampleAnswer: string;
  from: string | null;
  to: string | null;
  patientIds: string[];
}

/**
 * Proposal only (spec §4.1): patients whose CURRENT value still equals what the
 * 2026-05 mapper produced from their original answer, re-mapped with the new
 * rules. A value that differs from the old mapper's output was changed by staff
 * and is left alone (counted as keptByStaff). Groups are keyed by
 * (normalised answer, from, to) and sorted by size.
 */
export function computeResortGroups(patients: readonly ResortInput[], aliases: ReadonlyMap<string, string>) {
  const groups = new Map<string, ResortGroup>();
  let keptByStaff = 0;
  for (const p of patients) {
    if (p.referral_source_origin === "patient") continue;
    const old = mapReferralSource(p.answer).id;
    if (p.referral_source !== old) { keptByStaff++; continue; }
    const next = mapAnswer(p.answer, aliases);
    if (next.id === p.referral_source) continue;
    if (next.id === "other") continue; // D8: never downgrade to "other"
    const key = `${next.norm}\u0000${p.referral_source}\u0000${next.id}`;
    const g = groups.get(key) ?? { answerNorm: next.norm, sampleAnswer: p.answer.trim(), from: p.referral_source, to: next.id, patientIds: [] };
    g.patientIds.push(p.id);
    groups.set(key, g);
  }
  return {
    groups: [...groups.values()].sort((a, b) => b.patientIds.length - a.patientIds.length || a.answerNorm.localeCompare(b.answerNorm)),
    keptByStaff,
  };
}
