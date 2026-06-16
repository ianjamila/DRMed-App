import type { Metadata } from "next";
import { SITE } from "./site";

export interface PageMetaInput {
  /** Short page title — wrapped by the root `%s — drmed.ph` template unless absoluteTitle. */
  title: string;
  description: string;
  /** Absolute path from the site root, e.g. "/about" or "/physicians/dr-jane". */
  path: string;
  /** Absolute OG/Twitter image URL or site-relative path; defaults to SITE.ogImage. */
  image?: string;
  /** Set the document <title> verbatim (used by the homepage). */
  absoluteTitle?: boolean;
}

export function pageMetadata({
  title,
  description,
  path,
  image,
  absoluteTitle,
}: PageMetaInput): Metadata {
  const canonical = `${SITE.url}${path}`;
  const ogImage = image ?? `${SITE.url}${SITE.ogImage}`;
  const ogTitle = absoluteTitle ? title : `${title} — ${SITE.name}`;
  return {
    title: absoluteTitle ? { absolute: title } : title,
    description,
    alternates: { canonical },
    openGraph: {
      type: "website",
      locale: "en_PH",
      siteName: SITE.shortName,
      url: canonical,
      title: ogTitle,
      description,
      images: [{ url: ogImage }],
    },
    twitter: {
      card: "summary_large_image",
      title: ogTitle,
      description,
      images: [ogImage],
    },
  };
}
