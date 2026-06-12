import { MarketingNav } from "@/components/marketing/marketing-nav";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { ScrollPulse } from "@/components/marketing/motion";
import { MessengerFab } from "@/components/marketing/messenger-fab";
import { HideOnPaths } from "@/components/marketing/hide-on-paths";

// /schedule uses the bundle's focused-funnel layout — its own header/footer,
// no marketing nav/footer/FAB (C12). MarketingNav opts out internally.
const FOCUSED_ROUTES = ["/schedule"];

export default function MarketingLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <>
      <ScrollPulse />
      <MarketingNav />
      <main className="flex-1 overflow-x-clip bg-[color:var(--color-warm-bg)] text-[color:var(--color-ink)]">
        {children}
      </main>
      <HideOnPaths paths={FOCUSED_ROUTES}>
        <MarketingFooter />
        <MessengerFab />
      </HideOnPaths>
    </>
  );
}
