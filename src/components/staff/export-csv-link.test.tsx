import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExportCsvButton, ExportCsvLink } from "./export-csv-link";

// The two mechanisms (anchor for a Route Handler download, button for a
// client-side Blob export) must render identically styled so they read as
// one control — pull the class string out of one render and assert the
// other matches it exactly.
function classOf(html: string): string | null {
  const match = html.match(/class="([^"]*)"/);
  return match ? match[1] : null;
}

describe("ExportCsvLink", () => {
  it("renders an <a> with the given href and the default label", () => {
    const html = renderToStaticMarkup(<ExportCsvLink href="/api/export.csv" />);
    expect(html).toContain('href="/api/export.csv"');
    expect(html).toContain(">Export CSV<");
    expect(html.startsWith("<a ")).toBe(true);
  });

  it("honours a custom label", () => {
    const html = renderToStaticMarkup(
      <ExportCsvLink href="/api/export.csv" label="Download CSV" />,
    );
    expect(html).toContain(">Download CSV<");
    expect(html).not.toContain(">Export CSV<");
  });
});

describe("ExportCsvButton", () => {
  it("renders a <button type=\"button\"> with the default label", () => {
    const html = renderToStaticMarkup(<ExportCsvButton onClick={() => {}} />);
    expect(html.startsWith("<button ")).toBe(true);
    // Losing type="button" would submit an enclosing <form> — pin it.
    expect(html).toContain('type="button"');
    expect(html).toContain(">Export CSV<");
  });

  it("honours a custom label", () => {
    const html = renderToStaticMarkup(
      <ExportCsvButton onClick={() => {}} label="Download CSV" />,
    );
    expect(html).toContain(">Download CSV<");
  });
});

describe("shared styling", () => {
  it("renders the identical class string for both mechanisms", () => {
    const linkHtml = renderToStaticMarkup(<ExportCsvLink href="/api/export.csv" />);
    const buttonHtml = renderToStaticMarkup(<ExportCsvButton onClick={() => {}} />);
    const linkClass = classOf(linkHtml);
    const buttonClass = classOf(buttonHtml);
    expect(linkClass).not.toBeNull();
    expect(buttonClass).toBe(linkClass);
  });
});
