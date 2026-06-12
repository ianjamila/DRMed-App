import { ArrowRight, Info } from "lucide-react";

import { SectionHeading, PillLink } from "@/components/marketing/ui";
import { Reveal } from "@/components/marketing/motion";
import { DoctorPhoto } from "./DoctorPhoto";

interface Physician {
  name: string;
  specialty: string;
  photoUrl: string;
}

interface SpecialistsProps {
  physicians: Physician[];
  totalCount: number;
}

export function Specialists({ physicians, totalCount }: SpecialistsProps) {
  return (
    <section id="doctors" className="py-[72px]">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        {/* Section header */}
        <Reveal className="mb-[40px] flex flex-wrap items-end justify-between gap-[18px]">
          <SectionHeading
            eyebrow="Our Specialists"
            title="Meet our"
            accent="doctors."
            description={`DRMed has ${totalCount}+ board-certified physicians across key specialties. For complete schedules and doctor photos, open the detailed schedules page.`}
          />
          <PillLink href="/physicians" variant="navy" size="sm">
            View Detailed Schedules <ArrowRight className="h-[18px] w-[18px]" />
          </PillLink>
        </Reveal>

        {/* Doctors grid */}
        <div className="grid grid-cols-2 gap-[14px] sm:grid-cols-3 lg:grid-cols-6">
          {physicians.map((doc) => (
            <Reveal key={doc.name}>
              <div className="group overflow-hidden rounded-[20px] border border-[color:var(--color-warm-line-soft)] bg-white shadow-[var(--shadow-warm-sm)] transition-[transform,box-shadow] duration-200 hover:-translate-y-1 hover:shadow-[var(--shadow-warm-lg)]">
                {/* Photo frame */}
                <div className="relative aspect-[3/4] overflow-hidden bg-[color:var(--color-warm-sand)]">
                  <DoctorPhoto photoUrl={doc.photoUrl} name={doc.name} />
                </div>

                {/* Body */}
                <div className="p-[14px_16px_18px]">
                  <div className="text-[10.5px] font-bold uppercase tracking-[0.1em] text-[color:var(--color-brand-cyan-text)]">
                    {doc.specialty}
                  </div>
                  <div className="mt-1.5 font-[family-name:var(--font-display)] text-[16px] leading-[1.2] text-[color:var(--color-brand-navy)]">
                    {doc.name}
                  </div>
                </div>
              </div>
            </Reveal>
          ))}
        </div>

        {/* Bottom note */}
        <Reveal>
          <div className="mt-7 flex flex-wrap items-center justify-between gap-4 rounded-[18px] border border-[color:var(--color-warm-line-soft)] bg-white p-[18px_22px]">
            <p className="flex items-center gap-[9px] text-[13.5px] text-[color:var(--color-ink-mid)]">
              <Info
                className="h-[17px] w-[17px] shrink-0 text-[color:var(--color-brand-cyan)]"
                aria-hidden="true"
              />
              Schedules may change without prior notice. Kindly call or message
              us to book your appointment and confirm availability.
            </p>
            <PillLink href="/schedule" variant="line" size="sm">
              Book an Appointment
            </PillLink>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
