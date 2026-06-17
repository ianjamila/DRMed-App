// Pure llms.txt / llms-full.txt builders — no `server-only` so vitest can
// import them. All data fetching lives in the server wrapper llms.ts.
import { formatPhp } from "@/lib/marketing/format";

export interface LlmsService {
  code: string;
  name: string;
  description: string | null;
  price_php: number;
  hmo_price_php: number | null;
  senior_discount_php: number | null;
  turnaround_hours: number | null;
  section: string | null;
  fasting_required: boolean;
}

export interface LlmsPackage {
  code: string;
  name: string;
  price_php: number;
  group: string;
  inclusions: string[];
}

export interface LlmsPhysician {
  slug: string;
  full_name: string;
  specialty: string;
  group_label: string | null;
  bio: string | null;
}

export interface LlmsFaq {
  question: string;
  answer: string;
}

export interface LlmsSite {
  name: string;
  url: string; // already trimmed (no trailing slash)
  summary: string;
  address: string;
  phoneMobile: string;
  phoneLandline: string;
  email: string;
  hours: string;
  mapUrl: string;
  geo: { lat: number; lng: number };
  social: { facebook?: string; instagram?: string; messenger?: string };
}

export interface LlmsData {
  site: LlmsSite;
  services: LlmsService[]; // non-package services only
  packages: LlmsPackage[];
  physicians: LlmsPhysician[];
  faq: LlmsFaq[];
}

/** Collapse all runs of whitespace (incl. newlines) into single spaces. */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Single-line, length-capped form for the concise index. */
function oneLine(text: string | null, max = 140): string {
  if (!text) return "";
  const c = collapse(text);
  return c.length > max ? `${c.slice(0, max - 1).trimEnd()}…` : c;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const arr = map.get(k);
    if (arr) arr.push(item);
    else map.set(k, [item]);
  }
  return map;
}

const SECTION_LABELS: Record<string, string> = {
  chemistry: "Clinical Chemistry",
  hematology: "Hematology",
  immunology: "Immunology & Serology",
  urinalysis: "Urinalysis & Fecalysis",
  microbiology: "Microbiology",
  imaging_xray: "X-ray",
  imaging_ultrasound: "Ultrasound",
  imaging_ecg: "ECG",
  vaccine: "Vaccines",
  send_out: "Send-out tests",
  consultation: "Consultations",
  procedure: "Procedures",
  home_service: "Home service",
  package: "Packages",
  other: "Other services",
};

