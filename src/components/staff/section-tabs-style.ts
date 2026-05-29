// Shared styling for staff section tab-bars. Kept in a non-"use client"
// module so server components that render param-driven tabs (e.g. the
// patient-receivables scope filter) can apply the exact same classes
// without pulling in the client SectionTabs component.

import { cn } from "@/lib/utils";

// The <nav> wrapper: underline bar, slight negative inset so the first
// pill's text lines up with page content, breathing room below.
export const sectionTabsNavClass =
  "-mx-1 mb-4 flex flex-wrap gap-1 border-b border-[color:var(--color-brand-bg-mid)] pb-3";

// One tab. Active = filled navy pill; inactive = muted text that tints navy
// on hover. ≥44px tall for touch targets.
export function sectionTabClass(active: boolean): string {
  return cn(
    "min-h-11 rounded-md px-3 py-2 text-sm font-semibold transition-colors",
    active
      ? "bg-[color:var(--color-brand-navy)] text-white"
      : "text-[color:var(--color-brand-text-mid)] hover:bg-[color:var(--color-brand-bg)] hover:text-[color:var(--color-brand-navy)]",
  );
}
