import Link from "next/link";
import { CONTACT, SITE, SOCIAL } from "@/lib/marketing/site";
import { NewsletterForm } from "./newsletter-form";

export function MarketingFooter() {
  return (
    <footer className="bg-[color:var(--color-brand-navy-deep)] text-white">
      {/* Newsletter band */}
      <div className="border-b border-white/10">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-8 sm:px-6 md:flex-row md:items-center md:justify-between lg:px-8">
          <div className="max-w-md">
            <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-white/45">
              Newsletter
            </p>
            <p className="mt-2 text-lg font-extrabold text-white">
              Stay in the loop
            </p>
            <p className="mt-1 text-sm text-white/70">
              Occasional updates on new tests, promos, and schedule changes.{" "}
              <Link
                href="/newsletter"
                className="text-[color:var(--color-brand-cyan-on-navy)] underline underline-offset-2 hover:text-white"
              >
                More about the newsletter →
              </Link>
            </p>
          </div>
          <div className="md:w-96">
            <NewsletterForm source="homepage_footer" variant="footer" />
          </div>
        </div>
      </div>

      {/* Main grid */}
      <div className="mx-auto grid max-w-7xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-4 lg:px-8">
        {/* Brand + contact */}
        <div className="md:col-span-2">
          {/* Serif wordmark */}
          <p className="font-[family-name:var(--font-display)] text-3xl text-white">
            drmed<span className="italic text-[color:var(--color-brand-cyan)]">.ph</span>
          </p>

          <p className="mt-3 max-w-md text-sm text-white/70">
            {CONTACT.address.line1}
            <br />
            {CONTACT.address.line2}, {CONTACT.address.city}
          </p>
          <p className="mt-3 text-sm text-white/70">
            Mobile:{" "}
            <a
              href={`tel:${CONTACT.phone.mobileE164}`}
              className="text-white/70 hover:text-white"
            >
              {CONTACT.phone.mobile}
            </a>
            <br />
            Tel:{" "}
            <a
              href={`tel:${CONTACT.phone.landlineE164}`}
              className="text-white/70 hover:text-white"
            >
              {CONTACT.phone.landline}
            </a>
            <br />
            <a
              href={`mailto:${CONTACT.email}`}
              className="text-white/70 hover:text-white"
            >
              {CONTACT.email}
            </a>
          </p>
          <p className="mt-3 text-sm text-white/70">{CONTACT.hours}</p>
        </div>

        {/* Site links */}
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-white/45">
            Site
          </p>
          <ul className="mt-3 space-y-2 text-sm">
            <li>
              <Link href="/#services" className="text-white/70 hover:text-white">
                Services
              </Link>
            </li>
            <li>
              <Link href="/all-services" className="text-white/70 hover:text-white">
                Check All Services
              </Link>
            </li>
            <li>
              <Link href="/packages" className="text-white/70 hover:text-white">
                Packages
              </Link>
            </li>
            <li>
              <Link href="/schedule" className="text-white/70 hover:text-white">
                Schedule
              </Link>
            </li>
            <li>
              <Link href="/register" className="text-white/70 hover:text-white">
                Pre-register
              </Link>
            </li>
            <li>
              <Link href="/about" className="text-white/70 hover:text-white">
                About
              </Link>
            </li>
            <li>
              <Link href="/contact" className="text-white/70 hover:text-white">
                Contact
              </Link>
            </li>
            <li>
              <Link
                href="/portal/login"
                className="text-white/70 hover:text-white"
              >
                Patient Portal
              </Link>
            </li>
          </ul>
        </div>

        {/* Legal + social */}
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-white/45">
            Legal
          </p>
          <ul className="mt-3 space-y-2 text-sm">
            <li>
              <Link href="/privacy" className="text-white/70 hover:text-white">
                Privacy Notice
              </Link>
            </li>
            <li>
              <Link href="/terms" className="text-white/70 hover:text-white">
                Terms of Use
              </Link>
            </li>
            <li>
              <a
                href={SOCIAL.facebook}
                target="_blank"
                rel="noopener noreferrer"
                className="text-white/70 hover:text-white"
              >
                Facebook
              </a>
            </li>
            <li>
              <a
                href={SOCIAL.instagram}
                target="_blank"
                rel="noopener noreferrer"
                className="text-white/70 hover:text-white"
              >
                Instagram
              </a>
            </li>
          </ul>
        </div>
      </div>

      {/* Bottom bar */}
      <div className="border-t border-white/10">
        <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-3 px-4 py-6 text-xs text-white/50 sm:flex-row sm:items-center sm:px-6 lg:px-8">
          <p>
            © {new Date().getFullYear()} {SITE.name}. Protected under the
            Philippine Data Privacy Act (RA 10173).
          </p>
          <Link
            href="/staff/login"
            className="text-white/40 hover:text-white/70"
          >
            Staff sign in
          </Link>
        </div>
      </div>
    </footer>
  );
}
