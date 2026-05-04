import { z } from "zod";

const optionalText = (max = 160) =>
  z
    .string()
    .trim()
    .max(max)
    .or(z.literal(""))
    .transform((v) => (v === "" ? null : v))
    .nullable();

const optionalEnum = <T extends readonly [string, ...string[]]>(
  values: T,
) =>
  z
    .enum(values as unknown as [string, ...string[]])
    .or(z.literal(""))
    .transform((v) => (v === "" ? null : v))
    .nullable();

export const ReferralSourceEnum = [
  "doctor_referral",
  "customer_referral",
  "online_facebook",
  "online_website",
  "online_google",
  "walk_in",
  "tenant_employee_northridge",
  "other",
] as const;

export const ReleaseMediumEnum = [
  "physical",
  "email",
  "viber",
  "gcash",
  "pickup",
] as const;

export const SeniorPwdKindEnum = ["senior", "pwd"] as const;

// Form sends "on" / "off" / missing for the consent checkbox. Translate to
// a literal "yes" or "no" so the Server Action can decide whether to stamp
// consent_signed_at to now() (yes when patient signs today; no preserves
// the existing timestamp without resetting it).
const consentField = z
  .union([z.literal("on"), z.literal("true"), z.literal("false"), z.null(), z.undefined()])
  .transform((v) => (v === "on" || v === "true" ? "yes" : "no"));

const PatientFields = {
  first_name: z.string().trim().min(1, "First name is required.").max(80),
  last_name: z.string().trim().min(1, "Last name is required.").max(80),
  middle_name: optionalText(80),
  birthdate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Birthdate must be YYYY-MM-DD."),
  sex: z
    .enum(["male", "female"])
    .nullable()
    .or(z.literal("").transform(() => null)),
  phone: optionalText(40),
  email: optionalText(160),
  address: optionalText(240),

  // Phase 7B.3 additions:
  referral_source: optionalEnum(ReferralSourceEnum),
  referred_by_doctor: optionalText(120),
  preferred_release_medium: optionalEnum(ReleaseMediumEnum),
  senior_pwd_id_kind: optionalEnum(SeniorPwdKindEnum),
  senior_pwd_id_number: optionalText(40),
  consent_given_today: consentField,
};

export const PatientCreateSchema = z.object(PatientFields);
export const PatientUpdateSchema = z.object(PatientFields);

export type PatientCreateInput = z.infer<typeof PatientCreateSchema>;
