import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FixedBottomBar } from "./fixed-bottom-bar";

describe("FixedBottomBar", () => {
  it("pins to the viewport past the sidebar, under dialogs, never in print", () => {
    const html = renderToStaticMarkup(
      <FixedBottomBar>
        <p>bar</p>
      </FixedBottomBar>,
    );
    expect(html).toContain("fixed inset-x-0 bottom-0 z-30");
    expect(html).toContain("md:left-64");
    expect(html).toContain("print:hidden");
    expect(html).not.toMatch(/\bsticky\b/);
    expect(html).toContain("<p>bar</p>");
    // The in-flow spacer that keeps the last rows visible comes first.
    expect(html.indexOf('aria-hidden="true"')).toBeLessThan(html.indexOf("fixed inset-x-0"));
  });
});
