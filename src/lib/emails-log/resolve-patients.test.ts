import { describe, expect, it, vi } from "vitest";
import { IN_CHUNK } from "@/lib/reports/paging";
import { resolvePatientsByIdChunked } from "./resolve-patients";

interface P {
  id: string;
  name: string;
}

describe("resolvePatientsByIdChunked", () => {
  it("returns an empty map for no ids without calling the fetcher", async () => {
    const fetchChunk = vi.fn();
    const map = await resolvePatientsByIdChunked<P>([], fetchChunk);
    expect(map.size).toBe(0);
    expect(fetchChunk).not.toHaveBeenCalled();
  });

  it("resolves a small set in a single chunk", async () => {
    const fetchChunk = vi.fn(async (ids: readonly string[]) => ({
      data: ids.map((id) => ({ id, name: `patient-${id}` })),
      error: null,
    }));
    const map = await resolvePatientsByIdChunked<P>(["a", "b", "c"], fetchChunk);
    expect(fetchChunk).toHaveBeenCalledTimes(1);
    expect(map.get("a")).toEqual({ id: "a", name: "patient-a" });
    expect(map.size).toBe(3);
  });

  it("walks a set larger than IN_CHUNK across multiple calls, none exceeding IN_CHUNK ids", async () => {
    const ids = Array.from({ length: IN_CHUNK * 2 + 37 }, (_, i) => `id-${i}`);
    const seenChunkSizes: number[] = [];
    const fetchChunk = vi.fn(async (chunkIds: readonly string[]) => {
      seenChunkSizes.push(chunkIds.length);
      return { data: chunkIds.map((id) => ({ id, name: id })), error: null };
    });
    const map = await resolvePatientsByIdChunked<P>(ids, fetchChunk);
    expect(fetchChunk).toHaveBeenCalledTimes(3);
    expect(seenChunkSizes.every((n) => n <= IN_CHUNK)).toBe(true);
    expect(map.size).toBe(ids.length);
  });

  it("de-duplicates ids before chunking", async () => {
    const fetchChunk = vi.fn(async (chunkIds: readonly string[]) => ({
      data: chunkIds.map((id) => ({ id, name: id })),
      error: null,
    }));
    const map = await resolvePatientsByIdChunked<P>(["a", "a", "b", "a"], fetchChunk);
    expect(fetchChunk).toHaveBeenCalledTimes(1);
    expect(fetchChunk.mock.calls[0]![0]).toEqual(["a", "b"]);
    expect(map.size).toBe(2);
  });

  it("throws instead of silently returning a partial map when a chunk errors", async () => {
    const ids = Array.from({ length: IN_CHUNK + 5 }, (_, i) => `id-${i}`);
    let call = 0;
    const fetchChunk = vi.fn(async (chunkIds: readonly string[]) => {
      call += 1;
      if (call === 2) {
        return { data: null, error: { message: "request too large" } };
      }
      return { data: chunkIds.map((id) => ({ id, name: id })), error: null };
    });
    await expect(resolvePatientsByIdChunked<P>(ids, fetchChunk)).rejects.toThrow(
      /request too large/,
    );
  });

  it("treats a null data page as zero rows rather than throwing", async () => {
    const fetchChunk = vi.fn(async () => ({ data: null, error: null }));
    const map = await resolvePatientsByIdChunked<P>(["a"], fetchChunk);
    expect(map.size).toBe(0);
  });
});
