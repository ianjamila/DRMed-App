import { describe, it, expect } from "vitest";
import { SITE } from "./site";
import {
  medicalClinicLd,
  websiteLd,
  faqPageLd,
  physicianLd,
  physiciansItemListLd,
  breadcrumbLd,
  serviceOfferLd,
} from "./structured-data";

describe("medicalClinicLd", () => {
  it("is a MedicalClinic with the clinic @id, address and price range", () => {
    const ld = medicalClinicLd();
    expect(ld["@type"]).toBe("MedicalClinic");
    expect(ld["@id"]).toBe(`${SITE.url}/#clinic`);
    expect((ld.address as Record<string, unknown>)["@type"]).toBe("PostalAddress");
    expect(ld.priceRange).toBeTruthy();
    expect(ld.sameAs).toContain("https://www.facebook.com/drmedcliniclab/");
  });
  it("includes geo + hasMap when coordinates are set (current config)", () => {
    const ld = medicalClinicLd();
    // GEO has candidate coords by default; if a maintainer nulls them, geo is omitted.
    if (ld.geo) {
      expect((ld.geo as Record<string, unknown>)["@type"]).toBe("GeoCoordinates");
      expect(ld.hasMap).toBeTruthy();
    }
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
