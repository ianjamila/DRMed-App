import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  hasOpenHmoClaim,
  testDeletability,
  visitDeletability,
  type TestDeleteShape,
  type VisitDeleteShape,
} from "./deletion";

function visit(overrides: Partial<VisitDeleteShape> = {}): VisitDeleteShape {
  return {
    payment_status: "unpaid",
    deleted_at: null,
    test_statuses: ["requested", "in_progress"],
    has_open_hmo_claim: false,
    ...overrides,
  };
}

function test_(overrides: Partial<TestDeleteShape> = {}): TestDeleteShape {
  return {
    status: "requested",
    deleted_at: null,
    parent_id: null,
    visit_payment_status: "unpaid",
    visit_deleted_at: null,
    has_open_hmo_claim: false,
    ...overrides,
  };
}

describe("visitDeletability", () => {
  it("allows reception and admin on an unpaid visit", () => {
    expect(visitDeletability("reception", visit()).ok).toBe(true);
    expect(visitDeletability("admin", visit()).ok).toBe(true);
  });

  it("blocks medtech and pathologist regardless of state", () => {
    for (const role of ["medtech", "pathologist", "xray_technician"]) {
      const d = visitDeletability(role, visit());
      expect(d).toMatchObject({ ok: false, reason: "role" });
    }
  });

  it("blocks partial and paid visits as has_payments (void-first flow)", () => {
    for (const status of ["partial", "paid"]) {
      const d = visitDeletability("admin", visit({ payment_status: status }));
      expect(d).toMatchObject({ ok: false, reason: "has_payments" });
    }
  });

  it("blocks waived visits with the dedicated reason", () => {
    expect(
      visitDeletability("admin", visit({ payment_status: "waived" })),
    ).toMatchObject({ ok: false, reason: "waived" });
  });

  it("blocks a visit that already has a released result", () => {
    expect(
      visitDeletability(
        "admin",
        visit({ test_statuses: ["released", "requested"] }),
      ),
    ).toMatchObject({ ok: false, reason: "released" });
  });

  it("blocks an already-deleted visit", () => {
    expect(
      visitDeletability("admin", visit({ deleted_at: "2026-07-27T00:00:00Z" })),
    ).toMatchObject({ ok: false, reason: "already_deleted" });
  });

  it("cancelled tests do not block deletion", () => {
    expect(
      visitDeletability("reception", visit({ test_statuses: ["cancelled"] })).ok,
    ).toBe(true);
  });
});

describe("testDeletability", () => {
  it("allows reception/admin on an unpaid standalone test or package header", () => {
    expect(testDeletability("reception", test_()).ok).toBe(true);
    expect(testDeletability("admin", test_()).ok).toBe(true);
  });

  it("blocks package components — whole package only", () => {
    expect(
      testDeletability("admin", test_({ parent_id: "some-header-id" })),
    ).toMatchObject({ ok: false, reason: "package_component" });
  });

  it("blocks released tests", () => {
    expect(
      testDeletability("admin", test_({ status: "released" })),
    ).toMatchObject({ ok: false, reason: "released" });
  });

  it("blocks when the visit has payments or is waived", () => {
    expect(
      testDeletability("admin", test_({ visit_payment_status: "partial" })),
    ).toMatchObject({ ok: false, reason: "has_payments" });
    expect(
      testDeletability("admin", test_({ visit_payment_status: "waived" })),
    ).toMatchObject({ ok: false, reason: "waived" });
  });

  it("treats a test on a deleted visit as already deleted", () => {
    expect(
      testDeletability(
        "reception",
        test_({ visit_deleted_at: "2026-07-27T00:00:00Z" }),
      ),
    ).toMatchObject({ ok: false, reason: "already_deleted" });
  });

  it("blocks non-reception/admin roles", () => {
    expect(testDeletability("medtech", test_())).toMatchObject({
      ok: false,
      reason: "role",
    });
  });
});

// ---------------------------------------------------------------------------
// 0147 / P0050 — money already claimed from an HMO
// ---------------------------------------------------------------------------

