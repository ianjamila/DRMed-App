import type { MetadataRoute } from "next";
import { buildSitemapEntries } from "@/lib/seo/sitemap-entries";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  return buildSitemapEntries();
}
