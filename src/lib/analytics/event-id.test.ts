import { afterEach, describe, expect, it, vi } from "vitest";
import { newEventId } from "./event-id";

// These ids are minted inside booking / registration / contact submit
// handlers, so the only hard requirement is that generation NEVER throws —
// a missing Web Crypto API must not be able to fail a conversion flow.
const realCrypto = globalThis.crypto;

function stubCrypto(value: unknown) {
  Object.defineProperty(globalThis, "crypto", {
    value,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  stubCrypto(realCrypto);
});

describe("newEventId", () => {
  it("uses crypto.randomUUID when available", () => {
    const randomUUID = vi.fn(() => "11111111-2222-3333-4444-555555555555");
    stubCrypto({ randomUUID });

    expect(newEventId()).toBe("11111111-2222-3333-4444-555555555555");
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it("falls back to getRandomValues when randomUUID is missing (non-secure origin)", () => {
    stubCrypto({
      getRandomValues: (arr: Uint8Array) => {
        arr.fill(0xab);
        return arr;
      },
    });

    expect(newEventId()).toBe("ab".repeat(16));
  });

  it("still returns an id when the Web Crypto API is absent entirely", () => {
    stubCrypto(undefined);

    const id = newEventId();
    expect(id).toMatch(/^evt-/);
    expect(id.length).toBeGreaterThan(10);
  });

  it("never throws when randomUUID exists but throws (insecure context)", () => {
    stubCrypto({
      randomUUID: () => {
        throw new Error("randomUUID is not available in insecure contexts");
      },
    });

    expect(() => newEventId()).not.toThrow();
    expect(newEventId()).toMatch(/^evt-/);
  });

  it("produces distinct ids across calls", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newEventId()));
    expect(ids.size).toBe(200);
  });
});
