import { z } from "zod";

const trimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .or(z.literal(""))
    .transform((v) => (v === "" ? null : v))
    .nullable();

// Coerce common Filipino-clinic date formats into ISO. Accepts:
//   2026-04-30, 2026/04/30, 04/30/2026, 30/04/2026, Apr 30 2026
function toIsoDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}\/\d{2}\/\d{2}$/.test(s)) return s.replace(/\//g, "-");
  // Numeric slash forms — assume MM/DD/YYYY (US-style spreadsheets are common).
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    const [, m, d, y] = slash;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  // Fallback: let Date parse and emit ISO date.
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }
  return null;
}

export const PatientImportRowSchema = z
  .object({
    first_name: z.string().trim().min(1, "first_name is required").max(80),
    last_name: z.string().trim().min(1, "last_name is required").max(80),
    middle_name: trimmed(80),
    birthdate: z
      .string()
      .trim()
      .min(1, "birthdate is required")
      .transform((v, ctx) => {
        const iso = toIsoDate(v);
        if (!iso) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `birthdate "${v}" couldn't be parsed`,
          });
          return z.NEVER;
        }
        return iso;
      }),
    sex: z
      .string()
      .trim()
      .toLowerCase()
      .or(z.literal(""))
      .transform((v) => (v === "" ? null : v))
      .pipe(
        z
          .enum(["male", "female", "m", "f"])
          .transform((v) => (v === "m" ? "male" : v === "f" ? "female" : v))
          .nullable(),
      )
      .nullable(),
    phone: trimmed(40),
    email: trimmed(160),
    address: trimmed(160),
  })
  .strip();

export type PatientImportRow = z.infer<typeof PatientImportRowSchema>;

export const EXPECTED_COLUMNS = [
  "first_name",
  "last_name",
  "middle_name",
  "birthdate",
  "sex",
  "phone",
  "email",
  "address",
] as const;
