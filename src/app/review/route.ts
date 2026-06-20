import { NextResponse, type NextRequest, after } from "next/server";
import { GOOGLE_REVIEW } from "@/lib/marketing/site";
import { REVIEW_AUDIT_ACTION, reviewLinkSource } from "@/lib/seo/review";
import { audit } from "@/lib/audit/log";

// Brandable on-domain hop to the verified Google Business Profile review
// composer. Records a privacy-safe, no-PII scan event so the clinic can see
// which touchpoint (receipt / poster / portal / email) drives reviews. The
// audit write runs after the response via after(), so it never delays the
// redirect yet still completes on serverless.
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  const src = reviewLinkSource(request.nextUrl.searchParams.get("src"));
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = request.headers.get("user-agent");

  after(() =>
    audit({
      actor_id: null,
      actor_type: "anonymous",
      action: REVIEW_AUDIT_ACTION,
      metadata: { src },
      ip_address: ip,
      user_agent: userAgent,
    }),
  );

  const res = NextResponse.redirect(GOOGLE_REVIEW.url, 302);
  res.headers.set("X-Robots-Tag", "noindex");
  res.headers.set("Cache-Control", "no-store");
  return res;
}
