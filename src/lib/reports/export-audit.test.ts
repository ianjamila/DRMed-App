import { describe, expect, it, vi } from "vitest";
import {
  HMO_EXPORT_REPORT_KEYS,
  HmoExportAuditSchema,
  recordHmoExportAudit,
  reportExportedAction,
  reportExportMetadata,
  type HmoExportAuditDeps,
} from "./export-audit";
import { REPORT_EXPORT_MAX_ROWS } from "./paging";

describe("reportExportedAction", () => {
  it("spells the house action name", () => {
    expect(reportExportedAction("lab_tat")).toBe("report.lab_tat.exported");
  });
});

describe("reportExportMetadata", () => {
  it("carries the filters alongside the count and the truncation flag", () => {
    expect(
      reportExportMetadata({
        report: "daily_revenue",
        filters: { from: "2026-09-01", to: "2026-09-30" },
        rowsExported: 42,
        truncated: false,
      }),
    ).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
      report: "daily_revenue",
      rows_exported: 42,
      truncated: false,
    });
  });

  it("never lets a filter key overwrite the report identifier", () => {
    // The whole point of the row is to say WHICH report was exported, so a
    // loader that happens to have a `report` filter must not win.
    const meta = reportExportMetadata({
      report: "daily_revenue",
      filters: { report: "something_else" },
      rowsExported: 1,
      truncated: true,
    });
    expect(meta.report).toBe("daily_revenue");
  });
});

describe("HmoExportAuditSchema", () => {
  const valid = {
    report: "hmo_unbilled",
    rows_exported: 12,
    truncated: false,
    kind: "lab",
    search: "acme",
  };

  it("accepts a well-formed payload", () => {
    expect(HmoExportAuditSchema.safeParse(valid).success).toBe(true);
  });

  it("covers both HMO exports and nothing else", () => {
    expect([...HMO_EXPORT_REPORT_KEYS]).toEqual(["hmo_unbilled", "hmo_aging"]);
    for (const report of HMO_EXPORT_REPORT_KEYS) {
      expect(HmoExportAuditSchema.safeParse({ ...valid, report }).success).toBe(true);
    }
  });

  // A "use server" export is a callable endpoint whether or not client code
  // references it, so a forged payload must not reach audit_log.
  it.each([
    ["an invented report", { report: "patients" }],
    ["an unknown claim kind", { kind: "everything" }],
    ["a negative row count", { rows_exported: -1 }],
    ["a fractional row count", { rows_exported: 1.5 }],
    ["a count past the export ceiling", { rows_exported: REPORT_EXPORT_MAX_ROWS + 1 }],
    ["an unbounded search string", { search: "x".repeat(201) }],
    ["a non-boolean truncated flag", { truncated: "yes" }],
  ])("rejects %s", (_label, patch) => {
    expect(HmoExportAuditSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });

  it("accepts a count exactly at the ceiling", () => {
    expect(
      HmoExportAuditSchema.safeParse({ ...valid, rows_exported: REPORT_EXPORT_MAX_ROWS })
        .success,
    ).toBe(true);
  });
});

describe("recordHmoExportAudit", () => {
  function deps() {
    const audit = vi.fn<HmoExportAuditDeps["audit"]>(async () => {});
    const ipAndAgent = vi.fn<HmoExportAuditDeps["ipAndAgent"]>(async () => ({
      ip: "203.0.113.9",
      ua: "Chrome",
    }));
    return { audit, ipAndAgent } satisfies HmoExportAuditDeps;
  }

  it("writes the same row shape a Route Handler export would", async () => {
    const d = deps();
    await recordHmoExportAudit(d, {
      actorId: "staff-1",
      audit: {
        report: "hmo_aging",
        rows_exported: 7,
        truncated: true,
        kind: "doctor",
        search: "cruz",
      },
    });
    expect(d.audit).toHaveBeenCalledTimes(1);
    expect(d.audit).toHaveBeenCalledWith({
      actor_id: "staff-1",
      actor_type: "staff",
      action: "report.hmo_aging.exported",
      resource_type: "report",
      resource_id: null,
      metadata: {
        kind: "doctor",
        search: "cruz",
        report: "hmo_aging",
        rows_exported: 7,
        truncated: true,
      },
      ip_address: "203.0.113.9",
      user_agent: "Chrome",
    });
  });

  it("records the request origin, which is the half the client cannot assert", async () => {
    const d = deps();
    d.ipAndAgent.mockResolvedValue({ ip: null, ua: null });
    await recordHmoExportAudit(d, {
      actorId: "staff-2",
      audit: {
        report: "hmo_unbilled",
        rows_exported: 0,
        truncated: false,
        kind: "all",
        search: "",
      },
    });
    expect(d.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        actor_id: "staff-2",
        ip_address: null,
        user_agent: null,
        action: "report.hmo_unbilled.exported",
      }),
    );
  });
});
