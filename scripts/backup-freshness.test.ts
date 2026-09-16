import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { list } from "@vercel/blob";

vi.mock("@vercel/blob", () => ({ list: vi.fn() }));
const now = Date.parse("2026-09-16T03:00:00Z");
const blob = (hours: number, pathname = "db-backups/test.dump.age") => ({
  pathname, uploadedAt: new Date(now - hours * 3_600_000), size: 1234, etag: "test-etag",
  url: "https://example.invalid/backup", downloadUrl: "https://example.invalid/backup",
});
const run = () => import("./backup-freshness.mjs");

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-token");
  vi.spyOn(Date, "now").mockReturnValue(now);
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("backup freshness runner", () => {
  it.each([1, 48])("passes at %s hours and prints evidence", async (hours) => {
    vi.mocked(list).mockResolvedValue({ blobs: [blob(hours)], hasMore: false });
    await run();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining(`age: ${hours.toFixed(2)} hours | size: 1234 bytes`));
  });

  it("fails just beyond 48 hours and still prints the newest pathname, age and size", async () => {
    vi.mocked(list).mockResolvedValue({ blobs: [blob(48 + 1 / 3_600_000)], hasMore: false });
    await expect(run()).rejects.toThrow("older than 48 hours");
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("db-backups/test.dump.age | age: 48.00 hours | size: 1234 bytes"));
  });

  it("finds the newest across unsorted pages", async () => {
    vi.mocked(list)
      .mockResolvedValueOnce({ blobs: [blob(80), blob(90)], hasMore: true, cursor: "next" })
      .mockResolvedValueOnce({ blobs: [blob(2, "db-backups/newest.dump.age"), blob(100)], hasMore: false });
    await run();
    expect(list).toHaveBeenNthCalledWith(2, { prefix: "db-backups/", cursor: "next", token: "test-token", limit: 1000 });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("db-backups/newest.dump.age | age: 2.00 hours"));
  });

  it("fails on an empty prefix", async () => {
    vi.mocked(list).mockResolvedValue({ blobs: [], hasMore: false });
    await expect(run()).rejects.toThrow("No backups found");
    expect(console.log).toHaveBeenCalledWith("Newest backup: none | age: unknown | size: unknown");
  });

  it.each(["", "   "])("refuses a missing/blank token before listing", async (token) => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", token);
    await expect(run()).rejects.toThrow("refusing to skip");
    expect(list).not.toHaveBeenCalled();
  });

  it("fails closed on a listing failure", async () => {
    vi.mocked(list).mockRejectedValue(new Error("Blob unavailable"));
    await expect(run()).rejects.toThrow("Blob unavailable");
  });

  it("refuses an incomplete listing", async () => {
    vi.mocked(list).mockResolvedValue({ blobs: [blob(2)], hasMore: true });
    await expect(run()).rejects.toThrow("listing is incomplete");
  });
});
