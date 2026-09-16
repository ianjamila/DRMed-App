import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "@/types/database";
import {
  loadPatientsWithoutConsent,
  loadPatientsWithoutConsentPage,
  PATIENTS_WITHOUT_CONSENT_CSV_HEADER,
  PATIENTS_WITHOUT_CONSENT_DEFAULT_SORT,
  patientsWithoutConsentCsvFilename,
  patientsWithoutConsentCsvHref,
  patientsWithoutConsentCsvRows,
  type PatientWithoutConsentRow,
  type PatientsWithoutConsentSortColumn,
} from "./patients-without-consent";
import { REPORT_EXPORT_MAX_ROWS } from "./paging";

const rows: PatientWithoutConsentRow[] = [
  { id: "p1", drm_id: "DRM-1", first_name: "Ana", last_name: "Cruz", phone: "0917", email: null, pre_registered: true, visit_count: 2, last_visit_at: "2026-08-01" },
  { id: "p2", drm_id: "DRM-2", first_name: null, last_name: null, phone: null, email: "b@x.ph", pre_registered: false, visit_count: 0, last_visit_at: null },
  { id: "p3", drm_id: "DRM-3", first_name: "Cy", last_name: "Dee", phone: null, email: null, pre_registered: false, visit_count: 1, last_visit_at: "2026-09-01" },
];

// Exercise the real Supabase/PostgREST builder, with all HTTP intercepted.
function mockClient(respond: (url: URL, init?: RequestInit) => Response) {
  const requests: { url: URL; init?: RequestInit }[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    return respond(url, init);
  });
  const client = createClient<Database>("https://report.invalid", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch },
  });
  return { client, requests };
}

function response(data: unknown, total?: number, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...(total === undefined ? {} : { "Content-Range": `0-9/${total}` }),
    },
  });
}

const pageParams = { sort: PATIENTS_WITHOUT_CONSENT_DEFAULT_SORT, page: 1, size: 10 };

describe("database paging and sorting", () => {
  it("fetches only page 688 and reports the exact uncapped total", async () => {
    const { client, requests } = mockClient(() => response([rows[2]], 25_001));
    const result = await loadPatientsWithoutConsentPage(client, { ...pageParams, page: 688 });
    expect(result).toEqual({ rows: [rows[2]], total: 25_001 });
    expect(requests).toHaveLength(1);
    const { url, init } = requests[0];
    expect(url.pathname).toBe("/rest/v1/v_patients_without_consent");
    expect(url.searchParams.get("offset")).toBe("6870");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("order")).toBe("last_visit_at.desc.nullslast,id.asc");
    expect(new Headers(init?.headers).get("Prefer")).toBe("count=exact");
    expect(url.searchParams.get("select")).toContain("visit_count,last_visit_at");
  });

  const sorts: [PatientsWithoutConsentSortColumn, string][] = [
    ["patient", "patient_name"], ["drm_id", "drm_id"], ["visits", "visit_count"],
    ["last_visit", "last_visit_at"], ["contact", "contact_score"],
  ];
  it.each(sorts)("%s: both directions retain nulls last and the SAME ascending id tie-break", async (key, column) => {
    const { client, requests } = mockClient(() => response([], 0));
    for (const dir of ["asc", "desc"] as const) {
      await loadPatientsWithoutConsentPage(client, { ...pageParams, sort: { key, dir } });
    }
    expect(requests.map(({ url }) => url.searchParams.get("order"))).toEqual([
      `${column}.asc.nullslast,id.asc`, `${column}.desc.nullslast,id.asc`,
    ]);
  });

  it("leaves sorting before paging to Postgres, preserving a recently active old patient", async () => {
    const old = { ...rows[0], id: "old", last_visit_at: "2026-09-10" };
    const { client, requests } = mockClient(() => response([old], 2));
    const result = await loadPatientsWithoutConsentPage(client, { ...pageParams, size: 1 });
    expect(result.rows).toEqual([old]);
    expect(result.total).toBe(2);
    expect(requests[0].url.searchParams.get("order")).toBe("last_visit_at.desc.nullslast,id.asc");
    expect(requests[0].url.searchParams.get("limit")).toBe("1");
    expect(requests[0].url.search).not.toContain("created_at");
  });

  it("returns an empty report with an exact zero", async () => {
    const { client } = mockClient(() => response([], 0));
    expect(await loadPatientsWithoutConsentPage(client, pageParams)).toEqual({ rows: [], total: 0 });
  });

  it("recovers the exact total for an out-of-range bookmark without fetching all patients", async () => {
    const { client, requests } = mockClient((_url, init) => init?.method === "HEAD"
      ? new Response(null, { headers: { "Content-Range": "*/6877" } })
      : response({ code: "PGRST103", message: "Requested range not satisfiable" }, undefined, 416));
    expect(await loadPatientsWithoutConsentPage(client, { ...pageParams, page: 900 })).toEqual({ rows: [], total: 6877 });
    expect(requests).toHaveLength(2);
    expect(requests[1].init?.method).toBe("HEAD");
    expect(new Headers(requests[1].init?.headers).get("Prefer")).toBe("count=exact");
  });

  it("fails on a database error instead of showing a misleading empty report", async () => {
    const { client } = mockClient(() => response({ message: "permission denied", code: "42501" }, undefined, 403));
    await expect(loadPatientsWithoutConsentPage(client, pageParams)).rejects.toThrow("permission denied");
  });

  it("does not substitute the page length if the exact count is absent", async () => {
    const { client } = mockClient(() => response(rows));
    await expect(loadPatientsWithoutConsentPage(client, pageParams)).rejects.toThrow("count missing");
  });
});

