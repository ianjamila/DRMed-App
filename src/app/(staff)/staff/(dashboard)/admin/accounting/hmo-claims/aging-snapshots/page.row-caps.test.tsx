import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";
import type { Database } from "@/types/database";
import AgingSnapshotsPage from "./page";

const state = vi.hoisted(() => ({ client: null as SupabaseClient<Database> | null }));
vi.mock("@/lib/auth/require-admin", () => ({ requireAdminStaff: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.client }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: ReactNode }) =>
  <a href={href}>{children}</a> }));

function installFixture(failSelected = false) {
  // Each of the latest 25 dates has 60 rows. The older bookmarked date has
  // 1,505 rows of its own, testing both independent truncation points.
  const rows = Array.from({ length: 26 }, (_, d) =>
    Array.from({ length: d === 25 ? 1505 : 60 }, (_, i) => ({
      id: `${String(d).padStart(2, "0")}-${String(i).padStart(4, "0")}`,
      snapshot_date: `2026-09-${String(26 - d).padStart(2, "0")}`,
      provider_name: `Synthetic provider ${String(i).padStart(4, "0")}`,
      bucket: "0-30", kind: "lab", total_php: 1, item_count: 1,
    })),
  ).flat();
  state.client = createClient<Database>("https://snapshots.test", "test", { global: { fetch: async (input) => {
    const url = new URL(String(input));
    const selected = url.searchParams.get("snapshot_date")?.slice(3);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Math.min(1000, Number(url.searchParams.get("limit") ?? 1000));
    if (failSelected && selected && offset === 1000) return new Response(
      JSON.stringify({ message: "selected snapshot failed" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
    const matching = selected ? rows.filter((r) => r.snapshot_date === selected) : rows;
    return new Response(JSON.stringify(matching.slice(offset, offset + limit)), {
      headers: { "Content-Type": "application/json" },
    });
  } } });
}

it("renders all 24 date choices and the full older bookmarked snapshot", async () => {
  installFixture();
  const html = renderToStaticMarkup(await AgingSnapshotsPage({ searchParams: Promise.resolve({ date: "2026-09-01" }) }));
  expect([...html.matchAll(/aging-snapshots\?date=/g)]).toHaveLength(24);
  expect(html).toContain("Synthetic provider 1504");
  const body = html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? "";
  expect([...body.matchAll(/<tr\b/g)]).toHaveLength(1505);
});

it("does not render truncated snapshot totals after a later-page error", async () => {
  installFixture(true);
  await expect(AgingSnapshotsPage({ searchParams: Promise.resolve({ date: "2026-09-01" }) }))
    .rejects.toThrow("selected snapshot failed");
});
