import Link from "next/link";
import { PageHero } from "@/components/marketing/page-hero";
import { CONTACT } from "@/lib/marketing/site";
import { TrackedTelLink } from "@/components/marketing/tracked-tel-link";

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
        <p className="text-sm text-[color:var(--color-ink-soft)]">
          Last updated: July 26, 2026
        </p>
        <p className="mt-4 text-base leading-relaxed text-[color:var(--color-ink-mid)]">
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
            <TrackedTelLink
              href={`tel:${CONTACT.phone.mobileE164}`}
              label="privacy_page"
              className="text-[color:var(--color-brand-cyan-text)] underline underline-offset-2"
            >
              {CONTACT.phone.mobile}
            </TrackedTelLink>
            <br />
            Telephone:{" "}
            <TrackedTelLink
              href={`tel:${CONTACT.phone.landlineE164}`}
              label="privacy_page"
              className="text-[color:var(--color-brand-cyan-text)] underline underline-offset-2"
            >
              {CONTACT.phone.landline}
            </TrackedTelLink>
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
            <li>
              Public-website activity (for example: pages viewed, whether a
              booking or inquiry form was completed, and the advertising
              campaign you arrived from). Collected on our public pages only —
              never in the Patient Portal or Staff Portal. See Section 6.
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
            <li>
              Measure how our public website and advertising perform, so we can
              improve them. This uses website-activity data only — never your
              health information. See Section 6.
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
          <p className="mt-3">
            We also use the advertising and analytics providers described in
            Section 6. These providers receive only website-activity data — they
            are never given your medical records, laboratory results, DRM-ID, or
            any other health information.
          </p>
        </PrivacySection>

        <PrivacySection title="6. Cookies, Analytics and Advertising">
          <p>
            Our <strong>public website only</strong> uses cookies and
            measurement tools to understand how visitors find us and to measure
            the effectiveness of our advertising. These tools are{" "}
            <strong>
              never active inside the Patient Portal or the Staff Portal
            </strong>
            , and they never have access to laboratory results, medical
            records, or any health information.
          </p>

          <p className="mt-3 font-medium text-[color:var(--color-brand-navy)]">
            What we use
          </p>
          <ul className="mt-2 ml-5 list-disc space-y-2">
            <li>
              <strong>Website analytics</strong> — aggregated page-visit
              statistics that tell us which pages are useful, without
              identifying you personally.
            </li>
            <li>
              <strong>Meta (Facebook) Pixel and Conversions API</strong> — used
              only on our public pages to measure the results of our Facebook
              and Instagram advertising. It records that an action happened
              (for example: a page was viewed, a booking form was completed, or
              a phone number was tapped) together with a randomly generated
              reference used solely to avoid counting the same action twice.
            </li>
            <li>
              <strong>Campaign reference cookie</strong> — if you arrive from an
              advertisement, we store the campaign name in a first-party cookie
              for up to <strong>30 days</strong> so we can tell which campaign
              led to an inquiry.
            </li>
          </ul>

          <p className="mt-3 font-medium text-[color:var(--color-brand-navy)]">
            What is never shared
          </p>
          <ul className="mt-2 ml-5 list-disc space-y-2">
            <li>
              We do <strong>not</strong> send your name, DRM-ID, contact
              details, chosen tests, medical conditions, or results to any
              advertising platform.
            </li>
            <li>
              We do <strong>not</strong> use these tools to build health-related
              advertising audiences, and we do not advertise based on any
              condition or test a person may be interested in.
            </li>
            <li>
              We do <strong>not</strong> sell personal data.
            </li>
          </ul>

          <p className="mt-3 font-medium text-[color:var(--color-brand-navy)]">
            Your choices
          </p>
          <p className="mt-2">
            <strong>
              We ask before any of this is switched on.
            </strong>{" "}
            On your first visit we show a short banner, and the measurement
            tools described above stay completely off — no Meta Pixel, no
            campaign cookie — unless you press{" "}
            <strong>Accept</strong>. If you press <strong>Decline</strong>, or
            simply ignore the banner, nothing is loaded and nothing is sent.
          </p>
          <p className="mt-3">
            You can change your mind at any time using the{" "}
            <strong>Cookie preferences</strong> link at the bottom of any page.
            Choosing Decline also deletes any measurement cookies already
            stored on your device. You can additionally block or delete cookies
            through your browser settings.
          </p>
          <p className="mt-3">
            Booking, registration, and portal access work exactly the same
            whichever you choose — we never restrict access to care or to your
            results based on this decision. You may also object to this
            processing by contacting us using the details in Section 12.
          </p>
        </PrivacySection>

        <PrivacySection title="7. Retention">
          <p>
            Data is retained only as long as necessary for medical, legal, and
            operational purposes, and disposed of securely based on DRMed
            retention schedules and legal requirements.
          </p>
        </PrivacySection>

        <PrivacySection title="8. Your Rights as Data Subject">
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

        <PrivacySection title="9. Security Measures">
          <p>
            DRMed implements administrative, physical, and technical safeguards
            including access controls, secure transmission, rate limiting, and
            audit logging for portal activities.
          </p>
        </PrivacySection>

        <PrivacySection title="10. Consent and Portal Access Logs">
          <p>
            When you submit portal credentials and accept this notice, we may
            record consent metadata such as DRM-ID, timestamp, privacy notice
            version, and hashed client identifiers for compliance and security
            verification.
          </p>
        </PrivacySection>

        <PrivacySection title="11. Updates to This Notice">
          <p>
            We may update this notice from time to time. The latest posted
            version on this page applies.
          </p>
        </PrivacySection>

        <PrivacySection title="12. Contact for Privacy Requests">
          <p>
            For privacy-related requests (access, correction, or complaints),
            contact DRMed through the numbers listed above or through{" "}
            <Link
              href="/contact"
              className="text-[color:var(--color-brand-cyan-text)] underline underline-offset-2"
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
