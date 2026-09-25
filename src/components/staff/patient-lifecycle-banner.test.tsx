import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock("@/lib/actions/patients/lifecycle", () => ({
  restorePatientAction: vi.fn(),
}));

import { PatientLifecycleBanner } from "./patient-lifecycle-banner";
import type { PatientLifecycleDisplay } from "@/lib/patients/lifecycle-display";

const base: PatientLifecycleDisplay = {
  patientId: "patient-1",
  drmId: "DRM-0001",
  deletedAt: null,
  deletedByName: null,
  deleteReason: null,
  deleteNote: null,
  mergedIntoId: null,
  mergedIntoDrmId: null,
  mergedAt: null,
};

describe("PatientLifecycleBanner", () => {
  it("renders nothing for an active record", () => {
    expect(renderToStaticMarkup(<PatientLifecycleBanner lifecycle={base} isAdmin={true} />)).toBe("");
  });

  it("shows the merge banner and links to the surviving record, before checking deletedAt", () => {
    const html = renderToStaticMarkup(
      <PatientLifecycleBanner
        lifecycle={{ ...base, mergedIntoId: "patient-2", mergedIntoDrmId: "DRM-0002", mergedAt: "2026-09-20T00:00:00Z" }}
        isAdmin={true}
      />,
    );
    expect(html).toContain("merged into");
    expect(html).toContain('href="/staff/patients/patient-2"');
    expect(html).toContain("DRM-0002");
    // No restore button on a merged record — only a deleted one can be restored.
    expect(html).not.toContain("Restore");
  });

  it("shows the delete banner with reason and note, and the restore button for an admin", () => {
    const html = renderToStaticMarkup(
      <PatientLifecycleBanner
        lifecycle={{
          ...base,
          deletedAt: "2026-09-20T00:00:00Z",
          deletedByName: "Ana Cruz",
          deleteReason: "duplicate",
          deleteNote: "dup of DRM-0002",
        }}
        isAdmin={true}
      />,
    );
    expect(html).toContain("deleted on");
    expect(html).toContain("Ana Cruz");
    expect(html).toContain("Duplicate record");
    expect(html).toContain("dup of DRM-0002");
    expect(html).toContain("Restore");
  });

  it("hides the free-text note (and the restore button) for a non-admin viewer", () => {
    const html = renderToStaticMarkup(
      <PatientLifecycleBanner
        lifecycle={{
          ...base,
          deletedAt: "2026-09-20T00:00:00Z",
          deletedByName: "Ana Cruz",
          deleteReason: "duplicate",
          deleteNote: "dup of DRM-0002",
        }}
        isAdmin={false}
      />,
    );
    // Date, deleter and reason label still show.
    expect(html).toContain("deleted on");
    expect(html).toContain("Ana Cruz");
    expect(html).toContain("Duplicate record");
    // The free-text note is admin-only.
    expect(html).not.toContain("dup of DRM-0002");
    expect(html).not.toContain("Restore");
  });
});
