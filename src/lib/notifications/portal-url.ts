import { SITE } from "@/lib/marketing/site";

// The patient portal's absolute URL, used by every patient-facing
// notification (release, corrected-result, …). One copy so it can't drift.
export const PORTAL_URL = `${SITE.url.replace(/\/$/, "")}/portal`;
