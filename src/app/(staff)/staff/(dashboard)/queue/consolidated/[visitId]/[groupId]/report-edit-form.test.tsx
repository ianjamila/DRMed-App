import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => {}, refresh: () => {} }) }));
vi.mock("./actions", () => ({ amendConsolidated: vi.fn() }));

import { ReportEditForm } from "./report-edit-form";

// X2: saving an edit revalidates the page, and a revalidating Server Action
// ships the re-rendered route (with the bumped amendment_count) in its own
// response — no client refresh needed. The edit fields are keyed by that
// count so a form seeded from old values can never save over a newer
// version; the "Saved." panel therefore has to live ABOVE that key, or the
// remount wipes it (and the patient-notice outcome) ~0.2s after it appears.
// Browser-verified 2026-09-28; this pins the shape so the key can't drift
// back onto the component that holds the Saved state.
const DIR = join(process.cwd(), "src/app/(staff)/staff/(dashboard)/queue/consolidated/[visitId]/[groupId]");
const formSrc = readFileSync(join(DIR, "report-edit-form.tsx"), "utf8");
const pageSrc = readFileSync(join(DIR, "page.tsx"), "utf8");

describe("consolidated report edit — Saved panel survives the save's revalidation", () => {
  it("the page keys ReportEditForm by report only, never by version", () => {
    const usage = pageSrc.slice(pageSrc.indexOf("<ReportEditForm"));
    const key = usage.match(/key=\{([^}]*)\}/)?.[1];
    expect(key).toBe("editing.resultId");
  });

  it("the Saved state is held by ReportEditForm, and only the fields are keyed by version", () => {
    const outer = formSrc.slice(
      formSrc.indexOf("export function ReportEditForm("),
      formSrc.indexOf("function ReportEditFields("),
    );
    expect(outer).toContain("useState<SavedOutcome | null>(null)");
    expect(outer).toContain("key={`${props.resultId}:${props.expectedAmendmentCount}`}");
    const fields = formSrc.slice(formSrc.indexOf("function ReportEditFields("));
    expect(fields).not.toMatch(/useState<SavedOutcome/);
    expect(fields).toContain("onSaved({ notify: res.notify })");
    // A refresh from the save path would be redundant at best.
    expect(fields.slice(0, fields.indexOf("return ("))).not.toContain("router.refresh()");
  });

  it("renders the edit fields (not the Saved panel) until a save succeeds", () => {
    const html = renderToStaticMarkup(
      <ReportEditForm
        resultId="r1"
        expectedAmendmentCount={2}
        params={[]}
        editableParamIds={[]}
        initial={{}}
        notifyOffer={{ offered: true }}
        doneHref="/staff/queue/consolidated/v1/g1#result-r1"
      />,
    );
    expect(html).toContain('id="edit-reason-r1"');
    expect(html).toContain("Save edit");
    expect(html).not.toContain("Saved.");
  });
});
