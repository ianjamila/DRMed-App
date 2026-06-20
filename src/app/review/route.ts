import { NextResponse, type NextRequest } from "next/server";
import { GOOGLE_REVIEW } from "@/lib/marketing/site";
import { reviewLinkSource } from "@/lib/seo/review";
import { audit } from "@/lib/audit/log";

// Brandable on-domain hop to the verified Google Business Profile review
// composer. Records a privacy-safe, no-PII scan event so the clinic can see
// which touchpoint (receipt / poster / portal / email) drives reviews. The
// audit write is best-effort and never blocks the redirect.
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  const src = reviewLinkSource(request.nextUrl.searchParams.get("src"));

  await audit({
    actor_id: null,
    actor_type: "anonymous",
    action: "review.link.opened",
    metadata: { src },
    ip_address:
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: request.headers.get("user-agent"),
  });

  const res = NextResponse.redirect(GOOGLE_REVIEW.url, 302);
  res.headers.set("X-Robots-Tag", "noindex");
  return res;
}
