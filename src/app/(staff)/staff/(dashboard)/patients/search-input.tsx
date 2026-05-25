"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";

/**
 * Debounced search input. On each keystroke (after 250ms idle), pushes the
 * new ?q= value to the URL, which re-renders the server component and
 * re-runs the patients query. Empty value drops the parameter entirely.
 *
 * Resets pagination (?page=) on every change — typing a new term should
 * always show page 1.
 */
export function PatientsSearchInput({ initialQuery }: { initialQuery: string }) {
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
      placeholder="DRM-0001 · Juan dela Cruz · 0916… · email"
      className="w-full max-w-xl rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
      aria-label="Search patients"
    />
  );
}
