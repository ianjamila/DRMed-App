import { patientSearchTokens } from "@/lib/patients/search";
import { visitNumberFilter } from "./visit-number-filter";

// Quote PostgREST logic values separately from escaping SQL LIKE wildcards.
const quote = (value: string) => `"${value.replace(/[\\"]/g, "\\$&")}"`;

export function archiveSearchPlan(query?: string) {
  return patientSearchTokens(query).map((token, index) => {
    const alias = `search_patient_${index}`;
    const pattern = quote(`%${token.replace(/[\\%_*]/g, "\\$&")}%`);
    const number = visitNumberFilter(token);
    const visitClause = number?.kind === "exact"
      ? `visit_number.in.(${number.values.map(quote).join(",")})`
      : `visit_number.ilike.${quote((number?.pattern ?? "%#%").replace(/\*/g, "\\*"))}`;
    return {
      alias,
      patientClause: ["drm_id", "first_name", "middle_name", "last_name"]
        .map((field) => `${field}.ilike.${pattern}`).join(","),
      visitClause: `${visitClause},${alias}.not.is.null`,
    };
  });
}

/**
 * Each token may match the visit number OR the patient. Empty left embeds
 * allow cross-resource OR without filtering the patient data we display.
 * Applying this before range/count keeps pagination and export consistent.
 * https://docs.postgrest.org/en/stable/references/api/resource_embedding.html#or-filtering-across-embedded-resources
 */
export function applyArchiveSearch<T extends {
  or: (clause: string, options?: { referencedTable: string }) => T;
}>(query: T, terms: ReturnType<typeof archiveSearchPlan>): T {
  for (const term of terms) {
    query = query.or(term.patientClause, { referencedTable: term.alias });
    query = query.or(term.visitClause);
  }
  return query;
}
