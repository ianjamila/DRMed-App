import { describe, it, expect } from "vitest";
import { SITE } from "./site";
import {
  medicalClinicLd,
  websiteLd,
  faqPageLd,
  physicianLd,
  physiciansItemListLd,
  packagesItemListLd,
  breadcrumbLd,
  serviceOfferLd,
  productLd,
} from "./structured-data";

describe("medicalClinicLd", () => {
  it("is a MedicalClinic with the clinic @id, address and price range", () => {
    const ld = medicalClinicLd();
    expect(ld["@type"]).toBe("MedicalClinic");
    expect(ld["@id"]).toBe(`${SITE.url}/#clinic`);
    expect((ld.address as Record<string, unknown>)["@type"]).toBe("PostalAddress");
    expect(ld.priceRange).toBeTruthy();
    expect(ld.sameAs).toContain("https://www.facebook.com/drmed.ph");
  });
  it("includes geo + hasMap when coordinates are set (current config)", () => {
    const ld = medicalClinicLd();
    // GEO has candidate coords by default; if a maintainer nulls them, geo is omitted.
    if (ld.geo) {
      expect((ld.geo as Record<string, unknown>)["@type"]).toBe("GeoCoordinates");
      expect(ld.hasMap).toBeTruthy();
    }
  });
  it("is a complete local entity: hours spec, both phones, areas, payments, languages, reserve action, maps sameAs", () => {
    const ld = medicalClinicLd();
    // openingHoursSpecification (structured), in addition to the openingHours string
    const ohs = ld.openingHoursSpecification as Record<string, unknown>;
    expect(ohs["@type"]).toBe("OpeningHoursSpecification");
    expect(ohs.opens).toBe("08:00");
    expect(ohs.closes).toBe("17:00");
    expect(ohs.dayOfWeek).toContain("Saturday");
    expect(ohs.dayOfWeek).not.toContain("Sunday");
    // contactPoint carries BOTH phones
    const cps = ld.contactPoint as Array<Record<string, unknown>>;
    expect(cps).toHaveLength(2);
    const tels = cps.map((c) => c.telephone);
    expect(tels).toContain("+639166043208");
    expect(tels).toContain("+63283553517");
    // areaServed expanded beyond just QC + Metro Manila
    expect((ld.areaServed as unknown[]).length).toBeGreaterThan(2);
    // payments + currency + languages
    expect(ld.paymentAccepted).toContain("HMO");
    expect(ld.currenciesAccepted).toBe("PHP");
    expect(ld.knowsLanguage).toContain("fil");
    // image is an array of place photos
    expect(Array.isArray(ld.image)).toBe(true);
    // sameAs includes the Google Maps place URL + Messenger
    expect(ld.sameAs).toContain("https://maps.app.goo.gl/Qrb5WYwmA5RVuBkN9");
    expect(ld.sameAs).toContain("https://m.me/drmed.ph");
    // ReserveAction -> /schedule
    const action = ld.potentialAction as Record<string, unknown>;
    expect(action["@type"]).toBe("ReserveAction");
    expect((action.target as Record<string, unknown>).urlTemplate).toBe(`${SITE.url}/schedule`);
  });
});

describe("websiteLd", () => {
  it("declares a SearchAction targeting all-services", () => {
    const ld = websiteLd();
    expect(ld["@type"]).toBe("WebSite");
    const action = ld.potentialAction as Record<string, unknown>;
    expect(action["@type"]).toBe("SearchAction");
    expect((action.target as Record<string, unknown>).urlTemplate).toContain(
      "/all-services?q={search_term_string}",
    );
  });
});

describe("faqPageLd", () => {
  it("maps each item to a Question/Answer", () => {
    const ld = faqPageLd([{ question: "Q1?", answer: "A1." }]);
    expect(ld["@type"]).toBe("FAQPage");
    const main = ld.mainEntity as Array<Record<string, unknown>>;
    expect(main).toHaveLength(1);
    expect(main[0]["@type"]).toBe("Question");
    expect((main[0].acceptedAnswer as Record<string, unknown>).text).toBe("A1.");
  });
});

describe("physicianLd", () => {
  it("builds a Physician linked to the clinic with deduped specialties", () => {
    const ld = physicianLd({
      slug: "dr-jane",
      fullName: "Dr. Jane Cruz",
      specialty: "Pediatrics",
      specialtyLabels: ["Pediatrics", "Internal Medicine"],
      photoUrl: "https://x/p.jpg",
    });
    expect(ld["@type"]).toBe("Physician");
    expect(ld["@id"]).toBe(`${SITE.url}/physicians/dr-jane#physician`);
    expect(ld.medicalSpecialty).toEqual(["Pediatrics", "Internal Medicine"]);
    expect((ld.worksFor as Record<string, unknown>)["@id"]).toBe(`${SITE.url}/#clinic`);
  });
  it("carries the clinic's contact (telephone/address/priceRange) and a COMPLETE worksFor clinic node", () => {
    const ld = physicianLd({
      slug: "dr-jane",
      fullName: "Dr. Jane Cruz",
      specialty: "Pediatrics",
      photoUrl: "https://x/p.jpg",
    });
    // Physician node is itself a complete local entity (clears optional warnings).
    expect(ld.telephone).toBeTruthy();
    expect((ld.address as Record<string, unknown>)["@type"]).toBe("PostalAddress");
    expect(ld.priceRange).toBeTruthy();
    // worksFor is the FULL clinic node, not a thin {@id,name} stub.
    const clinic = ld.worksFor as Record<string, unknown>;
    expect(clinic["@type"]).toBe("MedicalClinic");
    expect(clinic.telephone).toBeTruthy();
    expect((clinic.address as Record<string, unknown>)["@type"]).toBe("PostalAddress");
    expect(clinic.image).toBeTruthy();
    expect(clinic.priceRange).toBeTruthy();
    // Embedded node must NOT carry its own @context (only top-level nodes do).
    expect(clinic["@context"]).toBeUndefined();
  });
});

