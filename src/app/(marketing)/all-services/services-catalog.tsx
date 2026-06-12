"use client";

import { useDeferredValue, useMemo, useState } from "react";
import Link from "next/link";
import { Search, ArrowRight, Tag } from "lucide-react";
import { formatPhp } from "@/lib/marketing/format";
import type { PublicService, ServiceSection } from "@/lib/marketing/services";

type TabKey =
  | "all"
  | "packages"
  | "tests"
  | "imaging"
  | "vaccines"
  | "send_out"
  | "consultations";

const TABS: { key: TabKey; label: string; sections: ServiceSection[] | null }[] = [
  { key: "all", label: "All", sections: null },
  { key: "packages", label: "Packages", sections: ["package"] },
  {
    key: "tests",
    label: "Tests",
    sections: [
      "chemistry",
      "hematology",
      "immunology",
      "urinalysis",
      "microbiology",
    ],
  },
  {
    key: "imaging",
    label: "Imaging",
    sections: ["imaging_xray", "imaging_ultrasound", "imaging_ecg"],
  },
  { key: "vaccines", label: "Vaccines", sections: ["vaccine"] },
  { key: "send_out", label: "Specialty", sections: ["send_out"] },
  {
    key: "consultations",
    label: "Consultations",
    sections: ["consultation", "procedure"],
  },
];

const SECTION_LABEL: Record<ServiceSection, string> = {
  package: "Package",
  chemistry: "Chemistry",
  hematology: "Hematology",
  immunology: "Immunology",
  urinalysis: "Urinalysis",
  microbiology: "Microbiology",
  imaging_xray: "X-Ray",
  imaging_ultrasound: "Ultrasound",
  imaging_ecg: "ECG",
  vaccine: "Vaccine",
  send_out: "Specialty",
  consultation: "Consultation",
  procedure: "Procedure",
  home_service: "Home service",
};

interface Props {
  services: PublicService[];
}

export function ServicesCatalog({ services }: Props) {
  const [tab, setTab] = useState<TabKey>("all");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);

  const filtered = useMemo(() => {
    const tabConfig = TABS.find((t) => t.key === tab)!;
    const sectionsAllow = tabConfig.sections;
    const q = deferredQuery.trim().toLowerCase();

    return services.filter((s) => {
      if (tab === "send_out") {
        if (!s.is_send_out) return false;
      } else if (sectionsAllow) {
        if (!s.section || !sectionsAllow.includes(s.section)) return false;
      }
      if (q) {
        const hay = `${s.name} ${s.code}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [services, tab, deferredQuery]);

  const tabCounts = useMemo(() => {
    const counts: Record<TabKey, number> = {
      all: services.length,
      packages: 0,
      tests: 0,
      imaging: 0,
      vaccines: 0,
      send_out: 0,
      consultations: 0,
    };
    for (const s of services) {
      if (s.is_send_out) counts.send_out++;
      if (!s.section) continue;
      for (const t of TABS) {
        if (t.key === "all" || t.key === "send_out") continue;
        if (t.sections?.includes(s.section)) counts[t.key]++;
      }
    }
    return counts;
  }, [services]);

  return (
    <div className="space-y-8">
      {/* Sticky search + filter bar */}
      <div className="sticky top-0 z-10 -mx-4 border-b border-[color:var(--color-warm-line-soft)] bg-[color:var(--color-warm-bg)]/95 px-4 py-4 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        {/* Search input */}
        <div className="relative">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--color-ink-soft)]"
          />
          <label htmlFor="services-search" className="sr-only">
            Search services
          </label>
          <input
            id="services-search"
            type="search"
            placeholder="Search by name or code (e.g. CBC, ultrasound, lipid)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-[46px] w-full rounded-[12px] border-[1.5px] border-[color:var(--color-warm-line)] bg-white pl-10 pr-[13px] text-[15px] text-[color:var(--color-ink)] outline-none placeholder:text-[color:var(--color-ink-soft)] focus:border-[color:var(--color-brand-cyan)]"
          />
        </div>

        {/* Category filter pills */}
        <div
          role="tablist"
          aria-label="Service sections"
          className="mt-3 flex flex-wrap gap-2"
        >
          {TABS.map((t) => {
            const active = tab === t.key;
            const count = tabCounts[t.key];
            return (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(t.key)}
                className={[
                  "rounded-full border-[1.5px] px-4 py-2 text-sm font-semibold transition-colors duration-150",
                  active
                    ? "border-[color:var(--color-brand-cyan)] bg-[rgba(8,168,226,0.10)] text-[color:var(--color-brand-navy)]"
                    : "border-[color:var(--color-warm-line)] bg-white text-[color:var(--color-ink-mid)] hover:border-[color:var(--color-brand-cyan)]",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                {t.label}
                <span
                  className={[
                    "ml-1.5 text-xs",
                    active
                      ? "text-[color:var(--color-brand-navy)]/60"
                      : "text-[color:var(--color-ink-soft)]",
                  ].join(" ")}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Results */}
      {filtered.length === 0 ? (
        <p className="rounded-[20px] border border-dashed border-[color:var(--color-warm-line)] bg-white p-8 text-center text-sm text-[color:var(--color-ink-soft)]">
          No services match your filters.
        </p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((service) => (
            <li key={service.id}>
              <Link
                href={`/all-services/${service.code.toLowerCase()}`}
                className="group flex h-full flex-col rounded-[20px] border border-[color:var(--color-warm-line-soft)] bg-white p-6 shadow-[var(--shadow-warm-sm)] transition-[transform,box-shadow] duration-200 hover:-translate-y-1 hover:shadow-[var(--shadow-warm-lg)]"
              >
                {/* Code + section badge */}
                <div className="flex items-start justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-[rgba(8,168,226,0.10)] px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan-text)]">
                    <Tag aria-hidden className="h-3 w-3 shrink-0" />
                    {service.code}
                  </span>
                  {service.section ? (
                    <span className="rounded-md bg-[color:var(--color-warm-sand)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-ink-soft)]">
                      {SECTION_LABEL[service.section]}
                    </span>
                  ) : null}
                </div>

                {/* Name */}
                <h2 className="mt-3 font-[family-name:var(--font-display)] text-[17px] font-normal leading-snug text-[color:var(--color-brand-navy)] group-hover:text-[color:var(--color-brand-cyan-text)]">
                  {service.name}
                </h2>

                {/* Badges */}
                {(service.fasting_required || service.requires_time_slot) ? (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {service.fasting_required && (
                      <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-[11px] font-semibold text-amber-900">
                        Fasting required
                      </span>
                    )}
                    {service.requires_time_slot && (
                      <span className="rounded-full bg-sky-100 px-2.5 py-0.5 text-[11px] font-semibold text-sky-900">
                        By appointment
                      </span>
                    )}
                  </div>
                ) : null}

                {/* Footer */}
                <div className="mt-4 flex items-center justify-between border-t border-[color:var(--color-warm-line-soft)] pt-3 text-sm">
                  {service.kind === "lab_package" ? (
                    <span className="font-[family-name:var(--font-display)] text-lg italic text-[color:var(--color-brand-cyan-text)]">
                      {formatPhp(service.price_php)}
                    </span>
                  ) : (
                    <span className="text-xs italic text-[color:var(--color-ink-soft)]">
                      Pricing at reception
                    </span>
                  )}
                  <span className="inline-flex items-center gap-1 text-[color:var(--color-brand-cyan-text)] opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                    <span className="text-xs font-semibold">Details</span>
                    <ArrowRight aria-hidden className="h-3.5 w-3.5" />
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
