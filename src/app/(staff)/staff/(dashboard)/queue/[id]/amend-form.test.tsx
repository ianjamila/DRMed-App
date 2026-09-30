// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({
  amendResultAction: vi.fn(),
  amendStructuredResultAction: vi.fn(),
  finaliseStructuredAction: vi.fn(),
  saveDraftAction: vi.fn(),
}));

import { amendResultAction, amendStructuredResultAction } from "./actions";
import { AmendResultForm } from "./amend-form";
import type { ParamValue, TemplateParam } from "@/lib/results/types";

// Same shape as the consolidated report edit (X2): each save revalidates the
// page, so the new amendment_count arrives with the response. The edit forms
// are keyed by that count — a form seeded from old values must never send a
// newer count (it would dodge P0065 and overwrite someone else's edit), and a
// refresh from elsewhere on the page (reassign, unclaim) resets an open form
// instead. The success message lives in AmendResultForm, above the key, and
// replaces the form so the same reason + notice box can't be sent twice.
// A re-render with a newer count below stands in for that revalidation.

const FBS: TemplateParam = {
  id: "p1",
  sort_order: 1,
  section: null,
  is_section_header: false,
  parameter_name: "FBS",
  input_type: "numeric",
  unit_si: "mmol/L",
  unit_conv: "mg/dL",
  ref_low_si: 4.1,
  ref_high_si: 5.9,
  ref_low_conv: null,
  ref_high_conv: null,
  gender: null,
  si_to_conv_factor: null,
  allowed_values: null,
  abnormal_values: null,
  placeholder: null,
  ranges: [],
};

const value = (si: number): ParamValue => ({
  numeric_value_si: si,
  numeric_value_conv: null,
  text_value: null,
  select_value: null,
  flag: null,
  is_blank: false,
});

function structured(count: number, si: number) {
  return (
    <AmendResultForm
      testRequestId="t1"
      generationKind="structured"
      expectedAmendmentCount={count}
      notifyOffer={{ offered: true }}
      structured={{
        layout: "dual_unit",
        params: [FBS],
        patientSex: "F",
        patientAgeMonths: 480,
        initialValues: { p1: value(si) },
        currentImageFilename: null,
      }}
    />
  );
}

function uploaded(count: number) {
  return <AmendResultForm testRequestId="t1" generationKind="uploaded" expectedAmendmentCount={count} notifyOffer={{ offered: true }} />;
}

const firstNumber = () => document.querySelector<HTMLInputElement>("input[type=number]")!;
// jsdom reports a `required` file input as valueMissing even with a file
// attached, so a click on "Replace result" stops at its constraint check
// (a real browser passes it — verified 2026-09-28). Submit the form itself.
const replaceResult = () => fireEvent.submit(document.querySelector("#amend-file")!.closest("form")!);
const reasonBox = () => document.querySelector<HTMLTextAreaElement>("#amend-reason")!;

beforeEach(() => {
  vi.mocked(amendResultAction).mockReset();
  vi.mocked(amendStructuredResultAction).mockReset();
  router.refresh.mockReset();
});
afterEach(cleanup);

