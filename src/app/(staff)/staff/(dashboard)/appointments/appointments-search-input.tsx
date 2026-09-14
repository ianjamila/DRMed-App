"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";

/**
 * Debounced search input for the Appointments page, modeled on
 * `patients/search-input.tsx`. On each keystroke (after 250ms idle), pushes
 * the new ?q= value to the URL — which re-renders the page and re-runs the
 * search — and resets ?page= to page 1 (a fresh term on an old page number
 * would otherwise show a blank screen with no explanation).
 *
 * Clones the FULL current query string and only touches `q`/`page`, so
 * whatever `type`/`sort`/`dir`/`size` the list is already on survives a new
 * search term unchanged.
 */
export function AppointmentsSearchInput({ initialQuery }: { initialQuery: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [value, setValue] = useState(initialQuery);
  const [, startTransition] = useTransition();

  useEffect(() => {
    const handle = setTimeout(() => {
      const next = new URLSearchParams(searchParams.toString());
      const trimmed = value.trim();
      if (trimmed) next.set("q", trimmed);
      else next.delete("q");
      next.delete("page"); // reset pagination on any query change
      const newUrl = `${pathname}${next.size ? `?${next.toString()}` : ""}`;
      startTransition(() => {
        router.replace(newUrl, { scroll: false });
      });
    }, 250);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <input
      type="search"
      name="q"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      placeholder="Search by name, DRM-ID or phone…"
      className="w-full max-w-xl rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
      aria-label="Search appointments"
    />
  );
}
