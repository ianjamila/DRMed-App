import { Analytics } from "@vercel/analytics/next";
import { MotionConfig } from "motion/react";
import { MarketingNav } from "@/components/marketing/marketing-nav";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { ScrollPulse } from "@/components/marketing/motion";
import { MessengerFab } from "@/components/marketing/messenger-fab";
import { HideOnPaths } from "@/components/marketing/hide-on-paths";
import { CookieConsentProvider } from "@/components/marketing/cookie-consent";
import { MetaPixel } from "@/components/marketing/meta-pixel";

// /schedule uses the bundle's focused-funnel layout — its own header/footer,
// no marketing nav/footer/FAB (C12). MarketingNav opts out internally.
const FOCUSED_ROUTES = ["/schedule"];

// Marketing pages only — never mounted on /portal or /staff (RA 10173).
// Unset in an env without the pixel configured yet (e.g. fresh local clone);
// every consumer (metaTrack, sendMetaCapiEvent) already no-ops gracefully.
// <MetaPixel> additionally gates on the visitor's opt-in consent.
const META_PIXEL_ID = process.env.NEXT_PUBLIC_META_PIXEL_ID;

export default function MarketingLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // reducedMotion="user" makes every motion primitive honor the OS preference
    // (skip transforms, keep opacity) WITHOUT branching the rendered DOM on it —
    // so reduced-motion clients hydrate cleanly.
    <MotionConfig reducedMotion="user">
      <CookieConsentProvider>
        {META_PIXEL_ID ? <MetaPixel pixelId={META_PIXEL_ID} /> : null}
        <ScrollPulse />
        <MarketingNav />
        <main className="flex-1 overflow-x-clip bg-[color:var(--color-warm-bg)] text-[color:var(--color-ink)]">
          {children}
        </main>
        <HideOnPaths paths={FOCUSED_ROUTES}>
          <MarketingFooter />
          <MessengerFab />
        </HideOnPaths>
        <Analytics />
      </CookieConsentProvider>
    </MotionConfig>
  );
}
