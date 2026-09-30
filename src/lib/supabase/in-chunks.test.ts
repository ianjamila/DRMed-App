import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IN_CHUNK, readInChunks } from "./in-chunks";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`);

describe("readInChunks", () => {
  it("chunks at 200, matching the repo precedent", () => {
    expect(IN_CHUNK).toBe(200);
  });

  it("makes no call for an empty list", async () => {
    let calls = 0;
    const r = await readInChunks<string>([], async () => {
      calls += 1;
      return { data: [], error: null };
    });
    expect(r).toEqual({ ok: true, rows: [] });
    expect(calls).toBe(0);
  });

  it("makes ONE call up to the chunk size, and never sends more than the chunk size in a call", async () => {
    const seen: number[] = [];
    const r = await readInChunks<string>(ids(500), async (chunk) => {
      seen.push(chunk.length);
      return { data: chunk, error: null };
    });
    expect(seen).toEqual([200, 200, 100]);
    expect(r.ok && r.rows).toEqual(ids(500));

    seen.length = 0;
    await readInChunks<string>(ids(200), async (chunk) => {
      seen.push(chunk.length);
      return { data: chunk, error: null };
    });
    expect(seen).toEqual([200]);
  });

  it("returns rows in chunk order and deduplicates the ids it sends", async () => {
    const sent: string[][] = [];
    const r = await readInChunks<string>(["a", "b", "a", "c", "b"], async (chunk) => {
      sent.push(chunk);
      return { data: chunk.map((c) => c.toUpperCase()), error: null };
    }, 2);
    expect(sent).toEqual([["a", "b"], ["c"]]);
    expect(r).toEqual({ ok: true, rows: ["A", "B", "C"] });
  });

  it("fails CLOSED on the first errored chunk: its error, no partial rows, no further calls", async () => {
    const boom = { code: "57014", message: "canceled" };
    let calls = 0;
    const r = await readInChunks<string, typeof boom>(ids(500), async (chunk) => {
      calls += 1;
      return calls === 2 ? { data: null, error: boom } : { data: chunk, error: null };
    });
    expect(r).toEqual({ ok: false, error: boom });
    expect(calls).toBe(2);
  });

  it("treats a null data with no error as an empty slice", async () => {
    const r = await readInChunks<string>(["a"], async () => ({ data: null, error: null }));
    expect(r).toEqual({ ok: true, rows: [] });
  });
});

// The bulk reads that can carry up to MAX_BULK_RECORDS (500) ids must go
// through readInChunks — pinned as source text because they sit behind
// server-only / admin-client modules that vitest cannot run.
const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
function slice(text: string, from: string, to: string): string {
  const a = text.indexOf(from);
  expect(a, `${from} not found`).toBeGreaterThan(-1);
  const b = text.indexOf(to, a + from.length);
  return text.slice(a, b === -1 ? undefined : b);
}

describe("the bulk queue's large-id reads are chunked", () => {
  const cases: Array<{ name: string; text: string; from: string; to: string; rawIn: RegExp }> = [
    {
      name: "readBenchStartedAt",
      text: src("src/lib/actions/queue/panel-writes.ts"),
      from: "export async function readBenchStartedAt(",
      to: "\n}\n",
      rawIn: /\.in\("id", \[\.\.\.testRequestIds\]\)/,
    },
    {
      name: "loadOwnBatchRows (later-rows read)",
      text: src("src/lib/audit/bulk-batch.ts"),
      from: "const later = await readInChunks(",
      to: "const laterRows",
      rawIn: /\.in\("resource_id", resourceIds\)/,
    },
    {
      name: "claimTestsCore",
      text: src("src/lib/actions/queue/bulk-cores.ts"),
      from: "export async function claimTestsCore(",
      to: "export async function unclaimTestsCore(",
      rawIn: /\.in\("id", ids\)/,
    },
    {
      name: "unclaimTestsCore",
      text: src("src/lib/actions/queue/bulk-cores.ts"),
      from: "export async function unclaimTestsCore(",
      to: "\n}\n",
      rawIn: /\.in\("id", ids\)/,
    },
    {
      name: "deleteTestRequestsManyCore",
      text: src("src/lib/actions/queue/bulk-delete-core.ts"),
      from: "export async function deleteTestRequestsManyCore(",
      to: "const visitOfSingle",
      rawIn: /\.in\("id", ids\)/,
    },
    {
      name: "undoBulkQueueAction's restore pre-read",
      text: src("src/app/(staff)/staff/(dashboard)/queue/actions.ts"),
      from: "const currentRead = await readInChunks(allIds",
      to: "const currentDeletedAtById",
      rawIn: /\.in\("id", allIds\)/,
    },
  ];

  for (const c of cases) {
    it(`${c.name} reads through readInChunks, not one raw .in() over every id`, () => {
      const body = slice(c.text, c.from, c.to);
      expect(body).toMatch(/readInChunks\(/);
      expect(body).not.toMatch(c.rawIn);
      expect(body).toMatch(/\.in\("(id|resource_id)", chunk\)/);
    });
  }
});
