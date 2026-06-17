import { z } from "zod";

export const RecoverIdSchema = z.object({
  last_name: z.string().trim().min(1, "Enter your last name."),
  email: z.string().trim().toLowerCase().email("Enter a valid email."),
  birthdate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter your date of birth."),
  // honeypot — must be empty
  company: z.string().max(0).optional(),
});
export type RecoverIdInput = z.infer<typeof RecoverIdSchema>;
