import { z } from "zod";

// `DRM-` followed by at least 4 digits (sequence may exceed 9999 over time).
export const DrmIdSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^DRM-\d{4,}$/, "DRM-ID must look like DRM-0001.");

// 8 chars from the receipt alphabet — uppercase + digits, no I, O, 0, 1.
export const PinSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-HJ-NP-Z2-9]{8}$/, "PIN is 8 characters from the receipt.");

export const PatientSignInSchema = z.object({
  drm_id: DrmIdSchema,
  pin: PinSchema,
});

export type PatientSignInInput = z.infer<typeof PatientSignInSchema>;
