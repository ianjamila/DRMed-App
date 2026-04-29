import Link from "next/link";
import { NAV_LINKS, SITE } from "@/lib/marketing/site";

export function MarketingNav() {
  return (
    <header className="sticky top-0 z-40 w-full border-b border-[color:var(--color-brand-bg-mid)] bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/85">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <Link
          href="/"
          className="flex items-center gap-2 font-[family-name:var(--font-heading)] text-lg font-extrabold tracking-tight text-[color:var(--color-brand-navy)]"
        >
          <span>drmed</span>
          <span className="text-[color:var(--color-brand-cyan)]">.ph</span>
        </Link>

        <nav className="hidden items-center gap-1 md:flex">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="rounded-md px-3 py-2 text-sm font-semibold text-[color:var(--color-brand-navy)] transition-colors hover:bg-[color:var(--color-brand-bg)] hover:text-[color:var(--color-brand-cyan)]"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <Link
            href="/portal/login"
            className="hidden rounded-md border border-[color:var(--color-brand-navy)] px-3 py-1.5 text-sm font-semibold text-[color:var(--color-brand-navy)] transition-colors hover:bg-[color:var(--color-brand-navy)] hover:text-white sm:inline-block"
          >
            Patient Portal
          </Link>
          <Link
            href="/contact"
            className="rounded-md bg-[color:var(--color-brand-cyan)] px-4 py-1.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-[color:var(--color-brand-cyan-mid)]"
          >
            Book Now
          </Link>
        </div>
      </div>
      <span className="sr-only">{SITE.name}</span>
    </header>
  );
}
