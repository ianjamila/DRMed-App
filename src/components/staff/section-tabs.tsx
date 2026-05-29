"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { sectionTabsNavClass, sectionTabClass } from "./section-tabs-style";

export interface SectionTab {
  href: string;
  label: string;
  // Active only on the exact href (or href + "/"). Use for an "overview"-style
  // tab whose href is a prefix of its sibling tabs' hrefs, so it doesn't light
  // up on every sub-route.
  exact?: boolean;
  // For the default prefix match, treat these sub-trees as NOT belonging to
  // this tab. Use when a sibling tab lives under this tab's href (e.g. Archive
  // at /staff/visits must exclude /staff/visits/new).
  excludePrefixes?: string[];
  // Props are plain data only — this component is a client boundary and
  // server-rendered callers (BillsTabs, VisitsTabs, …) can't pass functions.
}

function isActive(tab: SectionTab, pathname: string): boolean {
  if (tab.exact) return pathname === tab.href || pathname === `${tab.href}/`;
  if (pathname === tab.href) return true;
  if (pathname.startsWith(`${tab.href}/`)) {
    return !(tab.excludePrefixes ?? []).some(
      (ex) => pathname === ex || pathname.startsWith(`${ex}/`),
    );
  }
  return false;
}

// Shared route-based tab bar for staff section pages (Cash drawer, Visits,
// Expenses, Financial statements, …). One look, one place.
//
// `query` is an already-built query string (e.g. "?date=2026-05-30") appended
// to every tab href — used to carry a selection across tabs. The caller owns
// reading search params (so this component never triggers the dynamic-render
// bailout that useSearchParams would).
export function SectionTabs({
  tabs,
  label,
  query = "",
}: {
  tabs: SectionTab[];
  label: string;
  query?: string;
}) {
  const pathname = usePathname();
  return (
    <nav className={sectionTabsNavClass} aria-label={label}>
      {tabs.map((t) => {
        const active = isActive(t, pathname);
        return (
          <Link
            key={t.href}
            href={`${t.href}${query}`}
            className={sectionTabClass(active)}
            aria-current={active ? "page" : undefined}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
