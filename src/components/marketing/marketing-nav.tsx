"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { NAV_LINKS, SITE } from "@/lib/marketing/site";
import { PatientPortalLauncher } from "./patient-portal-launcher";
import {
  CloseIcon,
  HamburgerIcon,
  MobileDrawer,
} from "@/components/ui/mobile-drawer";

// Routes that use the focused-funnel layout (no marketing nav). See HideOnPaths.
const FOCUSED_ROUTES = ["/schedule"];

export function MarketingNav() {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const pathname = usePathname();

  // Condense-on-scroll: shrink header after 420px. Initialize false to avoid
  // hydration mismatch — updated only after mount via passive scroll listener.
  const [isCondensed, setIsCondensed] = useState(false);

  useEffect(() => {
    const onScroll = () => {
      setIsCondensed(window.scrollY > 420);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  if (FOCUSED_ROUTES.includes(pathname)) return null;

  return (
    <header
      className={[
        "sticky top-0 z-50 w-full",
        "bg-[rgba(251,249,245,0.88)] backdrop-blur-[10px] supports-[backdrop-filter]:bg-[rgba(251,249,245,0.85)]",
        "border-b border-[color:var(--color-warm-line-soft)]",
        "transition-[box-shadow] duration-300",
        isCondensed ? "shadow-[var(--shadow-warm-sm)]" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div
        className={[
          "mx-auto flex max-w-7xl items-center justify-between gap-2 px-4 sm:px-6 lg:px-8",
          "transition-[height] duration-300 ease-[cubic-bezier(0.2,0.7,0.3,1)]",
          isCondensed ? "h-[56px]" : "h-[68px]",
        ].join(" ")}
      >
        {/* Left: burger (mobile) + logo */}
        <div className="flex items-center gap-1 md:gap-3">
          <button
            type="button"
            aria-label="Open menu"
            aria-expanded={open}
            onClick={() => setOpen(true)}
            className="grid h-11 w-11 place-items-center rounded-full border border-[color:var(--color-warm-line)] bg-white text-[color:var(--color-brand-navy)] transition-colors hover:border-[color:var(--color-brand-cyan)] md:hidden"
          >
            <HamburgerIcon />
          </button>
          <Link
            href="/"
            aria-label={SITE.name}
            className="flex items-center gap-2"
          >
            <Image
              src="/logo.png"
              alt={SITE.name}
              width={88}
              height={34}
              priority
              sizes="88px"
              className={[
                "w-auto transition-[height] duration-300 ease-[cubic-bezier(0.2,0.7,0.3,1)]",
                isCondensed ? "h-[28px]" : "h-[34px]",
              ].join(" ")}
            />
          </Link>
        </div>

        {/* Centre: desktop nav links */}
        <nav className="hidden items-center gap-0.5 md:flex">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="rounded-full px-[13px] py-[9px] text-sm font-semibold text-[color:var(--color-brand-navy)] transition-colors hover:bg-[color:var(--color-warm-sand)] hover:text-[color:var(--color-brand-cyan-text)]"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        {/* Right: Check All Services + Portal + Book Now */}
        <div className="flex items-center gap-2">
          <Link
            href="/all-services"
            className="hidden rounded-full px-[13px] py-[9px] text-sm font-semibold text-[color:var(--color-brand-navy)] transition-colors hover:bg-[color:var(--color-warm-sand)] hover:text-[color:var(--color-brand-cyan-text)] md:inline-flex"
          >
            Check All Services
          </Link>
          <PatientPortalLauncher />
          <Link
            href="/schedule"
            className="rounded-full bg-[color:var(--color-brand-cyan)] px-5 py-2.5 text-sm font-bold text-[color:var(--color-ink)] shadow-[var(--shadow-warm-sm)] transition-all hover:bg-[color:var(--color-brand-navy)] hover:text-white hover:-translate-y-px hover:shadow-[var(--shadow-warm-lg)]"
          >
            Book Now
          </Link>
        </div>
      </div>

      {/* Mobile drawer */}
      <MobileDrawer open={open} onClose={close} label="Site navigation">
        <div className="flex items-center justify-between border-b border-[color:var(--color-warm-line)] px-5 py-4">
          <Link
            href="/"
            onClick={close}
            aria-label={SITE.name}
            className="flex items-center gap-2"
          >
            <Image
              src="/logo.png"
              alt={SITE.name}
              width={83}
              height={32}
              sizes="83px"
              className="h-8 w-auto"
            />
          </Link>
          <button
            type="button"
            aria-label="Close menu"
            onClick={close}
            className="grid h-11 w-11 place-items-center rounded-full border border-[color:var(--color-warm-line)] bg-white text-[color:var(--color-brand-navy)] transition-colors hover:border-[color:var(--color-brand-cyan)]"
          >
            <CloseIcon />
          </button>
        </div>

        <nav className="flex flex-col gap-1 px-3 py-4">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={close}
              className="rounded-full px-3 py-3 text-base font-semibold text-[color:var(--color-brand-navy)] transition-colors hover:bg-[color:var(--color-warm-sand)] hover:text-[color:var(--color-brand-cyan-text)]"
            >
              {link.label}
            </Link>
          ))}
          <Link
            href="/all-services"
            onClick={close}
            className="rounded-full px-3 py-3 text-base font-semibold text-[color:var(--color-brand-navy)] transition-colors hover:bg-[color:var(--color-warm-sand)] hover:text-[color:var(--color-brand-cyan-text)]"
          >
            Check All Services
          </Link>
          <Link
            href="/portal/login"
            onClick={close}
            className="rounded-full px-3 py-3 text-base font-semibold text-[color:var(--color-brand-navy)] transition-colors hover:bg-[color:var(--color-warm-sand)] hover:text-[color:var(--color-brand-cyan-text)]"
          >
            Patient Portal
          </Link>
        </nav>

        <div className="mt-auto border-t border-[color:var(--color-warm-line)] p-4">
          <Link
            href="/schedule"
            onClick={close}
            className="block rounded-full bg-[color:var(--color-brand-cyan)] px-4 py-3 text-center text-sm font-bold text-[color:var(--color-ink)] shadow-[var(--shadow-warm-sm)] transition-all hover:bg-[color:var(--color-brand-navy)] hover:text-white"
          >
            Book Now
          </Link>
        </div>
      </MobileDrawer>
    </header>
  );
}
