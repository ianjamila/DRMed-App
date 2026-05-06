import { NewsletterForm } from "@/components/marketing/newsletter-form";
import { SITE } from "@/lib/marketing/site";

export const metadata = {
  title: `Newsletter — ${SITE.name}`,
  description:
    "Occasional updates from drmed.ph — new tests, schedule changes, and clinic announcements.",
};

export default function NewsletterPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-16 sm:px-6 lg:px-8">
      <header>
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          Newsletter
        </p>
        <h1 className="mt-2 font-[family-name:var(--font-heading)] text-4xl font-extrabold text-[color:var(--color-brand-navy)] sm:text-5xl">
          Stay in the loop
        </h1>
        <p className="mt-4 max-w-xl text-base text-[color:var(--color-brand-text-mid)]">
          Occasional updates from drmed.ph — new tests, package promos,
          schedule changes, and clinic announcements. No spam, unsubscribe
          anytime.
        </p>
      </header>

      <section className="mt-10 rounded-2xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6 sm:p-8">
        <NewsletterForm source="newsletter_page" variant="page" />

        <p className="mt-6 text-xs leading-relaxed text-[color:var(--color-brand-text-soft)]">
          By subscribing, you consent to receive marketing emails from{" "}
          {SITE.name} under the Philippine Data Privacy Act (RA 10173). We
          store only your email address, the date and time you subscribed,
          and your IP. Every email includes a one-click unsubscribe link.
        </p>
      </section>

      <section className="mt-10 text-sm text-[color:var(--color-brand-text-soft)]">
        <p>
          Need lab results, an appointment, or to talk to reception? Use the{" "}
          <a
            href="/portal/login"
            className="text-[color:var(--color-brand-cyan)] hover:underline"
          >
            patient portal
          </a>{" "}
          or{" "}
          <a
            href="/contact"
            className="text-[color:var(--color-brand-cyan)] hover:underline"
          >
            contact page
          </a>{" "}
          — those are separate from the newsletter.
        </p>
      </section>
    </main>
  );
}
