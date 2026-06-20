import type { Metadata } from "next";
import { headers } from "next/headers";
import { reviewLinkAbsolute } from "@/lib/seo/review";
import { ReviewPoster } from "./poster";

// Standalone (outside marketing chrome), print-optimized desk poster reception
// can print for the counter. noindex — internal print aid, not a search page.
export const metadata: Metadata = {
  title: "Review poster — drmed.ph",
  robots: { index: false, follow: false },
};

export default async function ReviewPosterPage() {
  const host = (await headers()).get("host") ?? "drmed.ph";
  const proto = host.startsWith("localhost") ? "http" : "https";
  const url = reviewLinkAbsolute(`${proto}://${host}`, "poster");
  return <ReviewPoster url={url} />;
}
