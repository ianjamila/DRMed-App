import { normalizeName } from "./names";

export interface CatalogService {
  id: string; code: string; name: string; kind: string; is_active: boolean;
}

export interface ServiceIndex {
  byName: Map<string, string>; // normalized name/code -> service_id
  consultId: string;           // CONSULT anchor
  legacyLabId: string;         // generic "Legacy lab test" service
}

/** Build the lookup index. `consultId`/`legacyLabId` are resolved by caller. */
export function buildServiceIndex(
  catalog: CatalogService[], consultId = "", legacyLabId = "",
): ServiceIndex {
  const byName = new Map<string, string>();
  let resolvedConsultId = consultId;
  for (const s of catalog) {
    const nName = normalizeName(s.name);
    const nCode = normalizeName(s.code);
    if (nName && !byName.has(nName)) byName.set(nName, s.id);
    if (nCode && !byName.has(nCode)) byName.set(nCode, s.id);
    if (s.code === "CONSULT") resolvedConsultId = s.id;
  }
  return { byName, consultId: resolvedConsultId, legacyLabId };
}

/** Resolve a sheet service string to a service_id. */
export function mapService(
  serviceText: string, isConsult: boolean, idx: ServiceIndex,
): { service_id: string; matched: boolean } {
  if (isConsult) return { service_id: idx.consultId, matched: true };
  const key = normalizeName(serviceText);
  const hit = key ? idx.byName.get(key) : undefined;
  if (hit) return { service_id: hit, matched: true };
  return { service_id: idx.legacyLabId, matched: false };
}
