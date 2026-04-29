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

      <article className="mx-auto max-w-3xl space-y-6 px-4 py-12 text-base leading-relaxed text-[color:var(--color-brand-text-mid)] sm:px-6 lg:px-8">
        <p className="text-sm text-[color:var(--color-brand-text-soft)]">
          Last updated: April 29, 2026
        </p>

        <p>
          By accessing drmed.ph or the Patient Portal, you agree to these Terms
          of Use. The website and portal are provided for informational and
          patient-service purposes only and do not substitute professional
          medical advice.
        </p>

        <h2 className="mt-6 font-[family-name:var(--font-heading)] text-lg font-extrabold text-[color:var(--color-brand-navy)]">
          Patient Portal access
        </h2>
        <p>
          The Patient Portal is intended for the patient or an authorized
          representative. Sharing your DRM-ID or Secure PIN with unauthorized
          parties is prohibited. Lost or compromised PINs should be reported to
          reception immediately for re-issuance.
        </p>

        <h2 className="mt-6 font-[family-name:var(--font-heading)] text-lg font-extrabold text-[color:var(--color-brand-navy)]">
          Accuracy of information
        </h2>
        <p>
          DRMed strives to keep service descriptions, prices, and operating
          hours accurate. Prices may change without prior notice. Final pricing
          is confirmed at the clinic upon registration.
        </p>

        <h2 className="mt-6 font-[family-name:var(--font-heading)] text-lg font-extrabold text-[color:var(--color-brand-navy)]">
          Limitation of liability
        </h2>
        <p>
          DRMed is not liable for indirect or consequential losses arising from
          use of this website. Clinical decisions should always be made in
          consultation with a licensed physician.
        </p>

        <h2 className="mt-6 font-[family-name:var(--font-heading)] text-lg font-extrabold text-[color:var(--color-brand-navy)]">
          Changes to these terms
        </h2>
        <p>
          We may update these terms from time to time. Continued use of the
          website after an update constitutes acceptance of the revised terms.
        </p>
      </article>
    </>
  );
}
