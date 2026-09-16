import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useListTable } from "./use-list-table";
import { ListPagination } from "./list-pagination";
import { SortableTh } from "./sortable-th";
import { numberColumn } from "@/lib/ui/compare-list-rows";

type LinkProps = {
  href: string;
  prefetch?: boolean;
  onNavigate?: (event: { preventDefault(): void }) => void;
  children?: ReactNode;
};
const state = vi.hoisted(() => ({ links: [] as LinkProps[], query: "page=2&size=5&year=2025&ot_page=3" }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/staff/admin/payroll/leaves",
  useSearchParams: () => new URLSearchParams(state.query),
}));
vi.mock("next/link", () => ({ default: (props: LinkProps) => {
  state.links.push(props);
  return <a href={props.href}>{props.children}</a>;
} }));
function Harness() {
  const table = useListTable(Array.from({ length: 20 }, (_, i) => ({ id: String(i), value: i })),
    { value: numberColumn((r) => r.value) }, { key: "value", dir: "asc" });
  return <><table><thead><tr>{table.th("value", "Value")}</tr></thead></table>{table.pagination}</>;
}
afterEach(() => { state.links = []; vi.unstubAllGlobals(); });

describe("navigation for complete client tables", () => {
  it("sort, size and page links cancel loader navigation and push bookmarkable history", () => {
    const pushState = vi.fn();
    vi.stubGlobal("window", { history: { pushState } });
    renderToStaticMarkup(<Harness />);
    expect(state.links).toHaveLength(8); // heading, five sizes, previous, next
    for (const link of state.links) {
      expect(link.prefetch).toBe(false);
      expect(link.onNavigate).toBeTypeOf("function");
      const preventDefault = vi.fn();
      link.onNavigate!({ preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(pushState).toHaveBeenLastCalledWith(null, "", link.href);
      const params = new URL(link.href, "https://example.test").searchParams;
      expect(params.get("year")).toBe("2025");
      expect(params.get("ot_page")).toBe("3");
    }
  });
  it("server-paged controls keep normal Next navigation and prefetch defaults", () => {
    renderToStaticMarkup(<>
      <table><thead><tr><SortableTh label="Date" href="?sort=date" state="none" /></tr></thead></table>
      <ListPagination page={2} pageCount={3} total={15} size={5}
        prevHref="?page=1" nextHref="?page=3" sizeOptions={[{ size: 10, href: "?size=10" }]} />
    </>);
    expect(state.links).toHaveLength(4);
    for (const link of state.links) {
      expect(link.onNavigate).toBeUndefined();
      expect(link.prefetch).toBeUndefined();
    }
  });
});
