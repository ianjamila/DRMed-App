import { describe, it, expect } from "vitest";
import { buildMerchantFeed, type MerchantFeedItem } from "./merchant-feed";

const OPTS = {
  siteUrl: "https://drmed.ph",
  brand: "DRMed Clinic & Laboratory",
  defaultImage: "/photos/lab-chemistry.jpg",
  title: "DRMed packages",
  description: "Lab packages",
};

const ROUTINE: MerchantFeedItem = {
  code: "ROUTINE_PACKAGE",
  name: "Routine Package",
  description: "CBC, Urinalysis & more.",
  pricePhp: 1299,
  imageUrl: null,
};

describe("buildMerchantFeed", () => {
  it("emits a Google RSS feed with the g: namespace and a channel", () => {
    const xml = buildMerchantFeed([ROUTINE], OPTS);
    expect(xml).toContain('xmlns:g="http://base.google.com/ns/1.0"');
    expect(xml).toContain("<channel>");
    expect(xml).toContain("<title>DRMed packages</title>");
  });

  it("renders each package with id, absolute link/image, PHP price and identifiers", () => {
    const xml = buildMerchantFeed([ROUTINE], OPTS);
    expect(xml).toContain("<g:id>ROUTINE_PACKAGE</g:id>");
    expect(xml).toContain("<title>Routine Package</title>");
    expect(xml).toContain(
      "<link>https://drmed.ph/all-services/routine_package</link>",
    );
    // No per-item image → default, made absolute.
    expect(xml).toContain(
      "<g:image_link>https://drmed.ph/photos/lab-chemistry.jpg</g:image_link>",
    );
    expect(xml).toContain("<g:price>1299.00 PHP</g:price>");
    expect(xml).toContain("<g:availability>in_stock</g:availability>");
    expect(xml).toContain("<g:brand>DRMed Clinic &amp; Laboratory</g:brand>");
    expect(xml).toContain("<g:mpn>ROUTINE_PACKAGE</g:mpn>");
    expect(xml).toContain("<g:identifier_exists>no</g:identifier_exists>");
  });

  it("uses a per-item image when set and makes a relative path absolute", () => {
    const xml = buildMerchantFeed(
      [{ ...ROUTINE, imageUrl: "/photos/exec.jpg" }],
      OPTS,
    );
    expect(xml).toContain(
      "<g:image_link>https://drmed.ph/photos/exec.jpg</g:image_link>",
    );
  });

  it("passes an already-absolute image URL through unchanged", () => {
    const xml = buildMerchantFeed(
      [{ ...ROUTINE, imageUrl: "https://cdn.example/x.jpg" }],
      OPTS,
    );
    expect(xml).toContain("<g:image_link>https://cdn.example/x.jpg</g:image_link>");
  });

  it("escapes XML-special characters in names/descriptions", () => {
    const xml = buildMerchantFeed(
      [{ ...ROUTINE, name: "A & B <Panel>", description: 'C "quote" D' }],
      OPTS,
    );
    expect(xml).toContain("<title>A &amp; B &lt;Panel&gt;</title>");
    expect(xml).toContain("C &quot;quote&quot; D");
    expect(xml).not.toContain("<Panel>");
  });

  it("falls back to a generated description when none is set", () => {
    const xml = buildMerchantFeed([{ ...ROUTINE, description: null }], OPTS);
    expect(xml).toContain(
      "<description>Routine Package at DRMed Clinic &amp; Laboratory.</description>",
    );
  });
});
