// The strongest available test of the 0150 rewrite: wrapping and unwrapping are
// exact inverses, so `unwrap(wrap(x)) === x` for every policy expression.
//
// This matters because the two functions are written independently and used for
// opposite purposes — `wrapCalls` GENERATES the migration, `unwrapInitPlans` PROVES
// it inert. If they agreed by sharing a bug, the proof would be circular. Testing
// the round trip against real policy expressions pins them against each other on
// input neither was tuned for.
//
// Expressions below are copied verbatim from prod `pg_policies` (2026-09-16),
// including PostgREST's exact rendering — uppercase SELECT, `::text` casts,
// the whitespace. Hand-simplified inputs would not have caught the nested-subquery
// or already-wrapped cases.
import { describe, it, expect } from "vitest";
import { wrapCalls } from "./generate-rls-initplan-migration";
import { unwrapInitPlans } from "./rls-structural-prove";

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

// Real policy expressions from prod.
const REAL_EXPRESSIONS = [
  // visits: staff full / patients: staff full — the commonest shape, 130 policies.
  "has_role(ARRAY['reception'::text, 'medtech'::text, 'pathologist'::text, 'admin'::text, 'xray_technician'::text])",
  // services: admin all
  "has_role(ARRAY['admin'::text])",
  // patients: patient self select
  "(id = current_patient_id())",
  // visits: patient self select
  "(patient_id = current_patient_id())",
  // services: public read active — no helper call at all.
  "(is_active = true)",
  // test_requests: patient own visits — a correlated subquery that must survive intact.
  "(visit_id IN ( SELECT v.id\n   FROM visits v\n  WHERE (v.patient_id = current_patient_id())))",
  // payments: patient self select
  "(visit_id IN ( SELECT visits.id\n   FROM visits\n  WHERE (visits.patient_id = current_patient_id())))",
  // appointment_attachments: staff read — the is_staff() family the spec first missed.
  "is_staff()",
];

describe("wrapCalls / unwrapInitPlans round-trip", () => {
  for (const expr of REAL_EXPRESSIONS) {
    it(`round-trips: ${norm(expr).slice(0, 60)}`, () => {
      expect(norm(unwrapInitPlans(wrapCalls(expr)))).toBe(norm(expr));
    });
  }

  it("wrapCalls is idempotent on real expressions", () => {
    for (const expr of REAL_EXPRESSIONS) {
      const once = wrapCalls(expr);
      expect(norm(wrapCalls(once))).toBe(norm(once));
    }
  });

  it("actually wraps — the round-trip is not passing because nothing happened", () => {
    // Guards against the vacuous case: if wrapCalls were the identity function,
    // every test above would still pass. At least one expression must change.
    const changed = REAL_EXPRESSIONS.filter((e) => wrapCalls(e) !== e);
    expect(changed.length).toBeGreaterThanOrEqual(7);
  });

  it("leaves a correlated subquery's FROM clause intact", () => {
    const expr = REAL_EXPRESSIONS[5];
    const wrapped = wrapCalls(expr);
    // The patient helper inside gets wrapped...
    expect(wrapped).toContain("(select current_patient_id())");
    // ...but the enclosing `SELECT v.id FROM visits v` must NOT be unwrapped as if
    // it were an InitPlan wrapper, or the policy would be silently rewritten.
    expect(norm(unwrapInitPlans(wrapped))).toContain("FROM visits v");
  });
});
