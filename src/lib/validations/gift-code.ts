import { z } from "zod";
import { GIFT_CODE_PATTERN, normaliseGiftCode } from "@/lib/gift-codes/labels";
import { PaymentMethodEnum } from "./payment";

const optionalText = (max: number) =>
  z
    .union([z.string(), z.null(), z.undefined()])
    .transform((v) => {
      const t = (v ?? "").toString().trim();
      return t.length === 0 ? null : t;
    })
    .pipe(z.string().max(max).nullable());

const giftCode = z
  .string()
  .trim()
  .min(1, "Gift code is required.")
  .transform(normaliseGiftCode)
  .pipe(z.string().regex(GIFT_CODE_PATTERN, "Invalid code format."));

const positiveAmount = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === "number" ? v : Number(v)))
  .pipe(z.number().positive("Face value must be greater than zero.").max(1_000_000));

export const GenerateBatchSchema = z.object({
  count: z
    .union([z.string(), z.number()])
    .transform((v) => Number(v))
    .pipe(
      z
        .number()
        .int("Count must be a whole number.")
        .min(1, "Generate at least one code.")
        .max(100, "Maximum 100 codes per batch."),
    ),
  face_value_php: positiveAmount,
  batch_label: optionalText(120),
  notes: optionalText(2000),
});

export const CancelGiftCodeSchema = z.object({
  cancellation_reason: z
    .string()
    .trim()
    .min(1, "Reason is required.")
    .max(500),
});

export const SellGiftCodeSchema = z.object({
  code: giftCode,
  buyer_name: z.string().trim().min(1, "Buyer name is required.").max(120),
  buyer_contact: z
    .string()
    .trim()
    .min(1, "Buyer contact is required.")
    .max(120),
  purchase_method: PaymentMethodEnum,
  purchase_reference_number: optionalText(80),
  notes: optionalText(2000),
});

export type GenerateBatchInput = z.infer<typeof GenerateBatchSchema>;
