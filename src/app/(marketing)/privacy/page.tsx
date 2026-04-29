import Link from "next/link";
import { PageHero } from "@/components/marketing/page-hero";
import { CONTACT } from "@/lib/marketing/site";

export const metadata = {
  title: "Data Privacy Notice",
  description:
    "How DRMed Clinic and Laboratory collects, uses, stores, and protects personal data in compliance with the Data Privacy Act of 2012 (RA 10173).",
};

export default function PrivacyPage() {
  return (
    <>
      <PageHero
        eyebrow="Legal"
        title="Data Privacy Notice"
        description="How DRMed Clinic and Laboratory handles your personal data under the Philippine Data Privacy Act of 2012 (RA 10173)."
      />

      <article className="mx-auto max-w-3xl px-4 py-12 sm:px-6 lg:px-8">
        <p className="text-sm text-[color:var(--color-brand-text-soft)]">
          Last updated: April 29, 2026
        </p>
        <p className="mt-4 text-base leading-relaxed text-[color:var(--color-brand-text-mid)]">
          This notice explains how DRMed Clinic and Laboratory collects, uses,
          stores, and protects personal data in compliance with the Data
          Privacy Act of 2012 (RA 10173) and applicable NPC issuances.
        </p>

        <PrivacySection title="1. Personal Information Controller">
          <p>
            DRMed Clinic and Laboratory
            <br />
            {CONTACT.address.line1}, {CONTACT.address.line2},{" "}
            {CONTACT.address.city}
            <br />
            Mobile:{" "}
            <a
              href={`tel:${CONTACT.phone.mobileE164}`}
              className="text-[color:var(--color-brand-cyan)] hover:underline"
            >
              {CONTACT.phone.mobile}
            </a>
            <br />
            Telephone:{" "}
            <a
              href={`tel:${CONTACT.phone.landlineE164}`}
              className="text-[color:var(--color-brand-cyan)] hover:underline"
            >
              {CONTACT.phone.landline}
            </a>
          </p>
        </PrivacySection>

        <PrivacySection title="2. Personal Data We Process">
          <ul className="ml-5 list-disc space-y-2">
            <li>
              Patient identification details (for example: name, DRM-ID, and
              portal login details).
            </li>
            <li>
              Laboratory transaction information (for example: test names,
              dates, status, and released reports).
            </li>
            <li>
              Security metadata (for example: timestamp, hashed IP and hashed
              user-agent for consent and access logging).
            </li>
          </ul>
        </PrivacySection>

        <PrivacySection title="3. Purpose of Processing">
          <ul className="ml-5 list-disc space-y-2">
            <li>Verify patient identity for secure release of test results.</li>
            <li>Provide laboratory report access and test status tracking.</li>
            <li>
              Maintain service security, fraud prevention, and audit trail
              records.
            </li>
            <li>
              Comply with legal, regulatory, and medical record obligations.
            </li>
          </ul>
        </PrivacySection>

        <PrivacySection title="4. Legal Basis">
          <p>
            Processing is based on consent, fulfillment of healthcare service
            obligations, legitimate interests in securing systems, and
            compliance with legal obligations under Philippine law.
          </p>
        </PrivacySection>

        <PrivacySection title="5. Data Sharing">
          <p>
            Data may be processed by authorized service providers used for
            operations (such as secured cloud hosting, document storage, and
            anti-bot protection) under confidentiality and data protection
            controls. Data is not sold to third parties.
          </p>
        </PrivacySection>

        <PrivacySection title="6. Retention">
          <p>
            Data is retained only as long as necessary for medical, legal, and
            operational purposes, and disposed of securely based on DRMed
            retention schedules and legal requirements.
          </p>
        </PrivacySection>

        <PrivacySection title="7. Your Rights as Data Subject">
          <ul className="ml-5 list-disc space-y-2">
            <li>Right to be informed</li>
            <li>Right to access</li>
            <li>Right to object</li>
            <li>Right to rectification</li>
            <li>Right to erasure or blocking, when legally applicable</li>
            <li>Right to data portability, when applicable</li>
            <li>Right to damages and complaint</li>
          </ul>
        </PrivacySection>

        <PrivacySection title="8. Security Measures">
          <p>
            DRMed implements administrative, physical, and technical safeguards
            including access controls, secure transmission, rate limiting, and
            audit logging for portal activities.
          </p>
        </PrivacySection>

        <PrivacySection title="9. Consent and Portal Access Logs">
          <p>
            When you submit portal credentials and accept this notice, we may
            record consent metadata such as DRM-ID, timestamp, privacy notice
            version, and hashed client identifiers for compliance and security
            verification.
          </p>
        </PrivacySection>

        <PrivacySection title="10. Updates to This Notice">
          <p>
            We may update this notice from time to time. The latest posted
            version on this page applies.
          </p>
        </PrivacySection>

        <PrivacySection title="11. Contact for Privacy Requests">
          <p>
            For privacy-related requests (access, correction, or complaints),
            contact DRMed through the numbers listed above or through{" "}
            <Link
              href="/contact"
              className="text-[color:var(--color-brand-cyan)] hover:underline"
            >
              our contact form
            </Link>
            .
          </p>
        </PrivacySection>
      </article>
    </>
  );
}

function PrivacySection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-8">
      <h2 className="font-[family-name:var(--font-heading)] text-lg font-extrabold text-[color:var(--color-brand-navy)]">
        {title}
      </h2>
      <div className="mt-3 text-base leading-relaxed text-[color:var(--color-brand-text-mid)]">
        {children}
      </div>
    </section>
  );
}
