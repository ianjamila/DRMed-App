import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import type { Database } from "@/types/database";
import { archiveSearchPlan } from "./archive-search";
import { fetchArchiveAll, fetchArchiveWindow, DEFAULT_ARCHIVE_SORT, type ArchiveVisit } from "./archive-query";

const visit: ArchiveVisit = {
  id: "one", visit_number: "0037", visit_date: "2026-09-16",
  created_at: "2026-09-16T01:00:00Z", visit_group_id: "group",
  payment_status: "paid", total_php: 100, paid_php: 100,
  deleted_at: null, delete_reason: null, payments: [],
  patients: { id: "patient", drm_id: "DRM-001", first_name: "Juan", middle_name: null, last_name: "Cruz" },
};

function client() {
  const requests: URL[] = [];
  const db = createClient<Database>("https://example.test", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      const rows = url.pathname.endsWith("/visits") ? [visit] : [];
      return new Response(JSON.stringify(rows), {
        status: 200, headers: { "Content-Type": "application/json", "Content-Range": "0-0/1" },
      });
    } },
  });
  return { db, requests };
}

describe("Visits archive search", () => {
  it("leaves blank searches unfiltered", async () => {
    expect(archiveSearchPlan(" , ")).toEqual([]);
    const { db, requests } = client();
    await fetchArchiveWindow(db, { q: " ", start: "", end: "", classes: new Set(), view: "active" }, DEFAULT_ARCHIVE_SORT, 10, 5);
    expect(requests[0].searchParams.has("or")).toBe(false);
    expect(requests[0].searchParams.get("select")).not.toContain("search_patient_");
    expect(requests[0].searchParams.get("offset")).toBe("10");
  });

  it("ANDs name tokens in either order while allowing each token to match a visit number", async () => {
    const { db, requests } = client();
    await fetchArchiveWindow(db, { q: "Cruz, Juan #37", start: "2026-09-01", end: "2026-09-16", classes: new Set(), view: "active" }, DEFAULT_ARCHIVE_SORT, 0, 5);
    const [page, siblings] = requests;
    expect(page.searchParams.getAll("or")).toEqual([
      '(visit_number.ilike."%Cruz%",search_patient_0.not.is.null)',
      '(visit_number.ilike."%Juan%",search_patient_1.not.is.null)',
      '(visit_number.in.("0037","37"),search_patient_2.not.is.null)',
    ]);
    expect(page.searchParams.get("search_patient_0.or")).toContain('last_name.ilike."%Cruz%"');
    expect(page.searchParams.get("search_patient_1.or")).toContain('first_name.ilike."%Juan%"');
    // The sibling top-up must not silently broaden a search or deleted view.
    for (const key of ["select", "or", "search_patient_0.or", "search_patient_1.or", "search_patient_2.or", "visit_date", "deleted_at"]) {
      expect(siblings.searchParams.getAll(key)).toEqual(page.searchParams.getAll(key));
    }
  });

  it("quotes PostgREST syntax and escapes literal LIKE wildcards", () => {
    const [term] = archiveSearchPlan('A)B"C\\D%_*');
    const value = term.patientClause.split("drm_id.ilike.")[1].split(",first_name")[0];
    // Parsing the quoted value reverses the PostgREST escaping, leaving
    // SQL LIKE escapes in place. Parentheses and quotes stay inside a value.
    expect(JSON.parse(value)).toBe('%A)B"C\\\\D\\%\\_\\*%');
    expect(term.visitClause).toContain("search_patient_0.not.is.null");
  });

  it("uses the same search in CSV traversal", async () => {
    const { db, requests } = client();
    const result = await fetchArchiveAll(db, { q: "Juan", start: "", end: "", classes: new Set(), view: "active" }, DEFAULT_ARCHIVE_SORT, 100);
    expect(result.count).toBe(1);
    for (const request of requests.filter((url) => url.pathname.endsWith("/visits"))) {
      expect(request.searchParams.get("or")).toContain("search_patient_0.not.is.null");
      expect(request.searchParams.get("search_patient_0.or")).toContain('first_name.ilike."%Juan%"');
    }
  });
});
