import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { InactivePatientBadge } from "./inactive-patient-badge";

// Row badge for results-archive / appointments list rows (0167): the row
// stays visible (history), but staff need to see at a glance why the patient
// no longer shows up in the directory.
describe("InactivePatientBadge", () => {
  it("renders nothing for an active patient", () => {
    expect(renderToStaticMarkup(<InactivePatientBadge deletedAt={null} mergedIntoId={null} />)).toBe("");
  });

  it("shows 'Deleted record' when deleted", () => {
    const html = renderToStaticMarkup(<InactivePatientBadge deletedAt="2026-09-20T00:00:00Z" mergedIntoId={null} />);
    expect(html).toContain("Deleted record");
    expect(html).not.toContain("Merged record");
  });

  it("shows 'Merged record' when merged, even if deletedAt is also set", () => {
    const html = renderToStaticMarkup(
      <InactivePatientBadge deletedAt="2026-09-20T00:00:00Z" mergedIntoId="patient-2" />,
    );
    expect(html).toContain("Merged record");
    expect(html).not.toContain("Deleted record");
  });
});
