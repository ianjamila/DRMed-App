import { describe, it, expect } from "vitest";
import { wrapCalls } from "./generate-rls-initplan-migration";

describe("wrapCalls", () => {
  it("wraps a bare has_role with an array argument", () => {
    expect(wrapCalls("has_role(ARRAY['reception','admin'])"))
      .toBe("(select has_role(ARRAY['reception','admin']))");
  });

  it("wraps a zero-argument helper", () => {
    expect(wrapCalls("is_staff()")).toBe("(select is_staff())");
  });

  it("wraps inside a larger boolean expression", () => {
    expect(wrapCalls("(is_active = true) OR has_role(ARRAY['admin'])"))
      .toBe("(is_active = true) OR (select has_role(ARRAY['admin']))");
  });

  it("is idempotent — an already-wrapped call is left alone", () => {
    const wrapped = "(select has_role(ARRAY['admin']))";
    expect(wrapCalls(wrapped)).toBe(wrapped);
  });

  it("wraps current_patient_id in a comparison", () => {
    expect(wrapCalls("(patient_id = current_patient_id())"))
      .toBe("(patient_id = (select current_patient_id()))");
  });

  it("wraps a call nested inside a subquery", () => {
    expect(wrapCalls("(visit_id IN ( SELECT v.id FROM visits v WHERE (v.patient_id = current_patient_id())))"))
      .toBe("(visit_id IN ( SELECT v.id FROM visits v WHERE (v.patient_id = (select current_patient_id()))))");
  });

  it("wraps auth.uid()", () => {
    expect(wrapCalls("(id = auth.uid())")).toBe("(id = (select auth.uid()))");
  });

  it("does not match an identifier that merely ends in a helper name", () => {
    expect(wrapCalls("my_has_role(ARRAY['admin'])")).toBe("my_has_role(ARRAY['admin'])");
  });

  it("leaves an expression with no helper call untouched", () => {
    expect(wrapCalls("(is_active = true)")).toBe("(is_active = true)");
  });

  it("keeps wrappers idempotent across arbitrary whitespace and case", () => {
    const wrapped = "( SeLeCt\n             has_role(ARRAY['admin'])) AND (select\t is_staff())";
    expect(wrapCalls(wrapped)).toBe(wrapped);
  });

  it("wraps multiple helpers and remains idempotent", () => {
    const expr = "is_staff() AND staff_role() = 'admin' AND auth.role() = 'authenticated' AND auth.jwt() IS NOT NULL";
    const wrapped = "(select is_staff()) AND (select staff_role()) = 'admin' AND (select auth.role()) = 'authenticated' AND (select auth.jwt()) IS NOT NULL";
    expect(wrapCalls(expr)).toBe(wrapped);
    expect(wrapCalls(wrapped)).toBe(wrapped);
  });

  it("ignores parentheses in quoted arguments, including escaped quotes", () => {
    const expr = "has_role(ARRAY['admin)(''s'])";
    expect(wrapCalls(expr)).toBe(`(select ${expr})`);
  });

  it("rejects an unbalanced helper call", () => {
    expect(() => wrapCalls("has_role(ARRAY['admin']")).toThrow("unbalanced parens");
  });
});
