import type { Metadata } from "next";
import { headers } from "next/headers";
import { RegisterPoster } from "./poster";

// Standalone (outside the marketing chrome), print-optimized poster reception
// can print and put on the desk. noindex — it's an internal print aid, not a
// page we want surfaced in search.
export const metadata: Metadata = {
  title: "Registration poster — drmed.ph",
  robots: { index: false, follow: false },
};

export default async function RegisterPosterPage() {
  const host = (await headers()).get("host") ?? "drmed.ph";
  const proto = host.startsWith("localhost") ? "http" : "https";
  const url = `${proto}://${host}/register?src=poster`;
  return <RegisterPoster url={url} />;
}
