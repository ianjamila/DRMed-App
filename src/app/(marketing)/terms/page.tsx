import { PageHero } from "@/components/marketing/page-hero";

export const metadata = {
  title: "Terms of Use",
  description:
    "Terms governing the use of the drmed.ph website and Patient Portal.",
};

export default function TermsPage() {
  return (
    <>
      <PageHero
        eyebrow="Legal"
        title="Terms of Use"
        description="Please read these terms before using drmed.ph or the Patient Portal."
      />

      <article className="mx-auto max-w-3xl px-4 py-12 sm:px-6 lg:px-8">
        <p className="text-sm text-[color:var(--color-ink-soft)]">
          Last updated: April 29, 2026
        </p>

        <p className="mt-4 text-base leading-relaxed text-[color:var(--color-ink-mid)]">
          By accessing drmed.ph or the Patient Portal, you agree to these Terms
          of Use. The website and portal are provided for informational and
          patient-service purposes only and do not substitute professional
          medical advice.
        </p>

        <TermsSection title="Patient Portal access">
          <p>
            The Patient Portal is intended for the patient or an authorized
            representative. Sharing your DRM-ID or Secure PIN with unauthorized
            parties is prohibited. Lost or compromised PINs should be reported to
            reception immediately for re-issuance.
          </p>
        </TermsSection>

        <TermsSection title="Accuracy of information">
          <p>
            DRMed strives to keep service descriptions, prices, and operating
            hours accurate. Prices may change without prior notice. Final pricing
            is confirmed at the clinic upon registration.
          </p>
        </TermsSection>

        <TermsSection title="Limitation of liability">
          <p>
            DRMed is not liable for indirect or consequential losses arising from
            use of this website. Clinical decisions should always be made in
            consultation with a licensed physician.
          </p>
        </TermsSection>

        <TermsSection title="Changes to these terms">
          <p>
            We may update these terms from time to time. Continued use of the
            website after an update constitutes acceptance of the revised terms.
          </p>
        </TermsSection>
      </article>
    </>
  );
}

function TermsSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-8 border-t border-[color:var(--color-warm-line-soft)] pt-8">
      <h2 className="font-[family-name:var(--font-display)] text-xl font-normal text-[color:var(--color-brand-navy)]">
        {title}
      </h2>
      <div className="mt-3 text-base leading-relaxed text-[color:var(--color-ink-mid)]">
        {children}
      </div>
    </section>
  );
}
