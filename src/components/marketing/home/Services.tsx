import {
  Stethoscope,
  TestTube,
  ScanLine,
  HeartPulse,
  AudioWaveform,
  ClipboardCheck,
  House,
  Bus,
  ArrowRight,
  type LucideIcon,
} from "lucide-react";

import { SectionHeading, PillLink } from "@/components/marketing/ui";
import { Reveal } from "@/components/marketing/motion";
import { SERVICE_HIGHLIGHTS } from "@/lib/marketing/site";

// Map service names → Lucide icons. Exhaustive over SERVICE_HIGHLIGHTS.
const ICON_MAP: Record<string, LucideIcon> = {
  "Doctor's Consultation": Stethoscope,
  "Laboratory Tests": TestTube,
  "X-Ray Imaging": ScanLine,
  ECG: HeartPulse,
  Ultrasound: AudioWaveform,
  "Fit to Work / Pre-Employment": ClipboardCheck,
  "Home Service": House,
  "Mobile Clinic": Bus,
};

export function Services() {
  return (
    <section id="services" className="py-[72px]">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        {/* Section header */}
        <Reveal className="mb-[40px] flex flex-wrap items-end justify-between gap-[18px]">
          <SectionHeading
            eyebrow="Clinic & Lab Services"
            title="Everything under"
            accent="one roof."
          />
          <PillLink href="/#packages" variant="navy" size="sm">
            View All Packages <ArrowRight className="h-[18px] w-[18px]" />
          </PillLink>
        </Reveal>

        {/* Services grid */}
        <div className="grid grid-cols-1 gap-[14px] sm:grid-cols-2 lg:grid-cols-4">
          {SERVICE_HIGHLIGHTS.map((svc) => {
            const Icon = ICON_MAP[svc.name] ?? Stethoscope;
            return (
              <Reveal key={svc.name}>
                <div className="rounded-[20px] border border-[color:var(--color-warm-line-soft)] bg-white p-[26px] shadow-[var(--shadow-warm-sm)] transition-[transform,box-shadow] duration-200 hover:-translate-y-1 hover:shadow-[var(--shadow-warm-lg)]">
                  {/* Icon chip */}
                  <span className="grid h-12 w-12 place-items-center rounded-[14px] bg-[rgba(8,168,226,0.10)] text-[color:var(--color-brand-cyan)]">
                    <Icon className="h-6 w-6" aria-hidden="true" />
                  </span>

                  <h3 className="mt-[18px] font-sans text-[17px] font-bold text-[color:var(--color-brand-navy)]">
                    {svc.name}
                  </h3>

                  <p className="mt-2 text-sm leading-relaxed text-[color:var(--color-ink-soft)]">
                    {svc.desc}
                  </p>

                  <div className="mt-4 font-[family-name:var(--font-display)] italic text-[17px] text-[color:var(--color-brand-cyan-text)]">
                    {svc.price}
                  </div>
                </div>
              </Reveal>
            );
          })}
        </div>

        {/* Bottom note */}
        <Reveal>
          <div className="mt-7 flex flex-wrap items-center justify-between gap-4 rounded-[20px] bg-[color:var(--color-warm-sand)] p-[22px_26px]">
            <p className="m-0 text-[14.5px] text-[color:var(--color-ink-mid)]">
              Looking for something specific? We offer{" "}
              <strong className="font-bold text-[color:var(--color-brand-navy)]">
                hundreds of individual tests
              </strong>{" "}
              beyond what&apos;s shown here.
            </p>
            <PillLink href="/all-services" variant="navy" size="sm">
              Check All Services <ArrowRight className="h-[18px] w-[18px]" />
            </PillLink>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
