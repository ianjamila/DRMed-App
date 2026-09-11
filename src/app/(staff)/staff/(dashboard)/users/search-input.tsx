"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";

/**
 * Debounced staff search. Same shape as the patients search input: on each
 * keystroke (after 250ms idle) it pushes the new ?q= to the URL, which
 * re-renders the server component and re-filters the list. An empty value
 * drops the parameter entirely.
 *
 * Deliberately keeps every OTHER parameter, so typing while a role or
 * sign-in chip is active narrows within that filter instead of clearing it.
 */
export function StaffSearchInput({ initialQuery }: { initialQuery: string }) {
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
      placeholder="Name · email · role"
      className="w-full max-w-xl rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
      aria-label="Search staff users"
    />
  );
}
