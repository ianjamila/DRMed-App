import { z } from "zod";
import { MAX_PAYMENT_PHP } from "@/lib/visits/payment-edit";

export const PaymentMethodEnum = z.enum([
  "cash",
  "gcash",
  "maya",
  "card",
  "bank_transfer",
  "gift_code",
]);

export const PaymentRecordSchema = z.object({
  visit_id: z.string().uuid(),
  amount_php: z
    .string()
    .transform((v) => Number(v))
    .pipe(
      z
        .number()
        .positive("Amount must be greater than zero.")
        .max(MAX_PAYMENT_PHP, "Amount is too large."),
    ),
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

// Edit payment (0161). Only the counter methods — a gift code is redeemed,
// never keyed in, and HMO settlements come from the claims screens.
export const PaymentEditSchema = z.object({
  payment_id: z.string().uuid(),
  // Matched on the text, not the number: 5888.1 * 100 is not an integer in
  // floating point, so a numeric centavo check would refuse a valid amount.
  amount_php: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,2})?$/, "Enter an amount like 1500 or 1500.50.")
    .transform((v) => Number(v))
    .pipe(
      z
        .number()
        .positive("Amount must be greater than zero.")
        .max(MAX_PAYMENT_PHP, "Amount is too large."),
    ),
  method: z.enum(["cash", "gcash", "maya", "card", "bank_transfer"], {
    message: "Choose Cash, GCash, Maya, Card or Bank transfer.",
  }),
  reference_number: z.string().trim().max(80),
  notes: z.string().trim().max(2000),
  reason: z.string().trim().min(1, "Reason is required to edit a payment.").max(500),
  // The payment as the dialog showed it (0174 stale-state guard).
  expected: z.object({
    amount_php: z.number(),
    method: z.string().nullable(),
    reference_number: z.string().nullable(),
    notes: z.string().nullable(),
  }),
});

export type PaymentEditInput = z.infer<typeof PaymentEditSchema>;
