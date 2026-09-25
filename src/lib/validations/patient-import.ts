import Papa from "papaparse";
import { z } from "zod";

// An optional column that is left out of the CSV header row entirely (as
// opposed to a column that's present with a blank cell) comes back from
// Papa.parse with the key simply absent from the row object, i.e. `undefined`
// — not `""`. `.optional()` accepts that, and the trailing transform folds
// both "blank cell" and "omitted column" down to the same `null`, so an
// omitted optional column behaves exactly like an empty cell.
const trimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .or(z.literal(""))
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional()
    .transform((v) => v ?? null);

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
      .nullable()
      .optional()
      .transform((v) => v ?? null),
    phone: trimmed(40),
    // M10: optional, but a present value must be a real address (dedup key +
    // DRM-ID delivery channel) — matches PatientFields.email in patient.ts.
    email: z
      .string()
      .trim()
      .email("email must be a valid email address")
      .max(160)
      .or(z.literal(""))
      .transform((v) => (v === "" ? null : v))
      .nullable()
      .optional()
      .transform((v) => v ?? null),
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

// Only these three MUST be present as header columns. The rest are optional
// — omit the column entirely or leave individual cells blank, same result.
export const REQUIRED_IMPORT_COLUMNS: readonly (typeof EXPECTED_COLUMNS)[number][] =
  ["first_name", "last_name", "birthdate"];

/** Same header normalization the import CSV parser uses. */
export function normalizeImportHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, "_");
}

/** Which required columns (by normalized name) are absent from the header row. */
export function missingRequiredImportColumns(
  fields: readonly string[],
): string[] {
  return EXPECTED_COLUMNS.filter(
    (c) => REQUIRED_IMPORT_COLUMNS.includes(c) && !fields.includes(c),
  );
}

/** Parses import CSV text the same way for the server action and for tests. */
export function parseImportCsv(csv: string) {
  return Papa.parse<Record<string, string>>(csv, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: normalizeImportHeader,
  });
}
