"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export function VisitsSearchInput({ initialQuery }: { initialQuery: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [value, setValue] = useState(initialQuery);
  const [previousQuery, setPreviousQuery] = useState(initialQuery);
  const [submittedQueries, setSubmittedQueries] = useState<string[]>([]);
  const edited = useRef(false);
  const [, startTransition] = useTransition();

  // Follow Clear filters and browser history without remounting the input
  // (remounting after each debounced navigation would lose keyboard focus).
  if (initialQuery !== previousQuery) {
    setPreviousQuery(initialQuery);
    const acknowledged = submittedQueries.indexOf(initialQuery);
    if (acknowledged === -1) {
      setValue(initialQuery);
      setSubmittedQueries([]);
    } else {
      // A slow response to our earlier search must not erase newer typing.
      setSubmittedQueries(submittedQueries.slice(acknowledged + 1));
    }
  }

  useEffect(() => {
    // Mounting a bookmarked page must not reset its pagination.
    if (!edited.current || value.trim() === (searchParams.get("q") ?? "")) return;
    const handle = setTimeout(() => {
      const next = new URLSearchParams(searchParams.toString());
      if (value.trim()) next.set("q", value.trim());
      else next.delete("q");
      next.delete("page");
      setSubmittedQueries((queries) => [...queries, value.trim()]);
      startTransition(() => {
        router.replace(`${pathname}${next.size ? `?${next}` : ""}`, { scroll: false });
      });
    }, 250);
    return () => clearTimeout(handle);
  }, [value, searchParams, pathname, router]);

  return (
    <input
      type="search"
      name="q"
      value={value}
      onChange={(event) => { edited.current = true; setValue(event.target.value); }}
      placeholder="Patient name · DRM-ID · visit number"
      className="w-full max-w-xl rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
      aria-label="Search visits"
    />
  );
}
