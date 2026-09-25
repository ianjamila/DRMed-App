import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "@/types/database";
import type { KeptCounts } from "@/lib/patients/deletion";
import {
  DELETED_SORTABLE,
  deletedPatientsCsvFilename,
  deletedPatientsCsvRows,
  deletedPatientsQuery,
  loadAllDeletedPatients,
  loadDeletedPatientsPage,
  type DeletedPatientRow,
} from "./deleted-patients";
import { REPORT_EXPORT_MAX_ROWS } from "./paging";

const rows: DeletedPatientRow[] = [
  {
    id: "p1",
    drm_id: "DRM-1",
    first_name: "Ana",
    middle_name: null,
    last_name: "Cruz",
    deleted_at: "2026-09-01T00:00:00+08:00",
    deleted_by_name: "Ian Jamila",
    delete_reason: "duplicate",
    delete_note: null,
  },
  {
    id: "p2",
    drm_id: "DRM-2",
    first_name: "Bea",
    middle_name: "M",
    last_name: "Dee",
    deleted_at: "2026-09-05T00:00:00+08:00",
    deleted_by_name: null,
    delete_reason: "other",
    delete_note: "requested by patient's guardian",
  },
];

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

describe("query shape", () => {
  it("reads v_patients_directory_admin, filters to deleted rows, orders by the requested column with an id tie-break", async () => {
    const { client, requests } = mockClient(() => response(rows, rows.length));
    await loadDeletedPatientsPage(client, {
      sort: { key: "deleted_at", dir: "desc" },
      from: 0,
      to: 9,
    });
    expect(requests).toHaveLength(1);
    const { url, init } = requests[0];
    expect(url.pathname).toBe("/rest/v1/v_patients_directory_admin");
    expect(url.searchParams.get("deleted_at")).toBe("not.is.null");
    expect(url.searchParams.get("order")).toBe("deleted_at.desc.nullslast,id.asc");
    expect(new Headers(init?.headers).get("Prefer")).toBe("count=exact");
  });

  const sorts = DELETED_SORTABLE;
  it.each(sorts)("%s: both directions keep the SAME ascending id tie-break", async (key) => {
    const { client, requests } = mockClient(() => response([], 0));
    for (const dir of ["asc", "desc"] as const) {
      await deletedPatientsQuery(client, { key, dir })
        .range(0, 9)
        .returns<DeletedPatientRow[]>();
    }
    expect(requests.map(({ url }) => url.searchParams.get("order"))).toEqual([
      `${key}.asc.nullslast,id.asc`,
      `${key}.desc.nullslast,id.asc`,
    ]);
  });
});

describe("loadDeletedPatientsPage", () => {
  it("returns the exact total, not the page length", async () => {
    const { client } = mockClient(() => response([rows[0]], 137));
    const result = await loadDeletedPatientsPage(client, {
      sort: { key: "deleted_at", dir: "desc" },
      from: 0,
      to: 24,
    });
    expect(result).toEqual({ rows: [rows[0]], total: 137, error: null });
  });

  it("returns a message instead of throwing on a database error", async () => {
    const { client } = mockClient(() =>
      response({ message: "permission denied", code: "42501" }, undefined, 403),
    );
    const result = await loadDeletedPatientsPage(client, {
      sort: { key: "deleted_at", dir: "desc" },
      from: 0,
      to: 24,
    });
    expect(result).toEqual({ rows: [], total: 0, error: "permission denied" });
  });
});

describe("loadAllDeletedPatients (CSV)", () => {
  it("walks past 1000 rows up to the export ceiling", async () => {
    const population = REPORT_EXPORT_MAX_ROWS + 5;
    const { client } = mockClient((url) => {
      const from = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit"));
      return response(
        Array.from(
          { length: Math.max(0, Math.min(limit, population - from)) },
          (_, i) => ({ ...rows[0], id: String(from + i) }),
        ),
      );
    });
    const result = await loadAllDeletedPatients(
      client,
      { key: "deleted_at", dir: "desc" },
      REPORT_EXPORT_MAX_ROWS,
    );
    expect(result.rows).toHaveLength(REPORT_EXPORT_MAX_ROWS);
    expect(result.truncated).toBe(true);
  });

  it("is not truncated when the set fits under the ceiling", async () => {
    const { client } = mockClient(() => response(rows));
    const result = await loadAllDeletedPatients(
      client,
      { key: "deleted_at", dir: "desc" },
      REPORT_EXPORT_MAX_ROWS,
    );
    expect(result.rows).toEqual(rows);
    expect(result.truncated).toBe(false);
  });
});

describe("deletedPatientsCsvRows", () => {
  const kept = new Map<string, KeptCounts>([
    ["p1", { visits: 3, payments: 2, appointments: 1, consents: 1 }],
  ]);

  it("has a fixed header row", () => {
    const [header] = deletedPatientsCsvRows([], kept);
    expect(header).toEqual([
      "DRM-ID",
      "Last name",
      "First name",
      "Middle name",
      "Deleted on",
      "Deleted by",
      "Reason",
      "Note",
      "Visits",
      "Payments",
      "Appointments",
      "Consent records",
    ]);
  });

  it("renders the human reason label, not the raw enum code", () => {
    const [, row1, row2] = deletedPatientsCsvRows(rows, kept);
    expect(row1[6]).toBe("Duplicate record");
    expect(row2[6]).toBe("Other");
  });

  it("zero-fills kept counts for a patient with no entry in the map", () => {
    const [, , row2] = deletedPatientsCsvRows(rows, kept);
    // rows[1] ("p2") has no entry in `kept` above.
    expect(row2.slice(-4)).toEqual([0, 0, 0, 0]);
    const [, row1] = deletedPatientsCsvRows(rows, kept);
    expect(row1.slice(-4)).toEqual([3, 2, 1, 1]);
  });

  it("carries the free-text note through, blank when none", () => {
    const [, row1, row2] = deletedPatientsCsvRows(rows, kept);
    expect(row1[7]).toBe("");
    expect(row2[7]).toBe("requested by patient's guardian");
  });
});

describe("deletedPatientsCsvFilename", () => {
  it("stamps the filename with the given Manila day", () => {
    expect(deletedPatientsCsvFilename("2026-09-25")).toBe(
      "deleted-patients-2026-09-25.csv",
    );
  });
});
