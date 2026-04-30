import { z } from "zod";

export const StaffRoleEnum = z.enum([
  "reception",
  "medtech",
  "pathologist",
  "admin",
]);

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
});

export type StaffCreateInput = z.infer<typeof StaffCreateSchema>;
export type StaffUpdateInput = z.infer<typeof StaffUpdateSchema>;
