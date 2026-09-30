// How a released result reaches the patient. One list for every release
// control (visit page, bulk bars, lab queue) and the server-side validation.
export const RELEASE_MEDIA = ["physical", "email", "viber", "gcash", "pickup", "other"] as const;
export type ReleaseMedium = (typeof RELEASE_MEDIA)[number];

export const RELEASE_MEDIUM_OPTIONS: ReadonlyArray<{ value: ReleaseMedium; label: string }> = [
  { value: "physical", label: "Physical" },
  { value: "email", label: "Email" },
  { value: "viber", label: "Viber" },
  { value: "gcash", label: "GCash" },
  { value: "pickup", label: "Pickup" },
  { value: "other", label: "Other" },
];

export function isReleaseMedium(v: unknown): v is ReleaseMedium {
  return typeof v === "string" && (RELEASE_MEDIA as readonly string[]).includes(v);
}
