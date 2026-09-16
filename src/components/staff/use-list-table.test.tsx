import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { useListTable } from "./use-list-table";
import { numberColumn, textColumn } from "@/lib/ui/compare-list-rows";

const state = vi.hoisted(() => ({ query: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/staff/admin/payroll/employees",
  useSearchParams: () => new URLSearchParams(state.query),
}));

const rows = Array.from({ length: 31 }, (_, i) => ({ id: String(i).padStart(2, "0"), value: i })).reverse();
function Harness({ prefix = "" }: { prefix?: string }) {
  const table = useListTable(rows, { value: numberColumn((r) => r.value) }, { key: "value", dir: "asc" }, prefix);
  return <div>
    <table><thead><tr>{table.th("value", "Value")}</tr></thead>
      <tbody>{table.rows.map((r) => <tr key={r.id} data-row-id={r.id}><td>row-{r.id}</td></tr>)}</tbody></table>
    <a href={table.href({ q: "new" })}>Filter</a>
    {table.pagination}
  </div>;
}

function rowIds(html: string) {
  return Array.from(html.matchAll(/data-row-id="([^"]+)"/g), (match) => match[1]);
}

function links(html: string) {
  return Array.from(html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g), (match) => ({
    label: match[2].replace(/<[^>]*>/g, "").trim(),
    params: new URL(match[1].replace(/&amp;/g, "&"), "https://example.test").searchParams,
  }));
}

describe("editable list URL controls", () => {
  it("uses the shared default size and omits default params", () => {
    state.query = "";
    const html = renderToStaticMarkup(<Harness />);
    expect(rowIds(html)).toEqual(Array.from({ length: 25 }, (_, i) => String(i).padStart(2, "0")));
    expect(html).toContain('href="/staff/admin/payroll/employees"');
    expect(html).not.toContain("size=25");
  });
  it("sorts before slicing and carries filters while resetting page on sort/size changes", () => {
    state.query = "q=EMP&amp=keep&status=active&sort=value&dir=desc&page=2&size=5";
    const html = renderToStaticMarkup(<Harness />);
    expect(rowIds(html)).toEqual(["25", "24", "23", "22", "21"]);
    expect(html).toContain("q=EMP&amp;amp=keep&amp;status=active&amp;size=5");
    expect(html).toContain("q=new&amp;amp=keep&amp;status=active&amp;sort=value&amp;dir=desc&amp;size=5");
  });
  it.each(["", "history_"])("resets the page in every size link (prefix %s)", (prefix) => {
    state.query = `q=EMP&status=active&tab=leaves&ot_page=3&ot_sort=hours&ot_dir=asc&${prefix}sort=value&${prefix}dir=desc&${prefix}page=2&${prefix}size=5`;
    const html = renderToStaticMarkup(<Harness prefix={prefix} />);
    const sizes = links(html).filter((link) => /^\d+$/.test(link.label));
    expect(sizes.map((link) => link.label)).toEqual(["5", "10", "25", "50", "100"]);
    for (const { label, params } of sizes) {
      expect(params.has(`${prefix}page`)).toBe(false);
      expect(Object.fromEntries(params)).toEqual({
        q: "EMP", status: "active", tab: "leaves",
        ot_page: "3", ot_sort: "hours", ot_dir: "asc",
        [`${prefix}sort`]: "value", [`${prefix}dir`]: "desc",
        ...(label === "25" ? {} : { [`${prefix}size`]: label }),
      });
    }
  });
  it("clamps out-of-range pages", () => {
    state.query = "page=999";
    const html = renderToStaticMarkup(<Harness />);
    expect(html).toContain("Page 2 of 2");
    expect(rowIds(html)).toEqual(["25", "26", "27", "28", "29", "30"]);
  });
  it("preserves the employee tab and the sibling table's state", () => {
    state.query = "tab=leaves&ot_page=3&ot_sort=value&ot_dir=desc&history_page=2";
    const html = renderToStaticMarkup(<Harness prefix="history_" />);
    expect(html).toContain("tab=leaves&amp;ot_page=3&amp;ot_sort=value&amp;ot_dir=desc&amp;history_sort=value&amp;history_dir=desc");
    expect(rowIds(html)).toEqual(["25", "26", "27", "28", "29", "30"]);
  });
  it("keeps the first duplicate filter and sibling value across every generated link", () => {
    state.query = "q=Alice&q=Bob&status=active&status=inactive&ot_page=3&ot_page=9&history_page=2&history_size=5";
    const html = renderToStaticMarkup(<Harness prefix="history_" />);
    const generated = links(html);
    expect(generated.length).toBeGreaterThan(5);
    for (const { label, params } of generated) {
      expect(params.getAll("q")).toEqual([label === "Filter" ? "new" : "Alice"]);
      expect(params.getAll("status")).toEqual(["active"]);
      expect(params.getAll("ot_page")).toEqual(["3"]);
    }
  });
  it("keeps a blank first filter instead of adopting a later duplicate", () => {
    state.query = "q=&q=Bob";
    for (const { label, params } of links(renderToStaticMarkup(<Harness />))) {
      expect(params.get("q")).toBe(label === "Filter" ? "new" : null);
    }
  });
  it.each(["asc", "desc"] as const)("keeps secondary bands ascending before the id tie-break: %s", (dir) => {
    state.query = `sort=effective_from&dir=${dir}&size=5`;
    function RatesHarness() {
      const bands = [
        { id: "b", date: "2026-01-01", lower: 10000 },
        { id: "z", date: "2026-01-01", lower: 0 },
        { id: "a", date: "2026-01-01", lower: 10000 },
        { id: "c", date: "2025-01-01", lower: 500 },
      ];
      const table = useListTable(bands, {
        effective_from: textColumn((r) => r.date),
        lower: numberColumn((r) => r.lower),
      }, { key: "effective_from", dir: "desc" }, "", [{ key: "lower", dir: "asc" }]);
      return <table><tbody>{table.rows.map((r) => <tr key={r.id} data-row-id={r.id}><td>{r.lower}</td></tr>)}</tbody></table>;
    }
    expect(rowIds(renderToStaticMarkup(<RatesHarness />))).toEqual(dir === "asc" ? ["c", "z", "a", "b"] : ["z", "a", "b", "c"]);
  });
  it("gives sibling page-size controls distinct accessible labels", () => {
    state.query = "";
    const html = renderToStaticMarkup(<><Harness prefix="history_" /><Harness prefix="ot_" /></>);
    expect(html).toContain('id="history_page-size-label"');
    expect(html).toContain('aria-labelledby="history_page-size-label"');
    expect(html).toContain('id="ot_page-size-label"');
    expect(html).toContain('aria-labelledby="ot_page-size-label"');
  });
});