describe("CSV from the same view", () => {
  it.each([REPORT_EXPORT_MAX_ROWS, REPORT_EXPORT_MAX_ROWS + 1])("walks past 1000 rows up to the export ceiling (population %i)", async (population) => {
    const { client, requests } = mockClient((url) => {
      const from = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit"));
      return response(Array.from({ length: Math.max(0, Math.min(limit, population - from)) }, (_, i) => ({ ...rows[0], id: String(from + i) })));
    });
    const result = await loadPatientsWithoutConsent(client, REPORT_EXPORT_MAX_ROWS);
    expect(result.rows).toHaveLength(REPORT_EXPORT_MAX_ROWS);
    expect(new Set(result.rows.map((r) => r.id)).size).toBe(REPORT_EXPORT_MAX_ROWS);
    expect(result.truncated).toBe(population > REPORT_EXPORT_MAX_ROWS);
    expect(requests).toHaveLength(21); // 20 chunks + one-row truncation probe
    expect(requests.every(({ url }) => url.pathname === "/rest/v1/v_patients_without_consent")).toBe(true);
    expect(requests.every(({ url }) => url.searchParams.get("order") === "last_visit_at.desc.nullslast,id.asc")).toBe(true);
    expect(requests.at(-1)?.url.searchParams.get("offset")).toBe("20000");
    expect(requests.at(-1)?.url.searchParams.get("limit")).toBe("1");
  });

  it("fails rather than returning a partial export after a later chunk error", async () => {
    const { client } = mockClient((url) => Number(url.searchParams.get("offset")) > 0
      ? response({ message: "query failed", code: "42501" }, undefined, 403)
      : response(Array.from({ length: 1000 }, () => rows[0])));
    await expect(loadPatientsWithoutConsent(client, REPORT_EXPORT_MAX_ROWS)).rejects.toThrow("query failed");
  });

  it("preserves name, contact, zero-visit and Manila date output", () => {
    expect(patientsWithoutConsentCsvRows([rows[2], rows[0], rows[1]])).toEqual([
      [...PATIENTS_WITHOUT_CONSENT_CSV_HEADER],
      ["Dee, Cy", "DRM-3", "no", 1, "2026-09-01", "", ""],
      ["Cruz, Ana", "DRM-1", "yes", 2, "2026-08-01", "0917", ""],
      ["(no name on file)", "DRM-2", "no", 0, "", "", "b@x.ph"],
    ]);
  });

  it("has no filters and stamps the filename day", () => {
    expect(patientsWithoutConsentCsvHref()).toBe("/api/admin/reports/patients-without-consent.csv");
    expect(patientsWithoutConsentCsvFilename("2026-09-08")).toBe("patients-without-consent-2026-09-08.csv");
  });
});

describe("0150 SQL contract (live parity checks are in supabase/tests)", () => {
  const sql = readFileSync("supabase/migrations/0150_patients_without_consent_report.sql", "utf8")
    .replace(/--[^\n]*/g, "").replace(/\s+/g, " ");

  it("keeps the exact candidate and visit definitions, including zero visits", () => {
    expect(sql).toContain("where p.consent_current = false and p.merged_into_id is null");
    expect(sql).toContain("left join ( select patient_id, count(*) as visit_count, max(visit_date) as last_visit_at from public.visits where deleted_at is null group by patient_id ) v on v.patient_id = p.id");
    expect(sql).toContain("coalesce(v.visit_count, 0::bigint) as visit_count");
    expect(sql).not.toMatch(/test_requests|payment_status|is_historical|visit_group_id/);
  });

  it("preserves name and contact sorting semantics", () => {
    expect(sql).toContain("nullif(concat_ws(', ', n.last_name, n.first_name), '') as patient_name");
    expect(sql).toContain("case when coalesce(p.phone, '') <> '' then 1 else 0 end");
    expect(sql).toContain("case when coalesce(p.email, '') <> '' then 1 else 0 end");
    expect(sql).not.toContain("p.middle_name");
  });

  it("has invoker RLS, explicit authenticated SELECT only, and matching seed ACLs", () => {
    expect(sql).toContain("with (security_invoker = true)");
    const revoke = "revoke all on public.v_patients_without_consent from public, anon, authenticated;";
    const grant = "grant select on public.v_patients_without_consent to authenticated;";
    expect(sql).toContain(revoke);
    expect(sql).toContain(grant);
    expect(sql).not.toMatch(/grant\s+[^;]*\bto\s+[^;]*\banon\b/);
    const seed = readFileSync("supabase/seed.sql", "utf8");
    expect(seed.slice(seed.lastIndexOf(revoke))).toContain(grant);
  });
});
