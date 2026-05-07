"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { NAV_LINKS, SITE } from "@/lib/marketing/site";
import { PatientPortalLauncher } from "./patient-portal-launcher";
import {
  CloseIcon,
  HamburgerIcon,
  MobileDrawer,
} from "@/components/ui/mobile-drawer";

export function MarketingNav() {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <header className="sticky top-0 z-40 w-full border-b border-[color:var(--color-brand-bg-mid)] bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/85">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-2 px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-1 md:gap-3">
          <button
            type="button"
            aria-label="Open menu"
            aria-expanded={open}
            onClick={() => setOpen(true)}
            className="grid h-9 w-9 place-items-center rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white text-[color:var(--color-brand-navy)] transition-colors hover:border-[color:var(--color-brand-cyan)] md:hidden"
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
              width={140}
              height={40}
              priority
              className="h-9 w-auto"
            />
          </Link>
        </div>

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
            href="/all-services"
            className="hidden rounded-md px-3 py-1.5 text-sm font-semibold text-[color:var(--color-brand-navy)] transition-colors hover:bg-[color:var(--color-brand-bg)] hover:text-[color:var(--color-brand-cyan)] md:inline-flex"
          >
            Check All Services
          </Link>
          <PatientPortalLauncher />
          <Link
            href="/schedule"
            className="rounded-md bg-[color:var(--color-brand-cyan)] px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-[color:var(--color-brand-cyan-mid)] sm:px-4 sm:text-sm"
          >
            Book Now
          </Link>
        </div>
      </div>

      <MobileDrawer open={open} onClose={close} label="Site navigation">
        <div className="flex items-center justify-between border-b border-[color:var(--color-brand-bg-mid)] px-5 py-4">
          <Link
            href="/"
            onClick={close}
            aria-label={SITE.name}
            className="flex items-center gap-2"
          >
            <Image
              src="/logo.png"
              alt={SITE.name}
              width={120}
              height={32}
              className="h-8 w-auto"
            />
          </Link>
          <button
            type="button"
            aria-label="Close menu"
            onClick={close}
            className="grid h-9 w-9 place-items-center rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white text-[color:var(--color-brand-navy)] transition-colors hover:border-[color:var(--color-brand-cyan)]"
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
              className="rounded-md px-3 py-3 text-base font-semibold text-[color:var(--color-brand-navy)] transition-colors hover:bg-[color:var(--color-brand-bg)] hover:text-[color:var(--color-brand-cyan)]"
            >
              {link.label}
            </Link>
          ))}
          <Link
            href="/all-services"
            onClick={close}
            className="rounded-md px-3 py-3 text-base font-semibold text-[color:var(--color-brand-navy)] transition-colors hover:bg-[color:var(--color-brand-bg)] hover:text-[color:var(--color-brand-cyan)]"
          >
            Check All Services
          </Link>
        </nav>

        <div className="mt-auto border-t border-[color:var(--color-brand-bg-mid)] p-4">
          <Link
            href="/schedule"
            onClick={close}
            className="block rounded-md bg-[color:var(--color-brand-cyan)] px-4 py-3 text-center text-sm font-semibold text-white shadow-sm transition-colors hover:bg-[color:var(--color-brand-cyan-mid)]"
          >
            Book Now
          </Link>
        </div>
      </MobileDrawer>
    </header>
  );
}