describe("single-test Edit result — structured values", () => {
  it("replaces the form with Saved, keeps it through the revalidation, and Done closes it", async () => {
    vi.mocked(amendStructuredResultAction).mockResolvedValue({ ok: true, resultId: "r1", controlNo: 7, notify: "not_set_up" });
    const user = userEvent.setup();
    const { rerender } = render(structured(1, 5.4));

    await user.click(screen.getByRole("button", { name: "Edit result…" }));
    expect(firstNumber().value).toBe("5.4");
    await user.clear(firstNumber());
    await user.type(firstNumber(), "9.9");
    await user.type(reasonBox(), "Glucose re-run");
    await user.click(screen.getByLabelText(/Let the patient know/));
    await user.click(screen.getByRole("button", { name: "Save amendment" }));

    const saved =
      "✓ Saved. Control No. 000007 — amended. No patient notice was sent — email and text notices aren't set up here. They're on Result follow-ups.";
    expect((await screen.findByRole("status")).textContent).toBe(saved);
    const fd = vi.mocked(amendStructuredResultAction).mock.calls[0][1] as FormData;
    expect(fd.get("expected_amendment_count")).toBe("1");
    expect(fd.get("notify_patient")).toBe("on");
    expect(fd.get("reason")).toBe("Glucose re-run");
    // Nothing left to submit a second time.
    expect(screen.queryByRole("button", { name: "Save amendment" })).toBeNull();

    rerender(structured(2, 9.9)); // the save's revalidation lands
    expect(screen.getByRole("status").textContent).toBe(saved);

    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "Edit result…" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Edit result…" }));
    expect(firstNumber().value).toBe("9.9");
    expect(reasonBox().value).toBe("");
  });

  it("a newer version arriving mid-edit resets the form to it, so old values can't save over it", async () => {
    const user = userEvent.setup();
    const { rerender } = render(structured(1, 5.4));
    await user.click(screen.getByRole("button", { name: "Edit result…" }));
    await user.type(reasonBox(), "half-typed reason");

    rerender(structured(2, 7.7)); // e.g. a reassign refresh after someone else's edit

    expect(firstNumber().value).toBe("7.7");
    expect(reasonBox().value).toBe("");
  });
});

describe("single-test Edit result — replace the PDF", () => {
  it("replaces the form with Result replaced, and Done closes it", async () => {
    vi.mocked(amendResultAction).mockResolvedValue({ ok: true, notify: "sent" });
    const user = userEvent.setup();
    const { rerender } = render(uploaded(1));

    await user.click(screen.getByRole("button", { name: "Edit result…" }));
    await user.upload(
      document.querySelector<HTMLInputElement>("#amend-file")!,
      new File(["%PDF-1.4"], "corrected.pdf", { type: "application/pdf" }),
    );
    await user.type(reasonBox(), "Wrong unit on glucose");
    await user.click(screen.getByLabelText(/Let the patient know/));
    replaceResult();

    const saved = "Result replaced. The patient was sent an update notice.";
    expect((await screen.findByRole("status")).textContent).toBe(saved);
    const fd = vi.mocked(amendResultAction).mock.calls[0][1] as FormData;
    expect(fd.get("expected_amendment_count")).toBe("1");
    expect(fd.get("notify_patient")).toBe("on");
    expect(screen.queryByRole("button", { name: "Replace result" })).toBeNull();

    rerender(uploaded(2));
    expect(screen.getByRole("status").textContent).toBe(saved);
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.getByRole("button", { name: "Edit result…" })).toBeTruthy();
  });

  it("a refused replace keeps the form open and shows why", async () => {
    vi.mocked(amendResultAction).mockResolvedValue({ ok: false, error: "Someone else edited this result." });
    const user = userEvent.setup();
    render(uploaded(1));
    await user.click(screen.getByRole("button", { name: "Edit result…" }));
    await user.upload(
      document.querySelector<HTMLInputElement>("#amend-file")!,
      new File(["%PDF-1.4"], "corrected.pdf", { type: "application/pdf" }),
    );
    await user.type(reasonBox(), "Wrong unit on glucose");
    // Record every committed screen from submit to the refusal. The refusal
    // once committed one render before the button left "Amending…", so under
    // full-suite load the button query below could land in that gap (flake).
    const screens: string[] = [];
    const observer = new MutationObserver(() => {
      const shown = document.querySelector("[role=alert]") ? "refusal" : "no refusal";
      screens.push(`${shown} / ${document.querySelector("button[type=submit]")?.textContent}`);
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    replaceResult();

    expect((await screen.findByRole("alert")).textContent).toBe("Someone else edited this result.");
    observer.disconnect();
    expect(screens).not.toContain("refusal / Amending…");
    expect(screen.getByRole("button", { name: "Replace result" })).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
