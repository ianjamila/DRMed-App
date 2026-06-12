import { SectionHeading } from "@/components/marketing/ui";
import { HmoTicker } from "@/components/marketing/hmo-ticker";

export function HmoSection() {
  return (
    <section id="hmo" className="bg-[#F2F6FA] py-[72px] text-center">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          centered
          eyebrow="Accredited HMO Partners"
          title="We accept your"
          accent="HMO."
          description="Present your HMO card at the clinic. Cashless transactions available for all covered services."
        />
      </div>

      {/* Ticker extends to full width — outside the inner padding wrapper */}
      <div className="mt-10">
        <HmoTicker />
      </div>
    </section>
  );
}
