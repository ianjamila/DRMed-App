"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import {
  APPOINTMENT_SOURCES,
  APPOINTMENT_SOURCE_LABEL,
  SOURCE_NOT_RECORDED_LABEL,
} from "@/lib/appointments/source";

/**
 * `?source=` filter for the Appointments list. Modeled on
 * `AppointmentsSearchInput` — clones the FULL current query string and only
 * touches `source`/`page`, so whatever `q`/`type`/`sort`/`dir`/`size` the
 * list is already on survives unchanged. Selecting a value pushes the page
 * into the flat/sorted view (page.tsx's `isFlatView`), the same way typing
 * into the search box does.
 */
export function SourceFilterSelect({ initialValue }: { initialValue: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = new URLSearchParams(searchParams.toString());
    const v = e.target.value;
    if (v) next.set("source", v);
    else next.delete("source");
    next.delete("page"); // reset pagination on any filter change
    const newUrl = `${pathname}${next.size ? `?${next.toString()}` : ""}`;
    router.replace(newUrl, { scroll: false });
  }

  return (
    <select
      name="source"
      defaultValue={initialValue}
      onChange={onChange}
      aria-label="Filter by how they reached us"
      className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
    >
      <option value="">All sources</option>
      <option value="not_recorded">{SOURCE_NOT_RECORDED_LABEL}</option>
      {APPOINTMENT_SOURCES.map((s) => (
        <option key={s} value={s}>
          {APPOINTMENT_SOURCE_LABEL[s]}
        </option>
      ))}
    </select>
  );
}
