import { z } from "zod";

export const PaymentMethodEnum = z.enum([
  "cash",
  "gcash",
  "maya",
  "card",
  "bank_transfer",
]);

export const PaymentRecordSchema = z.object({
  visit_id: z.string().uuid(),
  amount_php: z
    .string()
    .transform((v) => Number(v))
    .pipe(z.number().positive("Amount must be greater than zero.")),
  method: PaymentMethodEnum,
  reference_number: z
    .string()
    .trim()
    .max(80)
    .or(z.literal(""))
    .transform((v) => (v === "" ? null : v))
    .nullable(),
  notes: z
    .string()
    .trim()
    .max(2000)
    .or(z.literal(""))
    .transform((v) => (v === "" ? null : v))
    .nullable(),
});

export type PaymentRecordInput = z.infer<typeof PaymentRecordSchema>;
