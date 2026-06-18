// Google Merchant / Google Shopping product feed at https://drmed.ph/google-merchant.xml.
// File-based alternative to the crawl-based "Found by Google" source: in
// Merchant Center, "Add products from a file" → scheduled fetch from this URL.
// Lab packages only (the one kind whose price the site publishes); prices come
// live from the services table so the feed can never disagree with the site.

import { listActivePackages } from "@/lib/marketing/services";
import { buildMerchantFeed, type MerchantFeedItem } from "@/lib/seo/merchant-feed";
import { SITE } from "@/lib/marketing/site";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const packages = await listActivePackages();
  const items: MerchantFeedItem[] = packages.map((p) => ({
    code: p.code,
    name: p.name,
    description: p.description,
    pricePhp: p.price_php,
    imageUrl: p.image_url,
  }));

  const xml = buildMerchantFeed(items, {
    siteUrl: SITE.url,
    brand: SITE.name,
    defaultImage: SITE.productImage,
    title: `${SITE.name} — Diagnostic Packages`,
    description: SITE.description,
  });

  return new Response(xml, {
    status: 200,
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      // Re-fetched by Merchant Center on a schedule; an hour of edge cache is
      // plenty and keeps price edits fresh.
      "Cache-Control": "public, max-age=3600",
      "X-Robots-Tag": "noindex",
    },
  });
}
