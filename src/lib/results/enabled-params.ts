// Pure derivation of which template parameters the consolidated encoding form
// enables, from report_group_service_params rows + this visit's ordered
// services. Identity-based (parameter_id) — replaces the old name-matched
// SERVICE_TO_PARAMS map. Must stay free of "server-only" imports (unit-tested).

export interface ServiceParamLink {
  service_id: string;
  parameter_id: string;
}

export function deriveEnabledParamIds(
  links: ServiceParamLink[],
  orderedServiceIds: string[],
): Set<string> {
  const ordered = new Set(orderedServiceIds);
  const enabled = new Set<string>();
  for (const link of links) {
    if (ordered.has(link.service_id)) enabled.add(link.parameter_id);
  }
  return enabled;
}
