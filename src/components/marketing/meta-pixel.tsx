"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { metaTrack } from "@/lib/analytics/meta-pixel";
import { useCookieConsent } from "./cookie-consent";

// Consent-gated Meta Pixel. Under the site's opt-in model this component
// renders NOTHING — no script tag, no network request to Meta, no cookies —
// until the visitor has actively accepted. Declining, or simply ignoring the
// banner, means the Pixel never loads at all.
//
// There is deliberately no <noscript> tracking-pixel fallback. The standard
// Meta snippet ships one, but a visitor without JavaScript cannot be shown the
// consent banner and therefore cannot consent, so firing it would track
// exactly the people who were never asked.
export function MetaPixel({ pixelId }: { pixelId: string }) {
  const { granted } = useCookieConsent();

  if (!granted) return null;

  return (
    <>
      <Script id="meta-pixel-base" strategy="afterInteractive">
        {`
          !function(f,b,e,v,n,t,s)
          {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
          n.callMethod.apply(n,arguments):n.queue.push(arguments)};
          if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
          n.queue=[];t=b.createElement(e);t.async=!0;
          t.src=v;s=b.getElementsByTagName(e)[0];
          s.parentNode.insertBefore(t,s)}(window, document,'script',
          'https://connect.facebook.net/en_US/fbevents.js');
          fbq('init', '${pixelId}');
        `}
      </Script>
      <MetaPixelPageview />
    </>
  );
}

// fbq('init', ...) does NOT auto-fire PageView, and App Router layouts persist
// across client-side navigation — without this the Pixel would record a single
// PageView for an entire session. Mounted only inside the granted branch
// above, so it inherits the consent gate.
function MetaPixelPageview() {
  const pathname = usePathname();

  // Fires on mount (covering both first paint and a mid-session accept) and
  // again on every client-side route change.
  useEffect(() => {
    metaTrack("PageView");
  }, [pathname]);

  return null;
}
