// Serves the IndexNow verification key (public, not secret) at the site root:
// https://drmed.ph/indexnow-key.txt. Root placement is required — IndexNow
// only trusts a key file whose path is a parent of every submitted URL, and
// our public URLs are all root-level. The ping sends this as `keyLocation`.

import { indexNowKey, type IndexNowEnv } from "@/lib/seo/indexnow-core";

export const dynamic = "force-dynamic";

export function GET(): Response {
  const key = indexNowKey(process.env as IndexNowEnv);
  if (!key) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(key, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      // Public verification artifact — no value in being indexed.
      "X-Robots-Tag": "noindex",
    },
  });
}
