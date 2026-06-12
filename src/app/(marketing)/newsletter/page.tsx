import { PageHero } from "@/components/marketing/page-hero";
import { NewsletterForm } from "@/components/marketing/newsletter-form";
import { SITE } from "@/lib/marketing/site";

export const metadata = {
  title: `Newsletter — ${SITE.name}`,
  description:
    "Occasional updates from drmed.ph — new tests, schedule changes, and clinic announcements.",
};

export default function NewsletterPage() {
  return (
    <>
      <PageHero
        eyebrow="Newsletter"
        title="Stay in the loop."
        description="Occasional updates from drmed.ph — new tests, package promos, schedule changes, and clinic announcements. No spam, unsubscribe anytime."
      />

      <section className="py-12 sm:py-16">
        <div className="mx-auto max-w-2xl px-4 sm:px-6">
          <div className="rounded-[20px] border border-[color:var(--color-warm-line-soft)] bg-white p-8 shadow-[var(--shadow-warm-sm)]">
            <NewsletterForm source="newsletter_page" variant="page" />

            <p className="mt-6 text-xs leading-relaxed text-[color:var(--color-ink-soft)]">
              By subscribing, you consent to receive marketing emails from{" "}
              {SITE.name} under the Philippine Data Privacy Act (RA 10173). We
              store only your email address, the date and time you subscribed,
              and your IP. Every email includes a one-click unsubscribe link.
            </p>
          </div>

          <p className="mt-6 text-sm text-[color:var(--color-ink-soft)]">
            Need lab results, an appointment, or to talk to reception? Use the{" "}
            <a
              href="/portal/login"
              className="text-[color:var(--color-brand-cyan-text)] underline underline-offset-2"
            >
              patient portal
            </a>{" "}
            or{" "}
            <a
              href="/contact"
              className="text-[color:var(--color-brand-cyan-text)] underline underline-offset-2"
            >
              contact page
            </a>{" "}
            — those are separate from the newsletter.
          </p>
        </div>
      </section>
    </>
  );
}
