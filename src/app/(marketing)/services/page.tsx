import { permanentRedirect } from "next/navigation";

// Legacy URL — the searchable catalog now lives at /all-services so the
// "Services" anchor on the homepage and the curated /packages page are
// distinct from the full DB-backed directory.
export default function LegacyServicesIndex() {
  permanentRedirect("/all-services");
}
