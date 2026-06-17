import "server-only";
import type { MetadataRoute } from "next";
import { listActiveServices } from "@/lib/marketing/services";
import { listActivePhysicians } from "@/lib/marketing/physicians";
import { SITE } from "@/lib/marketing/site";

/** Single source of truth for the public URL set — used by both the sitemap
 *  route and the IndexNow full-submit. */
export async function buildSitemapEntries(): Promise<MetadataRoute.Sitemap> {
  const base = SITE.url.replace(/\/$/, "");
  const now = new Date();

  const staticEntries: MetadataRoute.Sitemap = [
    "/",
    "/all-services",
    "/packages",
    "/physicians",
    "/schedule",
    "/about",
    "/contact",
    "/privacy",
    "/terms",
  ].map((path) => ({
    url: `${base}${path}`,
    lastModified: now,
    changeFrequency: "weekly",
    priority: path === "/" ? 1.0 : 0.7,
  }));

  const services = await listActiveServices();
  const serviceEntries: MetadataRoute.Sitemap = services.map((s) => ({
    url: `${base}/all-services/${s.code.toLowerCase()}`,
    lastModified: now,
    changeFrequency: "monthly",
    priority: 0.6,
  }));

  const physicians = await listActivePhysicians();
  const physicianEntries: MetadataRoute.Sitemap = physicians.map((p) => ({
    url: `${base}/physicians/${p.slug}`,
    lastModified: p.updated_at ? new Date(p.updated_at) : now,
    changeFrequency: "monthly",
    priority: 0.6,
  }));

  return [...staticEntries, ...serviceEntries, ...physicianEntries];
}
