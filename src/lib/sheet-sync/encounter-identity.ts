import { isTokenMultisetSuperset, type PatientIndex } from "./patient-index";
import type { EncounterLine, LinkRecord } from "./types";

export { isTokenMultisetSuperset };

export interface IdentifiedLine extends EncounterLine {
  patientId: string | null;
  identityKey: string;
}

/**
 * Spec §5.2, in order:
 * (1) a sheet_patient_links decision for this name. Lab/consult lines carry no
 *     DOB, so only decisions that speak for the NAME count: the undated key
 *     `${nameNorm}#` (any method) and admin decisions on any `${nameNorm}#<dob>`.
 *     A DOB-keyed AUTO decision only says "this dated Customers row is that
 *     patient" — it does not make every same-named lab line theirs (review I3).
 *     Applies only when they all resolve to ONE live patient; a pending
 *     `create` decision for the name, or a decision whose patient is gone,
 *     means the name is not one person and step 1 is skipped. So does any
 *     HOLD (`review`) on any key of the name, whatever its method: the sync
 *     is unsure who that name is. And when TWO OR MORE live patients share
 *     the full name, a DOB-keyed admin decision only says who the person with
 *     that DOB is — it cannot pick among them for a line with no DOB — so step
 *     1 then needs a decision on the undated key `${nameNorm}#` (review
 *     round 2, I5); the DOB-keyed ones still block if they disagree with it.
 * (2) exact full name → exactly one live patient (merged spellings resolve to
 *     their survivor);
 * (3) loose key with exactly one live patient one of whose spellings is a
 *     MULTISET superset of the line's tokens;
 * (4) name:<looseKey>.
 * The mirror never creates patients.
 */
export function assignIdentities(
  lines: readonly EncounterLine[],
  index: PatientIndex,
  links: ReadonlyMap<string, LinkRecord>,
): IdentifiedLine[] {
  const byName = new Map<string, { targets: Set<string>; blocked: boolean; undatedLink: boolean }>();
  for (const l of links.values()) {
    const cut = l.link_key.lastIndexOf("#");
    const name = l.link_key.slice(0, cut);
    const undated = cut === l.link_key.length - 1;
    const hold = l.decision === "review";
    if (!undated && l.method !== "admin" && !hold) continue;
    const entry = byName.get(name) ?? { targets: new Set<string>(), blocked: false, undatedLink: false };
    byName.set(name, entry);
    const s = l.decision === "link" && l.patient_id ? index.survivor(l.patient_id) : null;
    if (s) { entry.targets.add(s); if (undated) entry.undatedLink = true; } else entry.blocked = true;
  }
  return lines.map((line) => {
    const viaLink = byName.get(line.nameNorm);
    const sharedName = (index.byFullName.get(line.nameNorm)?.length ?? 0) > 1;
    if (viaLink && !viaLink.blocked && viaLink.targets.size === 1 && (!sharedName || viaLink.undatedLink)) {
      const id = [...viaLink.targets][0];
      return { ...line, patientId: id, identityKey: `patient:${id}` };
    }
    const full = index.byFullName.get(line.nameNorm) ?? [];
    if (full.length === 1) return { ...line, patientId: full[0], identityKey: `patient:${full[0]}` };
    if (full.length === 0) {
      const loose = (index.byLoose.get(line.looseKey) ?? [])
        .filter((id) => (index.tokens.get(id) ?? []).some((toks) => isTokenMultisetSuperset(toks, line.tokens)));
      if (loose.length === 1) return { ...line, patientId: loose[0], identityKey: `patient:${loose[0]}` };
    }
    return { ...line, patientId: null, identityKey: `name:${line.looseKey}` };
  });
}
