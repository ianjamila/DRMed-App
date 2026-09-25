import { z } from "zod";

export const SERVICE_KINDS = [
  "lab_test",
  "lab_package",
  "doctor_consultation",
  "doctor_procedure",
  "home_service",
  "vaccine",
] as const;

export type ServiceKind = (typeof SERVICE_KINDS)[number];

export const SERVICE_SECTIONS = [
  "package",
  "chemistry",
  "hematology",
  "immunology",
  "urinalysis",
  "microbiology",
  "imaging_xray",
  "imaging_ultrasound",
  "imaging_ecg",
  "vaccine",
  "send_out",
  "consultation",
  "procedure",
  "home_service",
] as const;

const checkbox = z
  .union([z.literal("on"), z.literal("true"), z.literal("false"), z.null()])
  .transform((v) => v === "on" || v === "true");

const optionalNumber = z
  .string()
  .or(z.literal(""))
  .transform((v) => (v === "" ? null : Number(v)))
  .pipe(z.number().nonnegative("Must be 0 or greater.").nullable())
  .nullable();

const optionalText = z
  .string()
  .trim()
  .max(2000)
  .or(z.literal(""))
  .transform((v) => (v === "" ? null : v))
  .nullable();

export const ServiceSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .min(1, "Code is required.")
    .max(40)
    .regex(/^[A-Z0-9_-]+$/, "Code can only contain A-Z, 0-9, underscore, dash."),
  name: z.string().trim().min(1, "Name is required.").max(160),
  description: optionalText,
  price_php: z
    .string()
    .transform((v) => Number(v))
    .pipe(z.number().nonnegative("Price must be 0 or greater.")),
  hmo_price_php: optionalNumber,
  turnaround_hours: z
    .string()
    .or(z.literal(""))
    .transform((v) => (v === "" ? null : Number(v)))
    .pipe(z.number().int().positive().nullable())
    .nullable(),
  kind: z.enum(SERVICE_KINDS),
  section: z
    .union([z.enum(SERVICE_SECTIONS), z.literal("")])
    .transform((v) => (v === "" ? null : v))
    .nullable(),
  is_send_out: checkbox,
  // Public listing image: absolute URL (https://…) or site-relative path
  // (/photos/x.jpg). Empty → null (falls back to the brand default image).
  image_url: z
    .string()
    .trim()
    .max(500)
    .or(z.literal(""))
    .transform((v) => (v === "" ? null : v))
    .refine(
      (v) => v === null || /^(https?:\/\/|\/)/.test(v),
      "Image must be a full URL (https://…) or a path starting with /.",
    )
    .nullable(),
  is_active: checkbox,
  requires_signoff: checkbox,
  // Senior/PWD 20% eligibility. Unchecked → false (e.g. lab packages, already
  // sold at a bundle discount). New services default to checked in the form.
  senior_pwd_eligible: checkbox,
});

export type ServiceInput = z.infer<typeof ServiceSchema>;

// ---------------------------------------------------------------------------
// Send-out lab selection (0164) — the service form's "Partner lab" select
// replaced the old free-text `send_out_lab` input. `services.send_out_lab`
// (text) is still the column every reader (lab queue, quotes, marketing
// catalogue) displays, so it's derived here from the chosen vendor's name
// rather than typed directly.
// ---------------------------------------------------------------------------

export interface PartnerLabOption {
  id: string;
  name: string;
}

export interface SendOutVendorSelection {
  vendorId: string | null;
  labName: string | null;
}

/** The row's send-out lab columns before this save, so the resolver can tell
 *  an unrelated edit from a deliberate change to the lab. */
export interface ExistingSendOutLab {
  vendorId: string | null;
  labName: string | null;
}

export type SendOutVendorResult =
  | { ok: true; data: SendOutVendorSelection }
  | { ok: false; error: string };

/**
 * Resolves the form's raw `send_out_vendor_id` selection into the pair of
 * columns actually persisted. Pure — takes the candidate partner-lab list (and
 * the row's current lab, for an update) as parameters instead of querying, so
 * it's unit-testable without a DB.
 *
 * - Not a send-out service → always null/null, regardless of what was
 *   submitted (a direct POST can't smuggle a vendor onto a non-send-out row).
 * - Send-out with no lab picked ("— Not set —"):
 *   - if the row already had a proper vendor link, this is a deliberate
 *     clear → null/null.
 *   - if the row only ever had unmatched legacy free text (no
 *     `send_out_vendor_id`), "— Not set —" is just the select's default and
 *     doesn't mean the admin touched the lab — keep the legacy text rather
 *     than erasing it under an unrelated save.
 * - Send-out, re-selecting the row's OWN current lab → kept as-is, even if
 *   that vendor has since gone inactive or lost its partner-lab flag —
 *   active-partner validation only guards a NEW pick, not leaving an old one
 *   alone.
 * - Send-out with a different lab picked → the vendor must be in the active
 *   partner-lab list, or this returns an error.
 */
export function resolveSendOutVendorSelection(
  isSendOut: boolean,
  selectedVendorId: string | null | undefined,
  activePartnerLabs: PartnerLabOption[],
  existing?: ExistingSendOutLab | null,
): SendOutVendorResult {
  if (!isSendOut) return { ok: true, data: { vendorId: null, labName: null } };

  const trimmed = (selectedVendorId ?? "").trim();
  if (trimmed === "") {
    const keepLegacyText = !existing?.vendorId && !!existing?.labName;
    return { ok: true, data: { vendorId: null, labName: keepLegacyText ? existing!.labName : null } };
  }

  if (existing?.vendorId && trimmed === existing.vendorId) {
    return { ok: true, data: { vendorId: existing.vendorId, labName: existing.labName } };
  }

  const match = activePartnerLabs.find((v) => v.id === trimmed);
  if (!match) {
    return { ok: false, error: "Selected lab is not an active partner lab." };
  }
  return { ok: true, data: { vendorId: match.id, labName: match.name } };
}
