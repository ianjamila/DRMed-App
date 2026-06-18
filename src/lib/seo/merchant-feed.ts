// Builds a Google Merchant / Google Shopping product feed (RSS 2.0 with the
// g: namespace) from lab packages. This is the file-based alternative to the
// crawl-based "Found by Google" source: Merchant Center fetches it on a
// schedule from /google-merchant.xml, giving field-level control (g:price,
// g:brand, custom attributes) the automatic crawl can't.
//
// Pure + side-effect free so it can be unit-tested without a DB. The route
// handler supplies live data + SITE config.

export interface MerchantFeedItem {
  code: string;
  name: string;
  description: string | null;
  pricePhp: number;
  /** Absolute URL or site-relative path; null falls back to the default image. */
  imageUrl: string | null;
}

export interface MerchantFeedOptions {
  siteUrl: string;
  brand: string;
  /** Site-relative path or absolute URL used when an item has no image. */
  defaultImage: string;
  title: string;
  description: string;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function absUrl(pathOrUrl: string, siteUrl: string): string {
  return /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : `${siteUrl}${pathOrUrl}`;
}

function itemXml(item: MerchantFeedItem, opts: MerchantFeedOptions): string {
  const url = `${opts.siteUrl}/all-services/${item.code.toLowerCase()}`;
  const image = absUrl(item.imageUrl ?? opts.defaultImage, opts.siteUrl);
  const description = item.description ?? `${item.name} at ${opts.brand}.`;
  // PHP, two decimals, e.g. "1299.00 PHP" — Merchant's required price format.
  const price = `${item.pricePhp.toFixed(2)} PHP`;
  return [
    "    <item>",
    `      <g:id>${escapeXml(item.code)}</g:id>`,
    `      <title>${escapeXml(item.name)}</title>`,
    `      <description>${escapeXml(description)}</description>`,
    `      <link>${escapeXml(url)}</link>`,
    `      <g:image_link>${escapeXml(image)}</g:image_link>`,
    `      <g:price>${escapeXml(price)}</g:price>`,
    "      <g:availability>in_stock</g:availability>",
    "      <g:condition>new</g:condition>",
    `      <g:brand>${escapeXml(opts.brand)}</g:brand>`,
    `      <g:mpn>${escapeXml(item.code)}</g:mpn>`,
    // No GTIN for clinic packages — brand + mpn satisfy the identifier rule.
    "      <g:identifier_exists>no</g:identifier_exists>",
    "      <g:google_product_category>Health &amp; Beauty &gt; Health Care</g:google_product_category>",
    "    </item>",
  ].join("\n");
}

export function buildMerchantFeed(
  items: readonly MerchantFeedItem[],
  opts: MerchantFeedOptions,
): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">',
    "  <channel>",
    `    <title>${escapeXml(opts.title)}</title>`,
    `    <link>${escapeXml(opts.siteUrl)}</link>`,
    `    <description>${escapeXml(opts.description)}</description>`,
    ...items.map((i) => itemXml(i, opts)),
    "  </channel>",
    "</rss>",
    "",
  ].join("\n");
}
