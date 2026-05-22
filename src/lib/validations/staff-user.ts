import { z } from "zod";

export const StaffRoleEnum = z.enum([
  "reception",
  "medtech",
  "pathologist",
  "admin",
  "xray_technician",
]);

// Constrained by migration 0007: staff_profiles.prc_license_kind check.
export const PrcLicenseKindEnum = z.enum(["RMT", "MD", "RT", "pathologist"]);

// FormData → either a trimmed string or null. Empty strings (the select's
// "—" option, an empty text input) are coerced to null so they clear the
// column rather than store as "".
const optionalPrcKind = z
  .union([PrcLicenseKindEnum, z.literal(""), z.null(), z.undefined()])
  .transform((v) => (v === "" || v == null ? null : v));

const optionalLicenseNo = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v) => {
    const t = (v ?? "").toString().trim();
    return t.length === 0 ? null : t;
  })
  .pipe(z.string().max(40).nullable());

export const StaffCreateSchema = z.object({
  email: z.string().trim().toLowerCase().email("Invalid email."),
  full_name: z.string().trim().min(1, "Full name is required.").max(160),
  role: StaffRoleEnum,
  password: z
    .string()
    .min(10, "Password must be at least 10 characters."),
});

export const StaffUpdateSchema = z.object({
  full_name: z.string().trim().min(1, "Full name is required.").max(160),
  role: StaffRoleEnum,
  is_active: z
    .union([z.literal("on"), z.literal("true"), z.literal("false"), z.null()])
    .transform((v) => v === "on" || v === "true"),
  prc_license_kind: optionalPrcKind,
  prc_license_no: optionalLicenseNo,
});

export const ChangePasswordSchema = z
  .object({
    current_password: z.string().min(1, "Current password is required."),
    new_password: z
      .string()
      .min(10, "New password must be at least 10 characters."),
    confirm_password: z.string().min(1, "Please confirm the new password."),
  })
  .refine((d) => d.new_password === d.confirm_password, {
    message: "Passwords do not match.",
    path: ["confirm_password"],
  })
  .refine((d) => d.new_password !== d.current_password, {
    message: "New password must differ from current.",
    path: ["new_password"],
  });

export const AdminResetPasswordSchema = z.object({
  new_password: z
    .string()
    .min(10, "Password must be at least 10 characters."),
});

export type StaffCreateInput = z.infer<typeof StaffCreateSchema>;
export type StaffUpdateInput = z.infer<typeof StaffUpdateSchema>;
export type ChangePasswordInput = z.infer<typeof ChangePasswordSchema>;
export type AdminResetPasswordInput = z.infer<typeof AdminResetPasswordSchema>;
