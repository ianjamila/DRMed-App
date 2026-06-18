import { SITE, CONTACT, SOCIAL, GEO } from "./site";
import type { FaqItem } from "./faq";

const CLINIC_ID = `${SITE.url}/#clinic`;
type SchemaObject = Record<string, unknown>;

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

// Full MedicalClinic node WITHOUT @context, so it can be embedded as a complete
// entity inside other graphs (a physician's `worksFor`, a service's `provider`)
// AND rendered standalone via medicalClinicLd(). One definition keeps the
// clinic's name/address/phone/price/geo identical everywhere it appears (same
// @id) and avoids the "thin reference" the validator flags on nested pages.
function clinicNode(): SchemaObject {
  const node: SchemaObject = {
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
    node.geo = { "@type": "GeoCoordinates", latitude: GEO.lat, longitude: GEO.lng };
    if (GEO.mapUrl) node.hasMap = GEO.mapUrl;
  }
  return node;
}

export function medicalClinicLd(): SchemaObject {
  return { "@context": "https://schema.org", ...clinicNode() };
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
    // The physician practices at the clinic — carry the clinic's contact point
    // so the Physician node is itself a complete local entity for rich results.
    telephone: CONTACT.phone.mobileE164,
    address: postalAddress(),
    priceRange: SITE.priceRange,
    worksFor: clinicNode(),
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
    provider: clinicNode(),
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

// Resolves a site-relative path ("/photos/x.jpg") to an absolute URL, while
// leaving an already-absolute URL untouched. Google Merchant requires absolute
// image URLs.
function absUrl(pathOrUrl: string): string {
  return /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : `${SITE.url}${pathOrUrl}`;
}

export interface ProductLdInput {
  code: string;
  name: string;
  description: string | null;
  pricePhp: number;
  /** Absolute URL or site-relative path. Defaults to the brand product image. */
  imageUrl?: string;
}

// Google Merchant's "Found by Google" automatic source discovers products by
// crawling schema.org Product markup — it ignores the Service node above. We
// emit a Product ONLY for lab packages (the one kind whose price the site
// publishes), so per-test prices the UI deliberately hides are never leaked to
// Shopping. Price flows live from the `services` table, so the Merchant listing
// can never disagree with the site. brand + mpn cover Merchant's identifier
// requirement for products that have no GTIN.
export function productLd(p: ProductLdInput): SchemaObject {
  const url = `${SITE.url}/all-services/${p.code.toLowerCase()}`;
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: p.name,
    description: p.description ?? `${p.name} at ${SITE.name}.`,
    image: [absUrl(p.imageUrl ?? SITE.productImage)],
    sku: p.code,
    mpn: p.code,
    brand: { "@type": "Brand", name: SITE.name },
    category: "Health & Beauty > Health Care",
    url,
    offers: {
      "@type": "Offer",
      price: String(p.pricePhp),
      priceCurrency: "PHP",
      availability: "https://schema.org/InStock",
      itemCondition: "https://schema.org/NewCondition",
      url,
    },
  };
}
