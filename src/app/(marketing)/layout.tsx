import { MarketingNav } from "@/components/marketing/marketing-nav";
import { MarketingFooter } from "@/components/marketing/marketing-footer";

export default function MarketingLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <>
      <MarketingNav />
      <main className="flex-1 overflow-x-clip">{children}</main>
      <MarketingFooter />
    </>
  );
}
