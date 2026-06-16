import { SITE, CONTACT, SOCIAL, GEO } from "./site";
import type { FaqItem } from "./faq";

const CLINIC_ID = `${SITE.url}/#clinic`;
type SchemaObject = Record<string, unknown>;

function clinicRef(): SchemaObject {
  return { "@type": "MedicalClinic", "@id": CLINIC_ID, name: SITE.name };
}

function postalAddress(): SchemaObject {
  return {
    "@type": "PostalAddress",
    streetAddress: `${CONTACT.address.line1}, ${CONTACT.address.line2}`,
    addressLocality: CONTACT.address.city,
    addressRegion: CONTACT.address.region,
    postalCode: CONTACT.address.postalCode,
    addressCountry: CONTACT.address.country,
  };
}

export function medicalClinicLd(): SchemaObject {
  const ld: SchemaObject = {
    "@context": "https://schema.org",
    "@type": "MedicalClinic",
    "@id": CLINIC_ID,
    name: SITE.name,
    url: SITE.url,
    logo: `${SITE.url}${SITE.logo}`,
    image: `${SITE.url}${SITE.ogImage}`,
    description: SITE.description,
    email: CONTACT.email,
    telephone: CONTACT.phone.mobileE164,
    priceRange: SITE.priceRange,
    address: postalAddress(),
    areaServed: [
      { "@type": "City", name: "Quezon City" },
      { "@type": "AdministrativeArea", name: "Metro Manila" },
    ],
    openingHours: "Mo-Sa 08:00-17:00",
    medicalSpecialty: ["Diagnostic", "ClinicalLaboratory", "Radiology"],
    sameAs: [SOCIAL.facebook, SOCIAL.instagram],
  };
  if (GEO.lat != null && GEO.lng != null) {
    ld.geo = { "@type": "GeoCoordinates", latitude: GEO.lat, longitude: GEO.lng };
    if (GEO.mapUrl) ld.hasMap = GEO.mapUrl;
  }
  return ld;
}

export function websiteLd(): SchemaObject {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": `${SITE.url}/#website`,
    url: SITE.url,
    name: SITE.name,
    potentialAction: {
      "@type": "SearchAction",
      target: {
        "@type": "EntryPoint",
        urlTemplate: `${SITE.url}/all-services?q={search_term_string}`,
      },
      "query-input": "required name=search_term_string",
    },
  };
}

export function faqPageLd(items: readonly FaqItem[]): SchemaObject {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((it) => ({
      "@type": "Question",
      name: it.question,
      acceptedAnswer: { "@type": "Answer", text: it.answer },
    })),
  };
}

export interface PhysicianLdInput {
  slug: string;
  fullName: string;
  specialty: string;
  specialtyLabels?: string[];
  photoUrl: string;
}

export function physicianLd(p: PhysicianLdInput): SchemaObject {
  const specialties = [p.specialty, ...(p.specialtyLabels ?? [])].filter(
    (v, i, a) => Boolean(v) && a.indexOf(v) === i,
  );
  return {
    "@context": "https://schema.org",
    "@type": "Physician",
    "@id": `${SITE.url}/physicians/${p.slug}#physician`,
    name: p.fullName,
    url: `${SITE.url}/physicians/${p.slug}`,
    image: p.photoUrl,
    medicalSpecialty: specialties,
    worksFor: clinicRef(),
  };
}

export interface PhysicianListItem {
  slug: string;
  fullName: string;
}

export function physiciansItemListLd(docs: readonly PhysicianListItem[]): SchemaObject {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: docs.map((d, i) => ({
      "@type": "ListItem",
      position: i + 1,
      url: `${SITE.url}/physicians/${d.slug}`,
      name: d.fullName,
    })),
  };
}

export interface BreadcrumbCrumb {
  name: string;
  path: string;
}

export function breadcrumbLd(trail: readonly BreadcrumbCrumb[]): SchemaObject {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: trail.map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.name,
      item: `${SITE.url}${c.path}`,
    })),
  };
}

export interface ServiceLdInput {
  code: string;
  name: string;
  description: string | null;
  kind: string;
  pricePhp: number;
}

export function serviceOfferLd(s: ServiceLdInput): SchemaObject {
  const url = `${SITE.url}/all-services/${s.code.toLowerCase()}`;
  const ld: SchemaObject = {
    "@context": "https://schema.org",
    "@type": "Service",
    name: s.name,
    description: s.description ?? `${s.name} at ${SITE.name}.`,
    url,
    provider: clinicRef(),
  };
  if (s.kind === "lab_package") {
    ld.offers = {
      "@type": "Offer",
      price: String(s.pricePhp),
      priceCurrency: "PHP",
      availability: "https://schema.org/InStock",
      url,
    };
  }
  return ld;
}
