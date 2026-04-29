import { PageHero } from "@/components/marketing/page-hero";

export const metadata = {
  title: "About",
  description:
    "DRMed Clinic and Laboratory is committed to comprehensive, compassionate, and accessible healthcare for the Quezon City community.",
};

export default function AboutPage() {
  return (
    <>
      <PageHero
        eyebrow="About Us"
        title="At the heart of your family's health."
        description="DRMed Clinic and Laboratory is committed to being an innovative, publicly accountable, and locally controlled comprehensive healthcare organization."
      />

      <section className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <div className="grid gap-10 md:grid-cols-2">
          <div>
            <h2 className="font-[family-name:var(--font-heading)] text-2xl font-extrabold text-[color:var(--color-brand-navy)]">
              Our Mission
            </h2>
            <p className="mt-4 text-base leading-relaxed text-[color:var(--color-brand-text-mid)]">
              DRMed Clinic and Laboratory is committed to being an innovative,
              publicly accountable, and locally controlled comprehensive
              healthcare organization. Our focus is on caring for the sick,
              alleviating suffering, and offering quality, cost-effective
              services to enhance the health and well-being of our community.
            </p>
          </div>
          <div>
            <h2 className="font-[family-name:var(--font-heading)] text-2xl font-extrabold text-[color:var(--color-brand-navy)]">
              Our Vision
            </h2>
            <p className="mt-4 text-base leading-relaxed text-[color:var(--color-brand-text-mid)]">
              At DRMed Clinic and Laboratory, employees and physicians take
              pride in their work, knowing their efforts make a real difference.
              Patients associate DRMed with satisfaction and confidence,
              appreciating the convenient, compassionate, and comprehensive care
              they receive. We strive to improve our community&apos;s health and
              well-being by delivering compassionate, high-quality, and
              comprehensive care.
            </p>
          </div>
        </div>
      </section>

      <section className="bg-[color:var(--color-brand-navy)] text-white">
        <div className="mx-auto grid max-w-7xl gap-10 px-4 py-16 sm:px-6 md:grid-cols-2 lg:px-8">
          <div>
            <h2 className="font-[family-name:var(--font-heading)] text-2xl font-extrabold">
              Our Commitment to Quality and Well-Being
            </h2>
            <p className="mt-4 text-base leading-relaxed text-white/80">
              We are dedicated to offering a wide range of services, harnessing
              the unique talents of our people, and leveraging new technologies.
              Our organization is efficient, effective, and rooted in values of
              public accountability and compassionate care.
            </p>
          </div>
          <div>
            <h2 className="font-[family-name:var(--font-heading)] text-2xl font-extrabold">
              Our Objectives
            </h2>
            <p className="mt-4 text-base leading-relaxed text-white/80">
              DRMed Healthcare Inc., a licensed secondary medical facility,
              provides residents with access to the latest patient care
              advancements. We pride ourselves on comprehensive care,
              exceptional customer service, and added value — recognizing the
              importance of each patient and family.
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