function humanizeSection(section: string): string {
  return (
    SECTION_LABELS[section] ??
    section.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

export function buildLlmsTxt(data: LlmsData): string {
  const { site } = data;
  const lines: string[] = [];

  lines.push(`# ${site.name}`, "");
  lines.push(`> ${site.summary}`, "");

  lines.push("## Visit & contact");
  lines.push(`- Address: ${site.address}`);
  lines.push(`- Phone: ${site.phoneMobile} / ${site.phoneLandline}`);
  lines.push(`- Hours: ${site.hours}`);
  lines.push(`- Book an appointment: ${site.url}/schedule`);
  lines.push(`- Map: ${site.mapUrl}`, "");

  lines.push("## Main pages");
  lines.push(`- [Services](${site.url}/all-services): full diagnostic & consultation menu`);
  lines.push(`- [Health packages](${site.url}/packages): bundled lab panels`);
  lines.push(`- [Physicians](${site.url}/physicians): doctors & specialties`);
  lines.push(`- [About](${site.url}/about)`);
  lines.push(`- [Contact](${site.url}/contact)`, "");

  if (data.services.length) {
    lines.push("## Services");
    for (const s of data.services) {
      const desc = oneLine(s.description) || s.name;
      lines.push(
        `- [${s.name}](${site.url}/all-services/${s.code.toLowerCase()}): ${desc} — ${formatPhp(s.price_php)}`,
      );
    }
    lines.push("");
  }

  if (data.packages.length) {
    lines.push("## Health packages");
    for (const p of data.packages) {
      const summary = p.inclusions.length ? p.inclusions.join(", ") : "bundled lab panel";
      lines.push(
        `- [${p.name}](${site.url}/all-services/${p.code.toLowerCase()}): ${summary} — ${formatPhp(p.price_php)}`,
      );
    }
    lines.push("");
  }

  if (data.physicians.length) {
    lines.push("## Physicians");
    for (const d of data.physicians) {
      lines.push(`- [${d.full_name}](${site.url}/physicians/${d.slug}): ${d.specialty}`);
    }
    lines.push("");
  }

  lines.push("## Optional");
  lines.push(`- [Privacy policy](${site.url}/privacy)`);
  lines.push(`- [Terms](${site.url}/terms)`, "");

  return lines.join("\n");
}

export function buildLlmsFullTxt(data: LlmsData): string {
  const { site } = data;
  const lines: string[] = [];

  lines.push(`# ${site.name} — Full reference`, "");
  lines.push(`> ${site.summary}`, "");

  lines.push("## Clinic profile");
  lines.push(`- Name: ${site.name}`);
  lines.push(`- Website: ${site.url}`);
  lines.push(`- Address: ${site.address}`);
  lines.push(`- Phone (mobile): ${site.phoneMobile}`);
  lines.push(`- Phone (landline): ${site.phoneLandline}`);
  lines.push(`- Email: ${site.email}`);
  lines.push(`- Hours: ${site.hours}`);
  lines.push(`- Location: ${site.geo.lat}, ${site.geo.lng} (${site.mapUrl})`);
  lines.push(`- Book an appointment: ${site.url}/schedule`);
  const socials = [
    site.social.facebook && `Facebook: ${site.social.facebook}`,
    site.social.instagram && `Instagram: ${site.social.instagram}`,
    site.social.messenger && `Messenger: ${site.social.messenger}`,
  ].filter(Boolean);
  if (socials.length) lines.push(`- Social: ${socials.join(" · ")}`);
  lines.push("");

  if (data.services.length) {
    lines.push("## Services", "");
    for (const [section, items] of groupBy(data.services, (s) => s.section ?? "other")) {
      lines.push(`### ${humanizeSection(section)}`);
      for (const s of items) {
        lines.push("", `#### ${s.name}`);
        lines.push(`- URL: ${site.url}/all-services/${s.code.toLowerCase()}`);
        lines.push(`- Price: ${formatPhp(s.price_php)}`);
        if (s.hmo_price_php != null) lines.push(`- HMO price: ${formatPhp(s.hmo_price_php)}`);
        if (s.senior_discount_php != null)
          lines.push(`- Senior/PWD discount: ${formatPhp(s.senior_discount_php)}`);
        if (s.turnaround_hours != null) lines.push(`- Turnaround: ${s.turnaround_hours} hours`);
        lines.push(`- Fasting required: ${s.fasting_required ? "Yes" : "No"}`);
        if (s.description) lines.push("", collapse(s.description));
      }
      lines.push("");
    }
  }

  if (data.packages.length) {
    lines.push("## Health packages", "");
    for (const [group, items] of groupBy(data.packages, (p) => p.group)) {
      lines.push(`### ${group}`);
      for (const p of items) {
        lines.push("", `#### ${p.name} — ${formatPhp(p.price_php)}`);
        lines.push(`- URL: ${site.url}/all-services/${p.code.toLowerCase()}`);
        if (p.inclusions.length) lines.push(`- Includes: ${p.inclusions.join(", ")}`);
      }
      lines.push("");
    }
  }

  if (data.physicians.length) {
    lines.push("## Physicians", "");
    for (const [group, items] of groupBy(data.physicians, (d) => d.group_label ?? "Physicians")) {
      lines.push(`### ${group}`);
      for (const d of items) {
        lines.push("", `#### ${d.full_name} — ${d.specialty}`);
        lines.push(`- URL: ${site.url}/physicians/${d.slug}`);
        if (d.bio) lines.push("", collapse(d.bio));
      }
      lines.push("");
    }
  }

  if (data.faq.length) {
    lines.push("## Frequently asked questions");
    for (const f of data.faq) {
      lines.push("", `### ${f.question}`, collapse(f.answer));
    }
    lines.push("");
  }

  return lines.join("\n");
}
