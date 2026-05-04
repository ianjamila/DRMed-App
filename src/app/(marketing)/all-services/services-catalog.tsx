"use client";

import { useDeferredValue, useMemo, useState } from "react";
import Link from "next/link";
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
    sections: ["imaging_xray", "imaging_ultrasound"],
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
    <div className="space-y-6">
      <div className="sticky top-0 z-10 -mx-4 bg-[color:var(--color-brand-bg)]/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <label htmlFor="services-search" className="sr-only">
          Search services
        </label>
        <input
          id="services-search"
          type="search"
          placeholder="Search by name or code (e.g. CBC, ultrasound, lipid)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full rounded-lg border border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-3 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-cyan)]/20"
        />

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
                className={
                  active
                    ? "rounded-full bg-[color:var(--color-brand-navy)] px-4 py-1.5 text-xs font-bold text-white"
                    : "rounded-full border border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-1.5 text-xs font-bold text-[color:var(--color-brand-navy)] hover:border-[color:var(--color-brand-cyan)] hover:text-[color:var(--color-brand-cyan)]"
                }
              >
                {t.label}
                <span
                  className={
                    active
                      ? "ml-2 text-white/70"
                      : "ml-2 text-[color:var(--color-brand-text-soft)]"
                  }
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[color:var(--color-brand-bg-mid)] bg-white p-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
          No services match your filters.
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((service) => (
            <li key={service.id}>
              <Link
                href={`/all-services/${service.code.toLowerCase()}`}
                className="group flex h-full flex-col rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5 transition-shadow hover:border-[color:var(--color-brand-cyan)] hover:shadow-md"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="font-mono text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
                    {service.code}
                  </p>
                  {service.section ? (
                    <span className="rounded-md bg-[color:var(--color-brand-bg)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                      {SECTION_LABEL[service.section]}
                    </span>
                  ) : null}
                </div>
                <h2 className="mt-1 font-[family-name:var(--font-heading)] text-base font-bold text-[color:var(--color-brand-navy)] group-hover:text-[color:var(--color-brand-cyan)]">
                  {service.name}
                </h2>
                <div className="mt-4 flex items-center justify-between border-t border-[color:var(--color-brand-bg-mid)] pt-3 text-sm">
                  {service.kind === "lab_package" ? (
                    <span className="font-bold text-[color:var(--color-brand-navy)]">
                      {formatPhp(service.price_php)}
                    </span>
                  ) : (
                    <span className="text-xs italic text-[color:var(--color-brand-text-soft)]">
                      Pricing at reception
                    </span>
                  )}
                  {service.turnaround_hours ? (
                    <span className="text-[color:var(--color-brand-text-soft)]">
                      {service.turnaround_hours}h
                    </span>
                  ) : null}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
