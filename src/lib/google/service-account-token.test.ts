import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetTokenCacheForTests, getServiceAccountToken } from "./service-account-token";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const SA = JSON.stringify({ client_email: "svc@example.iam.gserviceaccount.com", private_key: privateKey });

describe("getServiceAccountToken", () => {
  beforeEach(() => __resetTokenCacheForTests());

  it("caches per scope", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ access_token: "t", expires_in: 3600 })));
    await getServiceAccountToken(SA, "scope-a", f as unknown as typeof fetch);
    await getServiceAccountToken(SA, "scope-a", f as unknown as typeof fetch);
    await getServiceAccountToken(SA, "scope-b", f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("sends a signed JWT assertion with the scope", async () => {
    const f = vi.fn(async (_u: string, init: RequestInit) => {
      const assertion = new URLSearchParams(String(init.body)).get("assertion")!;
      const claims = JSON.parse(Buffer.from(assertion.split(".")[1], "base64url").toString());
      expect(claims).toMatchObject({ iss: "svc@example.iam.gserviceaccount.com", scope: "scope-a" });
      return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }));
    });
    expect(await getServiceAccountToken(SA, "scope-a", f as unknown as typeof fetch)).toBe("t");
  });

  it("throws a clear error on a failed exchange without echoing the key", async () => {
    const f = vi.fn(async () => new Response("nope", { status: 400 }));
    await expect(getServiceAccountToken(SA, "s", f as unknown as typeof fetch)).rejects.toThrow(/token exchange failed \(400\)/);
  });
});
