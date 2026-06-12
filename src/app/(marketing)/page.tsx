import { CONTACT, SITE, SOCIAL } from "@/lib/marketing/site";
import { createClient } from "@/lib/supabase/server";
import { physicianPhotoUrl } from "@/lib/physicians/photo";
import { EcgDivider } from "@/components/marketing/motion";
import { Hero } from "@/components/marketing/home/Hero";
import { TrustStrip } from "@/components/marketing/home/TrustStrip";
import { HowItWorks } from "@/components/marketing/home/HowItWorks";
import { Services } from "@/components/marketing/home/Services";
import { Packages } from "@/components/marketing/home/Packages";
import { Specialists } from "@/components/marketing/home/Specialists";
import { Testimonials } from "@/components/marketing/home/Testimonials";
import { PortalPromo } from "@/components/marketing/home/PortalPromo";
import { HmoSection } from "@/components/marketing/home/HmoSection";
import { Payments } from "@/components/marketing/home/Payments";
import { Gallery } from "@/components/marketing/home/Gallery";
import { Faq } from "@/components/marketing/home/Faq";
import { Contact } from "@/components/marketing/home/Contact";

// MedicalBusiness structured data — preserved from the original homepage.
const jsonLd = {
  "@context": "https://schema.org",
  "@type": "MedicalBusiness",
  name: SITE.name,
  url: SITE.url,
  email: CONTACT.email,
  telephone: CONTACT.phone.mobileE164,
  address: {
    "@type": "PostalAddress",
    streetAddress: `${CONTACT.address.line1}, ${CONTACT.address.line2}`,
    addressLocality: CONTACT.address.city,
    addressRegion: CONTACT.address.region,
    addressCountry: CONTACT.address.country,
  },
  openingHours: "Mo-Sa 08:00-17:00",
  medicalSpecialty: ["Diagnostic", "ClinicalLaboratory", "Radiology"],
  sameAs: [SOCIAL.facebook, SOCIAL.instagram],
};

export default async function HomePage() {
  const supabase = await createClient();

  // Total active physicians (for the specialists copy) + the first 6 by display
  // order for the homepage specialists grid (C13 — DB-driven, not hardcoded).
  const [{ count: physicianCount }, { data: topPhysicians }] = await Promise.all([
    supabase
      .from("physicians")
      .select("id", { count: "exact", head: true })
      .eq("is_active", true),
    supabase
      .from("physicians")
      .select("id, slug, full_name, specialty, photo_path")
      .eq("is_active", true)
      .order("display_order", { ascending: true })
      .order("full_name", { ascending: true })
      .limit(6),
  ]);

  const specialists = (topPhysicians ?? []).map((doc) => ({
    name: doc.full_name,
    specialty: doc.specialty,
    photoUrl: physicianPhotoUrl({ slug: doc.slug, photo_path: doc.photo_path }),
  }));

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <Hero />
      <TrustStrip />
      <HowItWorks />
      <EcgDivider dur={8} begin={1} />
      <Services />
      <Packages />
      <EcgDivider dur={10} begin={4} />
      <Specialists physicians={specialists} totalCount={physicianCount ?? 19} />
      <Testimonials />
      <PortalPromo />
      <HmoSection />
      <EcgDivider dur={12} begin={7} />
      <Payments />
      <Gallery />
      <Faq />
      <Contact />
      {/* Signature ECG pulse bridging the navy contact band into the navy-deep footer. */}
      <EcgDivider variant="navy" dur={9} begin={2} />
    </>
  );
}
