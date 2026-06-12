import { MarketingNav } from "@/components/marketing/marketing-nav";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { ScrollPulse } from "@/components/marketing/motion";
import { MessengerFab } from "@/components/marketing/messenger-fab";

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
      <MarketingFooter />
      <MessengerFab />
    </>
  );
}
