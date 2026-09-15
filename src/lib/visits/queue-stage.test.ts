import { describe, it, expect } from "vitest";
import {
  visitStage,
  isOutstandingLabImaging,
  outstandingLabImagingNames,
  releasedLabImagingNames,
  type QueueTestLike,
} from "./queue-stage";

function test(overrides: Partial<QueueTestLike> = {}): QueueTestLike {
  return {
    status: "requested",
    is_package_header: false,
    section: "chemistry",
    name: "CBC",
    ...overrides,
  };
}

// visitStage now takes a visit-like object (payment_status + hmo_provider_id)
// rather than a bare payment status string, so it can delegate to the shared
// moneySettled() predicate.
function visit(
  paymentStatus: string,
  hmoProviderId: string | null = null,
): { payment_status: string; hmo_provider_id: string | null } {
  return { payment_status: paymentStatus, hmo_provider_id: hmoProviderId };
}

describe("visitStage", () => {
  it("unpaid → waiting, regardless of tests", () => {
    expect(visitStage(visit("unpaid"), [test()])).toBe("waiting");
    expect(visitStage(visit("unpaid"), [])).toBe("waiting");
  });

  it("partial → waiting", () => {
    expect(
      visitStage(visit("partial"), [test({ status: "released" })]),
    ).toBe("waiting");
  });

  it("paid with an outstanding lab test → processing", () => {
    expect(
      visitStage(visit("paid"), [test({ status: "in_progress" })]),
    ).toBe("processing");
  });

  it("paid with an outstanding imaging test → processing", () => {
    expect(
      visitStage(visit("paid"), [
        test({ section: "imaging_xray", status: "requested" }),
      ]),
    ).toBe("processing");
  });

  it("waived behaves like paid → processing when lab outstanding", () => {
    expect(
      visitStage(visit("waived"), [test({ status: "requested" })]),
    ).toBe("processing");
  });

  it("paid with only released/cancelled lab tests → completed", () => {
    expect(
      visitStage(visit("paid"), [
        test({ status: "released" }),
        test({ section: "imaging_ultrasound", status: "cancelled" }),
      ]),
    ).toBe("completed");
  });

  it("consult-only paid visit → completed (consult isn't lab/imaging)", () => {
    expect(
      visitStage(visit("paid"), [
        test({ section: "consultation", status: "requested", name: "Consult" }),
      ]),
    ).toBe("completed");
  });

  it("paid visit with no tests → completed", () => {
    expect(visitStage(visit("paid"), [])).toBe("completed");
  });

  it("package header alone does not hold a visit in processing", () => {
    expect(
      visitStage(visit("paid"), [
        test({ is_package_header: true, section: "package", status: "requested" }),
      ]),
    ).toBe("completed");
  });

  it("package header outstanding but its lab component outstanding → processing", () => {
    expect(
      visitStage(visit("paid"), [
        test({ is_package_header: true, section: "package", status: "requested" }),
        test({ section: "hematology", status: "requested", name: "Platelet" }),
      ]),
    ).toBe("processing");
  });

  it("null-section test does not count as outstanding lab/imaging", () => {
    expect(
      visitStage(visit("paid"), [test({ section: null, status: "requested" })]),
    ).toBe("completed");
  });

  it("a released lab + an outstanding imaging → still processing", () => {
    expect(
      visitStage(visit("paid"), [
        test({ status: "released" }),
        test({ section: "imaging_ecg", status: "result_uploaded", name: "ECG" }),
      ]),
    ).toBe("processing");
  });

  // HMO carve-out (owner decision 2026-09-15): an HMO visit's receivable
  // belongs to the insurer and is booked at release, not collected at the
  // counter, so it never sits in "waiting" regardless of payment_status.
  describe("HMO visits never wait for payment", () => {
    const HMO_PROVIDER_ID = "provider-123";

    it.each(["unpaid", "partial", "paid", "waived"])(
      "hmo visit with payment_status=%s never lands in waiting",
      (paymentStatus) => {
        expect(
          visitStage(visit(paymentStatus, HMO_PROVIDER_ID), [test()]),
        ).not.toBe("waiting");
      },
    );

    it("hmo visit with outstanding lab/imaging → processing", () => {
      expect(
        visitStage(visit("unpaid", HMO_PROVIDER_ID), [
          test({ status: "requested" }),
        ]),
      ).toBe("processing");
    });

    it("hmo visit with nothing outstanding → completed", () => {
      expect(
        visitStage(visit("unpaid", HMO_PROVIDER_ID), [
          test({ status: "released" }),
        ]),
      ).toBe("completed");
    });
  });

  it("regression guard: a non-HMO unpaid visit is still waiting", () => {
    expect(visitStage(visit("unpaid", null), [test()])).toBe("waiting");
  });
});

describe("isOutstandingLabImaging", () => {
  it("skips package headers", () => {
    expect(
      isOutstandingLabImaging(test({ is_package_header: true })),
    ).toBe(false);
  });

  it("skips terminal statuses", () => {
    expect(isOutstandingLabImaging(test({ status: "released" }))).toBe(false);
    expect(isOutstandingLabImaging(test({ status: "cancelled" }))).toBe(false);
  });

  it("counts a non-terminal lab/imaging leaf", () => {
    expect(isOutstandingLabImaging(test({ status: "ready_for_release" }))).toBe(
      true,
    );
  });

  it("ignores non-lab sections and null sections", () => {
    expect(isOutstandingLabImaging(test({ section: "procedure" }))).toBe(false);
    expect(isOutstandingLabImaging(test({ section: "vaccine" }))).toBe(false);
    expect(isOutstandingLabImaging(test({ section: null }))).toBe(false);
  });
});

describe("outstandingLabImagingNames", () => {
  it("returns only the outstanding lab/imaging test names", () => {
    const names = outstandingLabImagingNames([
      test({ name: "CBC", status: "requested" }),
      test({ name: "Chest X-ray", section: "imaging_xray", status: "in_progress" }),
      test({ name: "Lipid", status: "released" }), // terminal — excluded
      test({ name: "Consult", section: "consultation", status: "requested" }), // not lab
    ]);
    expect(names).toEqual(["CBC", "Chest X-ray"]);
  });

  it("falls back to a dash when a name is missing", () => {
    expect(
      outstandingLabImagingNames([test({ name: null, status: "requested" })]),
    ).toEqual(["—"]);
  });
});

describe("releasedLabImagingNames", () => {
  it("returns only released leaf lab/imaging test names", () => {
    const names = releasedLabImagingNames([
      test({ name: "CBC", status: "released" }),
      test({ name: "Chest X-ray", section: "imaging_xray", status: "released" }),
      test({ name: "FBS", status: "ready_for_release" }), // not yet released
      test({
        name: "ROUTINE PACKAGE",
        is_package_header: true,
        section: "package",
        status: "released",
      }), // header — excluded
      test({ name: "Consult", section: null, status: "released" }), // not lab/imaging
    ]);
    expect(names).toEqual(["CBC", "Chest X-ray"]);
  });

  it("does NOT count cancelled tests as released (terminal ≠ released)", () => {
    const names = releasedLabImagingNames([
      test({ name: "Urinalysis", status: "cancelled" }),
      test({ name: "CBC", status: "released" }),
    ]);
    expect(names).toEqual(["CBC"]);
  });

  it("falls back to a dash when a name is missing", () => {
    expect(
      releasedLabImagingNames([test({ name: null, status: "released" })]),
    ).toEqual(["—"]);
  });
});