describe("physiciansItemListLd", () => {
  it("numbers items from 1 with absolute urls", () => {
    const ld = physiciansItemListLd([
      { slug: "a", fullName: "A" },
      { slug: "b", fullName: "B" },
    ]);
    expect(ld["@type"]).toBe("ItemList");
    const items = ld.itemListElement as Array<Record<string, unknown>>;
    expect(items[0].position).toBe(1);
    expect(items[1].url).toBe(`${SITE.url}/physicians/b`);
  });
});

describe("packagesItemListLd", () => {
  it("numbers packages from 1 with absolute lowercase-code urls", () => {
    const ld = packagesItemListLd([
      { code: "ROUTINE_PACKAGE", name: "Routine Package" },
      { code: "EXECUTIVE_PACKAGE_STANDARD", name: "Standard Executive" },
    ]);
    expect(ld["@type"]).toBe("ItemList");
    const items = ld.itemListElement as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(items[0].position).toBe(1);
    expect(items[0].name).toBe("Routine Package");
    expect(items[0].url).toBe(`${SITE.url}/all-services/routine_package`);
    expect(items[1].url).toBe(
      `${SITE.url}/all-services/executive_package_standard`,
    );
  });
});

describe("breadcrumbLd", () => {
  it("builds 1-based positions with absolute item urls", () => {
    const ld = breadcrumbLd([
      { name: "Home", path: "/" },
      { name: "Physicians", path: "/physicians" },
    ]);
    const items = ld.itemListElement as Array<Record<string, unknown>>;
    expect(items[0].position).toBe(1);
    expect(items[1].item).toBe(`${SITE.url}/physicians`);
  });
});

describe("serviceOfferLd", () => {
  it("includes a priced PHP Offer ONLY for lab_package, from the passed-in price", () => {
    const pkg = serviceOfferLd({
      code: "ROUTINE",
      name: "Routine Package",
      description: null,
      kind: "lab_package",
      pricePhp: 1299,
    });
    expect(pkg["@type"]).toBe("Service");
    const offer = pkg.offers as Record<string, unknown>;
    expect(offer.price).toBe("1299");
    expect(offer.priceCurrency).toBe("PHP");

    const test = serviceOfferLd({
      code: "FBS",
      name: "Fasting Blood Sugar",
      description: "Blood sugar test.",
      kind: "lab_test",
      pricePhp: 150,
    });
    expect(test.offers).toBeUndefined(); // never leak prices the page hides
    // provider is the COMPLETE clinic node (same @id, no nested @context).
    const provider = test.provider as Record<string, unknown>;
    expect(provider["@id"]).toBe(`${SITE.url}/#clinic`);
    expect(provider.telephone).toBeTruthy();
    expect(provider["@context"]).toBeUndefined();
  });
});

describe("productLd", () => {
  it("builds a Product with an InStock PHP Offer, brand, sku and an absolute image", () => {
    const ld = productLd({
      code: "ROUTINE_PACKAGE",
      name: "Routine Package",
      description: "CBC, Urinalysis.",
      pricePhp: 1299,
    });
    expect(ld["@type"]).toBe("Product");
    expect(ld.name).toBe("Routine Package");
    expect(ld.sku).toBe("ROUTINE_PACKAGE");
    // Merchant needs an identifier; brand + mpn satisfy the "no GTIN" case.
    expect((ld.brand as Record<string, unknown>).name).toBe(SITE.name);
    expect(ld.mpn).toBe("ROUTINE_PACKAGE");
    // Image must be an absolute URL (Merchant rejects relative paths).
    const images = ld.image as string[];
    expect(images[0]).toMatch(/^https?:\/\//);
    const offer = ld.offers as Record<string, unknown>;
    expect(offer["@type"]).toBe("Offer");
    expect(offer.price).toBe("1299");
    expect(offer.priceCurrency).toBe("PHP");
    expect(offer.availability).toBe("https://schema.org/InStock");
    // URL points at the package's own page (lowercased code), like serviceOfferLd.
    expect(offer.url).toBe(`${SITE.url}/all-services/routine_package`);
    expect(ld.url).toBe(`${SITE.url}/all-services/routine_package`);
  });

  it("makes a site-relative image path absolute, and passes an absolute URL through", () => {
    const rel = productLd({
      code: "X",
      name: "X",
      description: null,
      pricePhp: 1,
      imageUrl: "/photos/foo.jpg",
    });
    expect((rel.image as string[])[0]).toBe(`${SITE.url}/photos/foo.jpg`);

    const abs = productLd({
      code: "X",
      name: "X",
      description: null,
      pricePhp: 1,
      imageUrl: "https://cdn.example/x.jpg",
    });
    expect((abs.image as string[])[0]).toBe("https://cdn.example/x.jpg");
  });
});
