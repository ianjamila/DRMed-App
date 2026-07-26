import "server-only";
import { cookies } from "next/headers";
import {
  ATTRIBUTION_COOKIE_NAME,
  parseAttributionCookie,
  type Attribution,
} from "./attribution";

// Server-side reader for the first-party attribution cookie written by
// src/proxy.ts. Kept apart from ./attribution.ts so that module stays free of
// `next/headers` and remains importable from the proxy (middleware runtime)
// and from unit tests.
export async function readAttributionCookie(): Promise<Attribution | null> {
  const c = await cookies();
  return parseAttributionCookie(c.get(ATTRIBUTION_COOKIE_NAME)?.value);
}
