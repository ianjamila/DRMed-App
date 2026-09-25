import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/actions/patients/lifecycle", () => ({
  previewPatientDeleteAction: vi.fn(),
  deletePatientAction: vi.fn(),
  restorePatientAction: vi.fn(),
}));

import { PatientDeleteButton, canConfirmDelete } from "./patient-delete-button";

describe("PatientDeleteButton (initial static render)", () => {
  it("renders the trigger button and no dialog until opened", () => {
    const html = renderToStaticMarkup(<PatientDeleteButton patientId="patient-1" drmId="DRM-0001" />);
    expect(html).toContain("Delete patient");
    // ConfirmDialog returns null while `open` is false (useState default).
    expect(html).not.toContain('role="dialog"');
  });
});

// canConfirmDelete is the pure gate behind the dialog's confirm button.
// renderToStaticMarkup can't drive the click that opens the dialog or sets
// state, so the confirm-disabled matrix is unit tested directly here instead
// (see the component's doc comment).
describe("canConfirmDelete", () => {
  const ready = { loading: false, hasPreview: true, blockerCount: 0, reason: "duplicate" as const, noteLength: 0 };

  it("is disabled while the preview is loading", () => {
    expect(canConfirmDelete({ ...ready, loading: true })).toBe(false);
  });

  it("is disabled before the preview has loaded", () => {
    expect(canConfirmDelete({ ...ready, hasPreview: false })).toBe(false);
  });

  it("is disabled while any blocker is open", () => {
    expect(canConfirmDelete({ ...ready, blockerCount: 1 })).toBe(false);
  });

  it("is disabled with no reason chosen", () => {
    expect(canConfirmDelete({ ...ready, reason: "" })).toBe(false);
  });

  it("is disabled for reason 'other' with no note", () => {
    expect(canConfirmDelete({ ...ready, reason: "other", noteLength: 0 })).toBe(false);
  });

  it("is enabled for reason 'other' once a note is present", () => {
    expect(canConfirmDelete({ ...ready, reason: "other", noteLength: 5 })).toBe(true);
  });

  it("is enabled for a valid non-'other' reason with a loaded, blocker-free preview", () => {
    expect(canConfirmDelete(ready)).toBe(true);
  });
});