describe("open HMO claims block deletion", () => {
  it("blocks a visit whose money is already claimed", () => {
    const got = visitDeletability("reception", visit({ has_open_hmo_claim: true }));
    expect(got).toEqual({
      ok: false,
      reason: "hmo_claimed",
      hint: "Already claimed from an HMO — void the claim batch first.",
    });
  });

  it("blocks a line whose money is already claimed", () => {
    const got = testDeletability("reception", test_({ has_open_hmo_claim: true }));
    expect(got.ok).toBe(false);
    expect(got.ok === false && got.reason).toBe("hmo_claimed");
  });

  it("is reachable on an unreleased line — the undo-release path", () => {
    // The case the guard exists for: the line was released and claimed, the
    // release was undone (0110 does not touch hmo_claim_items), and 0133 keeps
    // an HMO visit 'unpaid' forever — so nothing else blocks the delete.
    const got = testDeletability(
      "reception",
      test_({
        status: "ready_for_release",
        visit_payment_status: "unpaid",
        has_open_hmo_claim: true,
      }),
    );
    expect(got.ok === false && got.reason).toBe("hmo_claimed");
  });

  it("still reports 'released' first — the trigger checks that first too", () => {
    const got = testDeletability(
      "reception",
      test_({ status: "released", has_open_hmo_claim: true }),
    );
    expect(got.ok === false && got.reason).toBe("released");
  });

  it("reports the claim before the generic not-unpaid reason", () => {
    // Mirrors the trigger's order, so the hint names the real obstacle.
    const got = testDeletability(
      "reception",
      test_({ visit_payment_status: "partial", has_open_hmo_claim: true }),
    );
    expect(got.ok === false && got.reason).toBe("hmo_claimed");
  });

  it("a voided claim batch does not block anything", () => {
    expect(visitDeletability("reception", visit({ has_open_hmo_claim: false })).ok).toBe(true);
    expect(testDeletability("reception", test_({ has_open_hmo_claim: false })).ok).toBe(true);
  });
});

describe("hasOpenHmoClaim", () => {
  it("is false for no embed, a null embed and an empty one", () => {
    expect(hasOpenHmoClaim(undefined)).toBe(false);
    expect(hasOpenHmoClaim(null)).toBe(false);
    expect(hasOpenHmoClaim([])).toBe(false);
  });

  it("is false when every batch is voided", () => {
    expect(hasOpenHmoClaim([{ batch_voided: true }, { batch_voided: true }])).toBe(false);
  });

  it("is true when any batch is still open", () => {
    expect(hasOpenHmoClaim([{ batch_voided: true }, { batch_voided: false }])).toBe(true);
  });
});

describe("migration 0147 — the DB delete guard encodes the same rule", () => {
  // The triggers are the source of truth; visitDeletability/testDeletability
  // are only the UX mirror, deciding whether to render a delete affordance at
  // all. Edit one without the other and staff get a button that throws. There
  // is no pgTAP runner in `npm test`, so pin the SQL text.
  const sql = readFileSync(
    join(process.cwd(), "supabase/migrations/0147_hmo_claim_delete_guard.sql"),
    "utf8",
  );

  it("replaces both 0125 guard functions", () => {
    expect(sql).toMatch(/create or replace function public\.enforce_deletable_visit\(\)/);
    expect(sql).toMatch(
      /create or replace function public\.enforce_deletable_test_request\(\)/,
    );
  });

  it("raises P0050 on each of them", () => {
    expect(sql.match(/errcode = 'P0050'/g)).toHaveLength(2);
  });

  it("treats only a non-voided claim item as blocking", () => {
    expect(sql.match(/not ci\.batch_voided/g)).toHaveLength(2);
  });

  it("reaches the visit's claims through test_requests — a visit delete does not cascade", () => {
    expect(sql).toMatch(
      /join public\.test_requests tr on tr\.id = ci\.test_request_id\s+where tr\.visit_id = new\.id/,
    );
  });

  it("does NOT filter tr.deleted_at — an open claim on a deleted line still counts", () => {
    const visitGuard = sql.slice(
      sql.indexOf("enforce_deletable_visit"),
      sql.indexOf("enforce_deletable_test_request"),
    );
    const claimCheck = visitGuard.slice(visitGuard.indexOf("hmo_claim_items"));
    expect(claimCheck).not.toMatch(/tr\.deleted_at/);
  });

  it("keeps every guard 0125 already had", () => {
    for (const code of ["P0042", "P0043", "P0044"]) {
      expect(sql).toMatch(new RegExp(`errcode = '${code}'`));
    }
    // The package-component rule is the subtle one: losing the depth test
    // would let a direct component delete through.
    expect(sql).toMatch(/old\.parent_id is not null and pg_trigger_depth\(\) <= 1/);
    // And the restore path must stay unguarded on both functions.
    expect(
      sql.match(/if not \(old\.deleted_at is null and new\.deleted_at is not null\) then/g),
    ).toHaveLength(2);
  });

  it("restates both function ACLs and keeps search_path pinned", () => {
    expect(sql).toMatch(
      /revoke all on function public\.enforce_deletable_visit\(\) from public, anon, authenticated;/,
    );
    expect(sql).toMatch(
      /revoke all on function public\.enforce_deletable_test_request\(\) from public, anon, authenticated;/,
    );
    expect(sql.match(/set search_path = public/g)).toHaveLength(2);
  });

  it("has a user-facing translation for P0050", () => {
    const pgErrors = readFileSync(
      join(process.cwd(), "src/lib/accounting/pg-errors.ts"),
      "utf8",
    );
    expect(pgErrors).toMatch(/case "P0050":/);
  });
});
