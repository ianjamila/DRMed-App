"use server";

import { headers } from "next/headers";
import Papa from "papaparse";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import {
  EXPECTED_COLUMNS,
  PatientImportRowSchema,
  type PatientImportRow,
} from "@/lib/validations/patient-import";

const MAX_ROWS = 2000; // sanity cap per import
const BATCH_SIZE = 200;

export interface ImportRowError {
  row: number;
  reason: string;
}

export type ImportResult =
  | {
      ok: true;
      imported: number;
      skipped: number;
      errors: ImportRowError[];
    }
  | { ok: false; error: string };

export async function importPatientsAction(
  _prev: ImportResult | null,
  formData: FormData,
): Promise<ImportResult> {
  const session = await requireAdminStaff();

  const csv = (formData.get("csv") ?? "").toString().trim();
  if (!csv) return { ok: false, error: "Paste a CSV first." };

  const preRegistered = (formData.get("pre_registered") ?? "") === "on";

  const parse = Papa.parse<Record<string, string>>(csv, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim().toLowerCase().replace(/\s+/g, "_"),
  });

  if (parse.errors.length > 0) {
    return {
      ok: false,
      error: `CSV parse error: ${parse.errors[0]?.message ?? "unknown"}`,
    };
  }

  const fields = parse.meta.fields ?? [];
  const missing = EXPECTED_COLUMNS.filter(
    (c) =>
      // first_name, last_name, birthdate are required; rest are optional headers
      ["first_name", "last_name", "birthdate"].includes(c) && !fields.includes(c),
  );
  if (missing.length > 0) {
    return {
      ok: false,
      error: `Missing required columns: ${missing.join(", ")}.`,
    };
  }

  if (parse.data.length === 0) {
    return { ok: false, error: "No data rows found." };
  }
  if (parse.data.length > MAX_ROWS) {
    return {
      ok: false,
      error: `Too many rows (${parse.data.length}). Max ${MAX_ROWS} per import.`,
    };
  }

  const validRows: PatientImportRow[] = [];
  const errors: ImportRowError[] = [];

  parse.data.forEach((raw, idx) => {
    const result = PatientImportRowSchema.safeParse(raw);
    if (result.success) {
      validRows.push(result.data);
    } else {
      const reason = result.error.issues
        .map((i) => `${i.path.join(".") || "(row)"}: ${i.message}`)
        .join("; ");
      errors.push({ row: idx + 2 /* +1 header +1 1-based */, reason });
    }
  });

  let imported = 0;
  if (validRows.length > 0) {
    const admin = createAdminClient();
    const insertRows = validRows.map((r) => ({
      ...r,
      pre_registered: preRegistered,
      created_by: session.user_id,
    }));

    for (let i = 0; i < insertRows.length; i += BATCH_SIZE) {
      const batch = insertRows.slice(i, i + BATCH_SIZE);
      const { error } = await admin.from("patients").insert(batch);
      if (error) {
        return {
          ok: false,
          error: `Imported ${imported} before failure: ${error.message}`,
        };
      }
      imported += batch.length;
    }
  }

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "patients.bulk_imported",
    metadata: {
      total_rows: parse.data.length,
      imported,
      skipped: errors.length,
      pre_registered: preRegistered,
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  return {
    ok: true,
    imported,
    skipped: errors.length,
    errors,
  };
}
