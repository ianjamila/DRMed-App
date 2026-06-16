import { describe, it, expect } from "vitest";
import {
  escapeHtml,
  emailParagraph,
  emailButton,
  emailDetailBox,
  emailHighlight,
  renderEmailShell,
} from "./branded-email";

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });
});

describe("emailButton", () => {
  it("renders label, href and the cyan background by default", () => {
    const html = emailButton("Sign in", "https://drmed.ph/portal");
    expect(html).toContain("https://drmed.ph/portal");
    expect(html).toContain("Sign in");
    expect(html).toContain("#08A8E2");
  });
  it("uses navy when asked", () => {
    expect(emailButton("Manage", "https://x", "navy")).toContain("#263F91");
  });
});

describe("emailDetailBox", () => {
  it("renders rows and escapes the values", () => {
    const html = emailDetailBox([
      { label: "Service", value: "Chest X-Ray <b>" },
    ]);
    expect(html).toContain("Service");
    expect(html).toContain("Chest X-Ray &lt;b&gt;");
  });
});

describe("emailHighlight", () => {
  it("renders a label and value", () => {
    const html = emailHighlight("Your DRM-ID", "DRM-0042");
    expect(html).toContain("Your DRM-ID");
    expect(html).toContain("DRM-0042");
  });
});

describe("renderEmailShell", () => {
  const content = emailParagraph("Hi <b>Maria</b>,");

  it("includes the logo, heading, content and branded footer", () => {
    const html = renderEmailShell({
      heading: "Your lab result is ready",
      contentHtml: content,
    });
    expect(html).toContain("/logo.png");
    expect(html).toContain("Your lab result is ready");
    expect(html).toContain("Hi <b>Maria</b>,");
    // footer essentials
    expect(html).toContain("Your Family"); // tagline
    expect(html).toContain("google.com/maps"); // get directions
    expect(html).toContain("10 major HMO providers");
    expect(html).toContain("Facebook");
    expect(html).toContain(">drmed.ph</a>"); // website link
  });

  it("transactional mode has NO unsubscribe link", () => {
    const html = renderEmailShell({ heading: "x", contentHtml: content });
    expect(html).not.toContain("Unsubscribe");
  });

  it("renders the received-note when provided (transactional)", () => {
    const html = renderEmailShell({
      heading: "x",
      contentHtml: content,
      receivedNote: "You received this because a result was released.",
    });
    expect(html).toContain("a result was released");
    expect(html).toContain("not monitored");
  });

  it("newsletter mode adds unsubscribe + RA 10173 + marketing note", () => {
    const html = renderEmailShell({
      contentHtml: "<p>Hello subscribers</p>",
      unsubscribeUrl: "https://drmed.ph/unsubscribe?token=abc",
    });
    expect(html).toContain("https://drmed.ph/unsubscribe?token=abc");
    expect(html).toContain("Unsubscribe");
    expect(html).toContain("RA 10173");
    expect(html).toContain("occasional updates");
  });
});
