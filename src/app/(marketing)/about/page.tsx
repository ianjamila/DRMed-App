import { HeartHandshake, Target, Users, Award } from "lucide-react";
import { PageHero } from "@/components/marketing/page-hero";
import { SectionHeading, PillLink } from "@/components/marketing/ui";
import { Reveal } from "@/components/marketing/motion";
import { pageMetadata } from "@/lib/marketing/metadata";

export const metadata = pageMetadata({
  title: "About DRMed Clinic & Laboratory",
  description:
    "A family-focused clinic and laboratory in Quezon City offering consultations, lab tests, X-ray, ultrasound, ECG, and home service.",
  path: "/about",
});

// PLACEHOLDER/VERIFY: this Values grid is a NEW section — the four values are
// distilled from the clinic's existing mission/vision/commitment copy (not new
// claims), but the wording wasn't partner-approved. Confirm before launch (see
// DESIGN-NOTES.md). Remove this section if the clinic prefers mission/vision only.
const VALUES = [
  {
    icon: HeartHandshake,
    title: "Compassionate Care",
    body: "We treat every patient with respect and empathy — recognizing the importance of each individual and family who walks through our doors.",
  },
  {
    icon: Target,
    title: "Accountability",
    body: "We are publicly accountable and locally controlled, ensuring every decision serves the community we are privileged to care for.",
  },
  {
    icon: Users,
    title: "Accessibility",
    body: "Quality healthcare should not be a privilege. We offer cost-effective services so every family in our community can access the care they need.",
  },
  {
    icon: Award,
    title: "Excellence",
    body: "We harness the unique talents of our people and leverage new technologies to deliver efficient, effective, and up-to-date patient care.",
  },
] as const;

export default function AboutPage() {
  return (
    <>
      <PageHero
        eyebrow="About Us"
        title="At the heart of your family's health."
        description="DRMed Clinic and Laboratory is committed to being an innovative, publicly accountable, and locally controlled comprehensive healthcare organization."
      />

      {/* Mission + Vision */}
      <section className="py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid gap-10 md:grid-cols-2">
            <Reveal>
              <div className="rounded-[20px] border border-[color:var(--color-warm-line-soft)] bg-white p-8 shadow-[var(--shadow-warm-sm)]">
                <SectionHeading
                  eyebrow="Our Mission"
                  title="Why we exist."
                />
                <p className="mt-4 text-base leading-relaxed text-[color:var(--color-ink-mid)]">
                  DRMed Clinic and Laboratory is committed to being an innovative,
                  publicly accountable, and locally controlled comprehensive
                  healthcare organization. Our focus is on caring for the sick,
                  alleviating suffering, and offering quality, cost-effective
                  services to enhance the health and well-being of our community.
                </p>
              </div>
            </Reveal>

            <Reveal delay={0.1}>
              <div className="rounded-[20px] border border-[color:var(--color-warm-line-soft)] bg-white p-8 shadow-[var(--shadow-warm-sm)]">
                <SectionHeading
                  eyebrow="Our Vision"
                  title="Where we are headed."
                />
                <p className="mt-4 text-base leading-relaxed text-[color:var(--color-ink-mid)]">
                  At DRMed Clinic and Laboratory, employees and physicians take
                  pride in their work, knowing their efforts make a real difference.
                  Patients associate DRMed with satisfaction and confidence,
                  appreciating the convenient, compassionate, and comprehensive care
                  they receive. We strive to improve our community&apos;s health and
                  well-being by delivering compassionate, high-quality, and
                  comprehensive care.
                </p>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* Values */}
      <section className="bg-[color:var(--color-warm-sand)] py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <Reveal>
            <SectionHeading
              eyebrow="Our Values"
              title="What guides everything"
              accent="we do."
              className="mb-10"
            />
          </Reveal>

          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {VALUES.map((value, i) => {
              const Icon = value.icon;
              return (
                <Reveal key={value.title} delay={i * 0.08}>
                  <div className="relative rounded-[20px] border border-[color:var(--color-warm-line-soft)] bg-white p-6 shadow-[var(--shadow-warm-sm)]">
                    <span
                      className="grid h-[42px] w-[42px] place-items-center rounded-[13px] bg-[rgba(8,168,226,0.10)] text-[color:var(--color-brand-cyan)]"
                      aria-hidden="true"
                    >
                      <Icon className="h-5 w-5" />
                    </span>
                    <h3 className="mt-4 text-[17px] font-bold text-[color:var(--color-brand-navy)]">
                      {value.title}
                    </h3>
                    <p className="mt-2 text-[14px] leading-[1.55] text-[color:var(--color-ink-soft)]">
                      {value.body}
                    </p>
                  </div>
                </Reveal>
              );
            })}
          </div>
        </div>
      </section>

      {/* Commitment + Objectives */}
      <section className="bg-[color:var(--color-brand-navy)] py-16 sm:py-20 text-white">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid gap-10 md:grid-cols-2">
            <Reveal>
              <SectionHeading
                light
                eyebrow="Commitment"
                title="Quality and well-being,"
                accent="always."
                description="We are dedicated to offering a wide range of services, harnessing the unique talents of our people, and leveraging new technologies. Our organization is efficient, effective, and rooted in values of public accountability and compassionate care."
              />
            </Reveal>

            <Reveal delay={0.1}>
              <SectionHeading
                light
                eyebrow="Our Objectives"
                title="Comprehensive care"
                accent="for every patient."
                description="DRMed Healthcare Inc., a licensed secondary medical facility, provides residents with access to the latest patient care advancements. We pride ourselves on comprehensive care, exceptional customer service, and added value — recognizing the importance of each patient and family."
              />
            </Reveal>
          </div>

          <Reveal delay={0.15}>
            <div className="mt-12 flex flex-wrap gap-3">
              <PillLink href="/schedule" variant="lineOnDark">
                Book an Appointment
              </PillLink>
              <PillLink href="/physicians" variant="lineOnDark">
                Meet Our Physicians
              </PillLink>
              <PillLink href="/contact" variant="lineOnDark">
                Contact Us
              </PillLink>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  );
}
