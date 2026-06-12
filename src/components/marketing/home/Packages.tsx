import { Check, ArrowRight } from "lucide-react";

import { SectionHeading, PillLink } from "@/components/marketing/ui";
import { Reveal } from "@/components/marketing/motion";
import { PACKAGE_GROUPS } from "@/lib/marketing/site";

export function Packages() {
  return (
    <section
      id="packages"
      className="bg-[color:var(--color-brand-navy)] py-[72px] text-white"
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        {/* Section header */}
        <Reveal className="mb-[40px] flex flex-wrap items-end justify-between gap-[18px]">
          <SectionHeading
            light
            eyebrow="Health Packages"
            title="Diagnostic"
            accent="packages."
            description="Quick overview of our most requested package groups. For full inclusions, exact test lists, and complete price details, open the detailed packages page."
          />
          <div className="flex flex-wrap gap-[10px]">
            <PillLink href="/packages" variant="cyan" size="sm">
              View Detailed Packages <ArrowRight className="h-[18px] w-[18px]" />
            </PillLink>
            <PillLink href="/#contact" variant="lineOnDark" size="sm">
              Custom Corporate Package
            </PillLink>
          </div>
        </Reveal>

        {/* Packages grid */}
        <div className="grid grid-cols-1 gap-[14px] sm:grid-cols-2 lg:grid-cols-4">
          {PACKAGE_GROUPS.map((pkg) => (
            <Reveal key={pkg.type}>
              <div className="rounded-[20px] border border-white/[0.12] bg-white/[0.05] p-[26px] transition-[background,transform] duration-200 hover:-translate-y-1 hover:bg-white/[0.09]">
                <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-[color:var(--color-brand-cyan-on-navy)]">
                  {pkg.type}
                </div>

                <h3 className="mt-3 font-[family-name:var(--font-display)] text-2xl leading-[1.15]">
                  {pkg.title}
                </h3>

                <p className="mt-2.5 text-sm text-white/70">{pkg.desc}</p>

                <div className="mt-4 font-[family-name:var(--font-display)] italic text-[18px] text-[#9BDCF7]">
                  {pkg.range}
                </div>

                <ul className="mt-4 flex flex-col gap-[7px] border-t border-white/[0.12] pt-4 text-[13.5px] text-white/[0.72]">
                  {pkg.items.map((item) => (
                    <li key={item} className="flex items-center gap-[9px]">
                      <Check
                        className="h-3.5 w-3.5 shrink-0 text-[color:var(--color-brand-cyan)]"
                        aria-hidden="true"
                      />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            </Reveal>
          ))}
        </div>

        {/* Fine print */}
        <Reveal>
          <p className="mt-7 text-center text-xs text-white/50">
            Detailed package inclusions and prices are available on the
            dedicated page. Prices may change without prior notice.
          </p>
        </Reveal>
      </div>
    </section>
  );
}
