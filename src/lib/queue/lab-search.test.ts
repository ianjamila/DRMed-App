import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import type { Database } from "@/types/database";
import { applyLabSearch, labSearchPatterns, LAB_SEARCH_TEXT } from "./lab-search";

function client() {
  const requests: URL[] = [];
  const db = createClient<Database>("https://example.test", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input) => {
        requests.push(new URL(String(input)));
        return new Response("[]", {
          status: 200,
          headers: { "Content-Type": "application/json", "Content-Range": "*/0" },
        });
      },
    },
  });
  return { db, requests };
}

describe("labSearchPatterns", () => {
  it("is empty for a blank search, so the caller adds no embed or filter", () => {
    expect(labSearchPatterns(undefined)).toEqual([]);
    expect(labSearchPatterns("  , ")).toEqual([]);
  });

  it("makes one contains-pattern per word, commas and spaces both split", () => {
    expect(labSearchPatterns("Castillo, Maria  GLU")).toEqual(["%Castillo%", "%Maria%", "%GLU%"]);
  });

  it("escapes LIKE wildcards and PostgREST's * alias", () => {
    expect(labSearchPatterns("50%_a\\b*")).toEqual(["%50\\%\\_a\\\\b\\*%"]);
  });
});

describe("applyLabSearch", () => {
  it("ANDs one ilike per word on the embedded search text", async () => {
    const { db, requests } = client();
    await applyLabSearch(
      db.from("test_requests").select("id, lab_search!inner ( )"),
      labSearchPatterns("Cruz FBS"),
    );
    expect(LAB_SEARCH_TEXT).toBe("lab_search.search_text");
    expect(requests[0].searchParams.getAll("lab_search.search_text")).toEqual([
      "ilike.%Cruz%",
      "ilike.%FBS%",
    ]);
  });

  it("adds nothing when there are no words", async () => {
    const { db, requests } = client();
    await applyLabSearch(db.from("test_requests").select("id"), []);
    expect(requests[0].searchParams.has("lab_search.search_text")).toBe(false);
  });
});
