import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConsentHistory } from "./consent-history";
import type { ConsentHistoryEvent } from "@/lib/consent/history";

const ev = (over: Partial<ConsentHistoryEvent>): ConsentHistoryEvent => ({
  id: "00000000-0000-4000-8000-000000000001",
  event_type: "granted",
  method: "onscreen_signature",
  created_at: "2026-09-24T08:12:02Z",
  signatory: "self",
  signatory_name: "Maria Santos",
  signatory_relationship: null,
  artifact_path: "p/sig.png",
  reason: null,
  source_form: null,
  consent_scope: "full",
  actor_kind: "staff",
  recorded_by: { full_name: "Ana Reception" },
  ...over,
});

describe("ConsentHistory", () => {
  it("renders nothing when the patient has no consent events", () => {
    expect(renderToStaticMarkup(<ConsentHistory patientId="p" events={[]} />)).toBe("");
  });

  it("lists every event newest first, marks the latest, and links only grants", () => {
    const html = renderToStaticMarkup(
      <ConsentHistory
        patientId="p-1"
        events={[
          ev({
            id: "00000000-0000-4000-8000-000000000003",
            method: "paper_wet_signature",
            signatory: "guardian",
            signatory_name: "Rosa Santos",
            signatory_relationship: "Mother",
            artifact_path: null,
          }),
          ev({
            id: "00000000-0000-4000-8000-000000000002",
            event_type: "withdrawn",
            method: null,
            signatory: null,
            signatory_name: null,
            reason: "Asked in person",
          }),
          ev({}),
        ]}
      />,
    );
    expect(html).toContain("Consent history (3)");
    expect(html.indexOf("Signed paper form")).toBeLessThan(html.indexOf("Withdrawn"));
    expect(html.indexOf("Withdrawn")).toBeLessThan(html.indexOf("Signed on screen"));
    expect(html.match(/>Latest</g)).toHaveLength(1);
    expect(html).toContain("Guardian: Rosa Santos (Mother)");
    expect(html).toContain("Reason: Asked in person");
    expect(html).toContain("Recorded by Ana Reception");
    // Grants link to that exact record; the withdrawal has no form to open.
    expect(html).toContain("/staff/patients/p-1/consent/signed?event=00000000-0000-4000-8000-000000000003");
    expect(html).toContain("/staff/patients/p-1/consent/signed?event=00000000-0000-4000-8000-000000000001");
    expect(html).not.toContain("event=00000000-0000-4000-8000-000000000002");
  });
});
