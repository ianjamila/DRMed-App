import Link from "next/link";
import { CONTACT } from "@/lib/marketing/site";

export const metadata = {
  title: "Help — drmed.ph",
};

export default function PatientHelpPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href="/portal"
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← Back to results
      </Link>
      <h1 className="mt-3 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
        Help
      </h1>

      <Section title="Where do I find my Secure PIN?">
        Your 8-character Secure PIN is printed on the receipt reception gave
        you on your visit. It&apos;s case-insensitive on the form (we
        auto-uppercase). Keep it private — anyone with this PIN can view
        your lab results.
      </Section>

      <Section title="Why don't I see my results yet?">
        Results appear here only once they&apos;ve been signed off and
        released by the clinic, AND only after your visit is paid. We&apos;ll
        text and email you the moment a result is released. Most tests turn
        around within 24 hours.
      </Section>

      <Section title="My PIN expired or doesn't work.">
        PINs are valid for 60 days from the visit date. If yours expired or
        you forgot it, please call us and reception will issue a new one
        after verifying your identity.
      </Section>

      <Section title="My account is locked. What now?">
        After 5 wrong PIN attempts the portal locks the account for 15
        minutes. Just wait it out. If you&apos;ve forgotten your PIN, call
        us so we can re-issue.
      </Section>

      <Section title="The download isn't opening.">
        Each download link is good for 5 minutes only. If your browser
        blocked the new tab, allow popups for{" "}
        <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">
          drmed.ph
        </code>{" "}
        and try again.
      </Section>

      <Section title="Privacy">
        Every result access is logged for RA 10173 compliance. Read the
        full notice at{" "}
        <Link
          href="/privacy"
          className="text-[color:var(--color-brand-cyan)] hover:underline"
        >
          /privacy
        </Link>
        .
      </Section>

      <div className="mt-10 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5 text-sm">
        <p className="font-bold text-[color:var(--color-brand-navy)]">
          Still stuck?
        </p>
        <p className="mt-2 text-[color:var(--color-brand-text-mid)]">
          Call{" "}
          <a
            href={`tel:${CONTACT.phone.mobileE164}`}
            className="font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
          >
            {CONTACT.phone.mobile}
          </a>{" "}
          or{" "}
          <a
            href={`tel:${CONTACT.phone.landlineE164}`}
            className="font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
          >
            {CONTACT.phone.landline}
          </a>{" "}
          during {CONTACT.hours}, or email{" "}
          <a
            href={`mailto:${CONTACT.email}`}
            className="font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
          >
            {CONTACT.email}
          </a>
          .
        </p>
      </div>
    </div>
  );
}

function Section({
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
      <p className="mt-2 text-sm leading-relaxed text-[color:var(--color-brand-text-mid)]">
        {children}
      </p>
    </section>
  );
}
