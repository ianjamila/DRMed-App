"use client";

import { useState } from "react";
import { MapPin } from "lucide-react";

/**
 * Privacy-respecting map: shows a static styled placeholder; the Google Maps
 * iframe (which sets Google cookies) loads only after the user clicks. No API
 * key — uses the cookie-free `output=embed` URL from nap.mapEmbedSrc().
 */
export function MapEmbed({ src, title }: { src: string; title: string }) {
  const [loaded, setLoaded] = useState(false);

  if (loaded) {
    return (
      <iframe
        src={src}
        title={title}
        loading="lazy"
        referrerPolicy="no-referrer-when-downgrade"
        className="h-[360px] w-full rounded-[20px] border border-[color:var(--color-warm-line-soft)]"
        allowFullScreen
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setLoaded(true)}
      className="group relative flex h-[360px] w-full items-center justify-center overflow-hidden rounded-[20px] border border-[color:var(--color-warm-line-soft)] bg-[color:var(--color-warm-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-brand-cyan)]"
      aria-label={`Load interactive map: ${title}`}
    >
      {/* Subtle map-ish grid backdrop */}
      <span
        aria-hidden="true"
        className="absolute inset-0 opacity-[0.5] [background:linear-gradient(0deg,transparent_24px,rgba(8,168,226,0.10)_25px),linear-gradient(90deg,transparent_24px,rgba(8,168,226,0.10)_25px)] [background-size:25px_25px]"
      />
      <span className="relative z-10 flex flex-col items-center gap-2 text-[color:var(--color-brand-navy)]">
        <span className="grid h-12 w-12 place-items-center rounded-full bg-white shadow-[var(--shadow-warm-sm)]">
          <MapPin className="h-6 w-6 text-[color:var(--color-brand-cyan)]" aria-hidden="true" />
        </span>
        <span className="text-sm font-bold">View interactive map</span>
        <span className="text-xs text-[color:var(--color-ink-soft)]">
          Loads Google Maps · no tracking until you click
        </span>
      </span>
    </button>
  );
}
