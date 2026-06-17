import "server-only";
import { SITE, CONTACT, GEO, SOCIAL } from "@/lib/marketing/site";
import { listActiveServices, listActivePackages } from "@/lib/marketing/services";
import { listActivePhysiciansDetailed } from "@/lib/marketing/physicians";
import { FAQ_ITEMS } from "@/lib/marketing/faq";
import { buildLlmsTxt, buildLlmsFullTxt, type LlmsData } from "./llms-core";

const SUMMARY =
  "Medical clinic & diagnostic laboratory in Quezon City, Metro Manila. Doctor consultations, lab tests, imaging, vaccines, and health packages. Patients book online and view released lab results in a secure portal.";

async function loadLlmsData(): Promise<LlmsData> {
  const base = SITE.url.replace(/\/$/, "");
  const [allServices, packages, physicians] = await Promise.all([
    listActiveServices(),
    listActivePackages(),
    listActivePhysiciansDetailed(),
  ]);

  return {
    site: {
      name: SITE.name,
      url: base,
      summary: SUMMARY,
      address: CONTACT.address.full,
      phoneMobile: CONTACT.phone.mobile,
      phoneLandline: CONTACT.phone.landline,
      email: CONTACT.email,
      hours: CONTACT.hours,
      mapUrl: GEO.mapUrl,
      geo: { lat: GEO.lat ?? 0, lng: GEO.lng ?? 0 },
      social: {
        facebook: SOCIAL.facebook,
        instagram: SOCIAL.instagram,
        messenger: SOCIAL.messenger,
      },
    },
    // Packages are listed in their own section; exclude them from the flat service list.
    services: allServices
      .filter((s) => s.kind !== "lab_package")
      .map((s) => ({
        code: s.code,
        name: s.name,
        description: s.description,
        price_php: s.price_php,
        hmo_price_php: s.hmo_price_php,
        senior_discount_php: s.senior_discount_php,
        turnaround_hours: s.turnaround_hours,
        section: s.section,
        fasting_required: s.fasting_required,
      })),
    packages: packages.map((p) => ({
      code: p.code,
      name: p.name,
      price_php: p.price_php,
      group: p.group,
      inclusions: p.inclusions,
    })),
    physicians: physicians.map((d) => ({
      slug: d.slug,
      full_name: d.full_name,
      specialty: d.specialty,
      group_label: d.group_label,
      bio: d.bio,
    })),
    faq: FAQ_ITEMS.map((f) => ({ question: f.question, answer: f.answer })),
  };
}

export async function renderLlmsTxt(): Promise<string> {
  return buildLlmsTxt(await loadLlmsData());
}

export async function renderLlmsFullTxt(): Promise<string> {
  return buildLlmsFullTxt(await loadLlmsData());
}
