import { JsonLd } from "@/components/marketing/json-ld";
import { breadcrumbLd, faqPageLd } from "@/lib/marketing/structured-data";
import type { FaqItem } from "@/lib/marketing/faq";

/**
 * Structured-data block shared by every /promo landing page: a Home → page
 * breadcrumb trail plus the page's FAQPage schema. Pass the same `faq` array
 * that feeds {@link PromoFaq} so the rendered accordion and the JSON-LD stay in
 * sync.
 */
export function PromoJsonLd({
  name,
  path,
  faq,
}: {
  /** Leaf breadcrumb label (Home is prepended automatically). */
  name: string;
  /** Leaf breadcrumb path, e.g. "/promo/one-roof". */
  path: string;
  faq: readonly FaqItem[];
}) {
  return (
    <JsonLd
      data={[
        breadcrumbLd([
          { name: "Home", path: "/" },
          { name, path },
        ]),
        faqPageLd(faq),
      ]}
    />
  );
}
