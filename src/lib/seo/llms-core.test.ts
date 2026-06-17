import { describe, it, expect } from "vitest";
import { formatPhp } from "@/lib/marketing/format";
import { buildLlmsTxt, buildLlmsFullTxt, type LlmsData } from "./llms-core";

const DATA: LlmsData = {
  site: {
    name: "DRMed Clinic & Laboratory",
    url: "https://drmed.ph",
    summary: "Clinic & lab in Quezon City.",
    address: "123 Test St, Quezon City, Metro Manila 1106, PH",
    phoneMobile: "0916 604 3208",
    phoneLandline: "(02) 8 355 3517",
    email: "drmedhealthcare@gmail.com",
    hours: "Monday – Saturday, 8 AM – 5 PM",
    mapUrl: "https://maps.app.goo.gl/abc",
    geo: { lat: 14.6705639, lng: 121.0389717 },
    social: { facebook: "https://facebook.com/drmed" },
  },
  services: [
    {
      code: "CBC",
      name: "Complete Blood Count",
      description: "Measures   red and white\ncells and platelets.",
      price_php: 350,
      hmo_price_php: 300,
      senior_discount_php: 70,
      turnaround_hours: 24,
      section: "hematology",
      fasting_required: false,
    },
  ],
  packages: [
    {
      code: "ROUTINE_PACKAGE",
      name: "Routine Package",
      price_php: 1299,
      group: "Basic & Routine",
      inclusions: ["CBC", "Urinalysis", "FBS"],
    },
  ],
  physicians: [
    {
      slug: "dr-jane-cruz",
      full_name: "Dr. Jane Cruz",
      specialty: "Internal Medicine",
      group_label: "Consultants",
      bio: "Board-certified internist with 10 years of experience.",
    },
  ],
  faq: [{ question: "Do I need to fast?", answer: "Only for FBS and lipids." }],
};

describe("buildLlmsTxt", () => {
  const out = buildLlmsTxt(DATA);

  it("starts with the H1 and a blockquote summary", () => {
    expect(out.startsWith("# DRMed Clinic & Laboratory\n")).toBe(true);
    expect(out).toContain("> Clinic & lab in Quezon City.");
  });

  it("includes contact, services, packages and physicians sections", () => {
    expect(out).toContain("## Visit & contact");
    expect(out).toContain("## Services");
    expect(out).toContain("## Health packages");
    expect(out).toContain("## Physicians");
  });

  it("renders absolute links and formatted prices", () => {
    expect(out).toContain("[Complete Blood Count](https://drmed.ph/all-services/cbc)");
    expect(out).toContain(formatPhp(350));
    expect(out).toContain("[Routine Package](https://drmed.ph/all-services/routine_package)");
    expect(out).toContain("[Dr. Jane Cruz](https://drmed.ph/physicians/dr-jane-cruz): Internal Medicine");
  });

  it("collapses whitespace in service one-liners (no raw newlines mid-line)", () => {
    expect(out).toContain("Measures red and white cells and platelets.");
  });

  it("leaks no patient-style fields", () => {
    expect(out.toLowerCase()).not.toContain("drm-");
    expect(out.toLowerCase()).not.toContain("pin");
    expect(out.toLowerCase()).not.toContain("patient");
  });
});

describe("buildLlmsFullTxt", () => {
  const out = buildLlmsFullTxt(DATA);

  it("includes the clinic profile with email, hours and geo", () => {
    expect(out).toContain("## Clinic profile");
    expect(out).toContain("drmedhealthcare@gmail.com");
    expect(out).toContain("Monday – Saturday, 8 AM – 5 PM");
    expect(out).toContain("14.6705639, 121.0389717");
  });

  it("renders full service detail with HMO/senior prices and turnaround", () => {
    expect(out).toContain("#### Complete Blood Count");
    expect(out).toContain(`HMO price: ${formatPhp(300)}`);
    expect(out).toContain(`Senior/PWD discount: ${formatPhp(70)}`);
    expect(out).toContain("Turnaround: 24 hours");
    expect(out).toContain("Fasting required: No");
  });

  it("groups packages and lists inclusions", () => {
    expect(out).toContain("### Basic & Routine");
    expect(out).toContain("Includes: CBC, Urinalysis, FBS");
  });

  it("renders physician bios and the FAQ", () => {
    expect(out).toContain("### Consultants");
    expect(out).toContain("Board-certified internist with 10 years of experience.");
    expect(out).toContain("## Frequently asked questions");
    expect(out).toContain("### Do I need to fast?");
  });
});
