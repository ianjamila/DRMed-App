import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => {}, refresh: () => {} }) }));
vi.mock("./actions", () => ({
  amendResultAction: vi.fn(),
  amendStructuredResultAction: vi.fn(),
  finaliseStructuredAction: vi.fn(),
  saveDraftAction: vi.fn(),
}));

import { AmendResultForm } from "./amend-form";

// Same shape as the consolidated report edit (X2): each save revalidates the
// page, so the new amendment_count arrives with the response. The edit forms
// are keyed by that count — a form seeded from old values must never send a
// newer count (it would dodge P0065 and overwrite someone else's edit), and a
// refresh from elsewhere on the page resets an open form instead. The success
// message therefore lives in AmendResultForm, above the key, and replaces the
// form so the same reason + notice box can't be submitted twice by accident.
// Browser-verified 2026-09-28 (structured + uploaded PDF); this pins the shape.
const DIR = join(process.cwd(), "src/app/(staff)/staff/(dashboard)/queue/[id]");
const amendSrc = readFileSync(join(DIR, "amend-form.tsx"), "utf8");
const structuredSrc = readFileSync(join(DIR, "structured-form.tsx"), "utf8");

describe("single-test Edit result — Saved message above the version key", () => {
  const outer = amendSrc.slice(
    amendSrc.indexOf("export function AmendResultForm("),
    amendSrc.indexOf("function ReplacePdfForm("),
  );
  const replace = amendSrc.slice(amendSrc.indexOf("function ReplacePdfForm("));

  it("AmendResultForm holds the Saved message and keys both edit forms by version", () => {
    expect(outer).toContain("useState<string | null>(null)");
    expect(outer.match(/key=\{expectedAmendmentCount\}/g)).toHaveLength(2);
    expect(outer).toContain("<StructuredResultForm");
    expect(outer).toContain("<ReplacePdfForm");
  });

  it("the PDF-replace form hands success up instead of showing it, and never refreshes itself", () => {
    expect(replace).toContain("onReplaced(result.notify)");
    expect(replace).not.toContain("Result replaced.");
    expect(replace).not.toContain("router.refresh()");
  });

  it("the structured form's amend branch hands success up before any local message", () => {
    const amendBranch = structuredSrc.slice(structuredSrc.indexOf("amendStructuredResultAction("));
    const handUp = amendBranch.indexOf("props.onAmended(result)");
    expect(handUp).toBeGreaterThan(-1);
    expect(handUp).toBeLessThan(amendBranch.indexOf("setFeedback(result)"));
  });

  it("renders only the Edit result button until opened", () => {
    const html = renderToStaticMarkup(
      <AmendResultForm
        testRequestId="t1"
        generationKind="uploaded"
        expectedAmendmentCount={1}
        notifyOffer={{ offered: true }}
      />,
    );
    expect(html).toContain("Edit result…");
    expect(html).not.toContain("amend-reason");
  });
});
