import { isTokenSuperset } from "./names";
import type { PatientIndex } from "./patient-index";
import type { EncounterLine, LinkRecord } from "./types";

export interface IdentifiedLine extends EncounterLine {
  patientId: string | null;
  identityKey: string;
}

/**
 * Spec §5.2, in order: (1) a sheet_patient_links decision for this nameNorm
 * (lab/consult rows carry no DOB, so every decision whose key starts with the
 * name counts, and it applies only when they all resolve to ONE patient);
 * (2) exact full name → exactly one live patient; (3) loose key with exactly one
 * live patient whose tokens are a superset of the line's; (4) name:<looseKey>.
 * The mirror never creates patients.
 */
export function assignIdentities(
  lines: readonly EncounterLine[],
  index: PatientIndex,
  links: ReadonlyMap<string, LinkRecord>,
): IdentifiedLine[] {
  const linkTargetsByName = new Map<string, Set<string>>();
  for (const l of links.values()) {
    if (l.decision !== "link" || !l.patient_id) continue;
    const name = l.link_key.slice(0, l.link_key.lastIndexOf("#"));
    const s = index.survivor(l.patient_id);
    if (!s) continue;
    const set = linkTargetsByName.get(name) ?? new Set<string>();
    set.add(s);
    linkTargetsByName.set(name, set);
  }
  return lines.map((line) => {
    const viaLink = linkTargetsByName.get(line.nameNorm);
    if (viaLink && viaLink.size === 1) {
      const id = [...viaLink][0];
      return { ...line, patientId: id, identityKey: `patient:${id}` };
    }
    const full = (index.byFullName.get(line.nameNorm) ?? []).filter((id) => index.isLive(id));
    if (full.length === 1) return { ...line, patientId: full[0], identityKey: `patient:${full[0]}` };
    if (full.length === 0) {
      const loose = (index.byLoose.get(line.looseKey) ?? [])
        .filter((id) => index.isLive(id) && isTokenSuperset(index.tokens.get(id) ?? [], line.tokens));
      if (loose.length === 1) return { ...line, patientId: loose[0], identityKey: `patient:${loose[0]}` };
    }
    return { ...line, patientId: null, identityKey: `name:${line.looseKey}` };
  });
}
