"use client";

// Reads `?subject=` (e.g. from a "Get a Corporate Quote" CTA) and pre-selects
// it in the shared ContactForm. Kept as its own tiny client component, wrapped
// in <Suspense> by the page, so useSearchParams' prerendering bailout is
// scoped to just this leaf rather than the whole /contact page (see
// use-search-params.md: "wrapping the Client Component that uses
// useSearchParams in a Suspense boundary" keeps everything above it static).

import { useSearchParams } from "next/navigation";
import { ContactForm } from "./contact-form";
import { CONTACT_SUBJECT_OPTIONS } from "@/lib/contact-messages/labels";

export function ContactFormWithPreset() {
  const searchParams = useSearchParams();
  const raw = searchParams.get("subject");
  const defaultSubject =
    raw && (CONTACT_SUBJECT_OPTIONS as readonly string[]).includes(raw) ? raw : undefined;
  return <ContactForm defaultSubject={defaultSubject} />;
}
