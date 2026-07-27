import { describe, expect, it } from "vitest";
import {
  LAB_QUEUE_GATE_VISITS_OR,
  labQueueGate,
  type LabGateVisitShape,
} from "./lab-gate";

function visit(overrides: Partial<LabGateVisitShape> = {}): LabGateVisitShape {
  return {
    payment_status: "unpaid",
    hmo_provider_id: null,
    ...overrides,
  };
}

describe("labQueueGate", () => {
  it("passes a fully paid visit", () => {
    expect(labQueueGate(visit({ payment_status: "paid" })).ok).toBe(true);
  });

  it("passes a waived visit — same statuses the release trigger accepts", () => {
    expect(labQueueGate(visit({ payment_status: "waived" })).ok).toBe(true);
  });

  it("passes an HMO-billed visit regardless of payment status", () => {
    for (const payment_status of ["unpaid", "partial", "paid", "waived"]) {
      const v = visit({
        payment_status,
        hmo_provider_id: "3a5c8d0e-0000-0000-0000-000000000001",
      });
      expect(labQueueGate(v).ok).toBe(true);
    }
  });

  it("blocks an unpaid cash visit", () => {
    const gate = labQueueGate(visit());
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.reason).toBe("waiting_for_payment");
      expect(gate.hint).toMatch(/paid|HMO/);
    }
  });

  it("blocks a partially paid cash visit — the gate is paid-in-full", () => {
    const gate = labQueueGate(visit({ payment_status: "partial" }));
    expect(gate).toMatchObject({ ok: false, reason: "waiting_for_payment" });
  });
});

describe("LAB_QUEUE_GATE_VISITS_OR", () => {
  // The PostgREST filter string must encode exactly the predicate
  // labQueueGate() implements — they ship as a pair.
  it("names both passing payment statuses and the HMO carve-out", () => {
    expect(LAB_QUEUE_GATE_VISITS_OR).toBe(
      "payment_status.in.(paid,waived),hmo_provider_id.not.is.null",
    );
  });
});
