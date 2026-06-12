import { describe, it, expect } from "vitest";
import {
  visitStage,
  isOutstandingLabImaging,
  outstandingLabImagingNames,
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

describe("visitStage", () => {
  it("unpaid → waiting, regardless of tests", () => {
    expect(visitStage("unpaid", [test()])).toBe("waiting");
    expect(visitStage("unpaid", [])).toBe("waiting");
  });

  it("partial → waiting", () => {
    expect(visitStage("partial", [test({ status: "released" })])).toBe(
      "waiting",
    );
  });

  it("paid with an outstanding lab test → processing", () => {
    expect(visitStage("paid", [test({ status: "in_progress" })])).toBe(
      "processing",
    );
  });

  it("paid with an outstanding imaging test → processing", () => {
    expect(
      visitStage("paid", [test({ section: "imaging_xray", status: "requested" })]),
    ).toBe("processing");
  });

  it("waived behaves like paid → processing when lab outstanding", () => {
    expect(visitStage("waived", [test({ status: "requested" })])).toBe(
      "processing",
    );
  });

  it("paid with only released/cancelled lab tests → completed", () => {
    expect(
      visitStage("paid", [
        test({ status: "released" }),
        test({ section: "imaging_ultrasound", status: "cancelled" }),
      ]),
    ).toBe("completed");
  });

  it("consult-only paid visit → completed (consult isn't lab/imaging)", () => {
    expect(
      visitStage("paid", [
        test({ section: "consultation", status: "requested", name: "Consult" }),
      ]),
    ).toBe("completed");
  });

  it("paid visit with no tests → completed", () => {
    expect(visitStage("paid", [])).toBe("completed");
  });

  it("package header alone does not hold a visit in processing", () => {
    expect(
      visitStage("paid", [
        test({ is_package_header: true, section: "package", status: "requested" }),
      ]),
    ).toBe("completed");
  });

  it("package header outstanding but its lab component outstanding → processing", () => {
    expect(
      visitStage("paid", [
        test({ is_package_header: true, section: "package", status: "requested" }),
        test({ section: "hematology", status: "requested", name: "Platelet" }),
      ]),
    ).toBe("processing");
  });

  it("null-section test does not count as outstanding lab/imaging", () => {
    expect(
      visitStage("paid", [test({ section: null, status: "requested" })]),
    ).toBe("completed");
  });

  it("a released lab + an outstanding imaging → still processing", () => {
    expect(
      visitStage("paid", [
        test({ status: "released" }),
        test({ section: "imaging_ecg", status: "result_uploaded", name: "ECG" }),
      ]),
    ).toBe("processing");
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
