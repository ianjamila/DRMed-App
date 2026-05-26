"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Parsed CSV row before insert.
interface ParsedLine {
  transaction_date: string;
  description: string | null;
  reference: string | null;
  amount_php: number;
}

const UploadSchema = z.object({
  account_id: z.string().uuid("Pick a cash account."),
  period_start: z.string().regex(DATE_RE, "Pick a period start."),
  period_end: z.string().regex(DATE_RE, "Pick a period end."),
  statement_label: z.string().trim().min(1).max(120),
  raw_filename: z.string().max(255).optional().nullable(),
  csv_text: z.string().min(1, "Paste at least one row of CSV."),
});

export type ActionResult<T = void> =
  | (T extends void ? { ok: true } : { ok: true; data: T })
  | { ok: false; error: string };

// Lenient date parser: accepts YYYY-MM-DD, MM/DD/YYYY, DD/MM/YYYY (only YYYY
// is unambiguous), MMM DD YYYY ("Sep 15 2026"). Returns ISO YYYY-MM-DD on
// success, null on failure.
function parseDate(raw: string): string | null {
  const v = raw.trim();
  if (DATE_RE.test(v)) return v;

  const slash = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    const [, a, b, y] = slash;
    // Assume MM/DD/YYYY (PH convention follows US for printed slips).
    const month = a.padStart(2, "0");
    const day = b.padStart(2, "0");
    return `${y}-${month}-${day}`;
  }

  const iso = new Date(v);
  if (!Number.isNaN(iso.getTime())) {
    return iso.toISOString().slice(0, 10);
  }
  return null;
}

// Parse a single CSV line, splitting on commas with naive quote handling.
function splitCsvRow(row: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (c === '"' && row[i + 1] === '"' && inQuotes) {
      cur += '"';
      i++;
    } else if (c === '"') {
      inQuotes = !inQuotes;
    } else if (c === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseCsv(csv: string): { lines: ParsedLine[]; errors: string[] } {
  const rows = csv
    .split(/\r?\n/)
    .map((r) => r.trim())
    .filter((r) => r.length > 0);

  if (rows.length === 0) return { lines: [], errors: ["Empty CSV."] };

  // Expect header row: transaction_date, description, reference, amount_php
  // — or any of (date, memo|description, ref|reference, amount|amount_php).
  const header = splitCsvRow(rows[0]).map((h) => h.toLowerCase());
  const idxDate = header.findIndex(
    (h) => h === "transaction_date" || h === "date",
  );
  const idxDesc = header.findIndex(
    (h) => h === "description" || h === "memo" || h === "details",
  );
  const idxRef = header.findIndex(
    (h) => h === "reference" || h === "ref" || h === "reference_no",
  );
  const idxAmt = header.findIndex(
    (h) => h === "amount_php" || h === "amount" || h === "amount_in_php",
  );

  if (idxDate < 0 || idxAmt < 0) {
    return {
      lines: [],
      errors: [
        "Header row must include columns 'date' (or 'transaction_date') and 'amount' (or 'amount_php').",
      ],
    };
  }

  const lines: ParsedLine[] = [];
  const errors: string[] = [];

  for (let i = 1; i < rows.length; i++) {
    const cols = splitCsvRow(rows[i]);
    const rawDate = cols[idxDate];
    const rawAmt = cols[idxAmt];
    const rawDesc = idxDesc >= 0 ? cols[idxDesc] : "";
    const rawRef = idxRef >= 0 ? cols[idxRef] : "";

    const parsedDate = parseDate(rawDate);
    if (!parsedDate) {
      errors.push(`Row ${i + 1}: could not parse date "${rawDate}".`);
      continue;
    }
    const amt = Number(String(rawAmt).replace(/[,₱\s]/g, ""));
    if (!Number.isFinite(amt) || amt === 0) {
      errors.push(`Row ${i + 1}: could not parse amount "${rawAmt}".`);
      continue;
    }
    lines.push({
      transaction_date: parsedDate,
      description: rawDesc || null,
      reference: rawRef || null,
      amount_php: amt,
    });
  }

  return { lines, errors };
}

export async function uploadBankStatement(
  input: z.infer<typeof UploadSchema>,
): Promise<ActionResult<{ id: string; auto_matched: number; unmatched: number; errors: string[] }>> {
  const session = await requireAdminStaff();

  const parsed = UploadSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    };
  }
  const data = parsed.data;
  if (data.period_end < data.period_start) {
    return { ok: false, error: "Period end must be on or after period start." };
  }

  const { lines: parsedLines, errors: parseErrors } = parseCsv(data.csv_text);
  if (parsedLines.length === 0) {
    return {
      ok: false,
      error:
        parseErrors[0] ?? "No valid rows in CSV. Check the header and amounts.",
    };
  }

  const admin = createAdminClient();

  const { data: statement, error: stErr } = await admin
    .from("bank_statements")
    .insert({
      account_id: data.account_id,
      period_start: data.period_start,
      period_end: data.period_end,
      statement_label: data.statement_label,
      raw_filename: data.raw_filename ?? null,
      uploaded_by: session.user_id,
    })
    .select("id")
    .single();
  if (stErr || !statement) {
    return {
      ok: false,
      error: `Could not create statement: ${stErr?.message ?? "unknown"}`,
    };
  }

  const linesToInsert = parsedLines.map((l) => ({
    statement_id: statement.id,
    transaction_date: l.transaction_date,
    description: l.description,
    reference: l.reference,
    amount_php: l.amount_php,
  }));

  const { error: lineErr } = await admin
    .from("bank_statement_lines")
    .insert(linesToInsert);
  if (lineErr) {
    await admin.from("bank_statements").delete().eq("id", statement.id);
    return { ok: false, error: `Could not insert lines: ${lineErr.message}` };
  }

  // Auto-match: for each bank line, find a journal_line on the same cash
  // account, within ±3 days of transaction_date, with the matching signed
  // amount. Skip JE lines that are already matched to another bank line.
  const matchResult = await runAutoMatch(statement.id, data.account_id);

  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "bank_statement.uploaded",
    resource_type: "bank_statements",
    resource_id: statement.id,
    metadata: {
      account_id: data.account_id,
      lines: parsedLines.length,
      auto_matched: matchResult.matched,
    },
  });

  revalidatePath("/staff/admin/accounting/bank-rec");
  revalidatePath(`/staff/admin/accounting/bank-rec/${statement.id}`);

  return {
    ok: true,
    data: {
      id: statement.id,
      auto_matched: matchResult.matched,
      unmatched: parsedLines.length - matchResult.matched,
      errors: parseErrors,
    },
  };
}

interface AutoMatchResult {
  matched: number;
}

async function runAutoMatch(
  statementId: string,
  accountId: string,
): Promise<AutoMatchResult> {
  const admin = createAdminClient();

  const { data: bankLines } = await admin
    .from("bank_statement_lines")
    .select("id, transaction_date, amount_php")
    .eq("statement_id", statementId)
    .is("matched_je_line_id", null);

  if (!bankLines || bankLines.length === 0) return { matched: 0 };

  // Pull JE lines on this account that aren't already matched to ANY bank
  // line. Filter by date range covering all bank lines ±3 days.
  const minDate = bankLines.reduce(
    (min, b) => (b.transaction_date < min ? b.transaction_date : min),
    bankLines[0].transaction_date,
  );
  const maxDate = bankLines.reduce(
    (max, b) => (b.transaction_date > max ? b.transaction_date : max),
    bankLines[0].transaction_date,
  );
  const windowStart = shiftDate(minDate, -3);
  const windowEnd = shiftDate(maxDate, 3);

  const { data: alreadyMatched } = await admin
    .from("bank_statement_lines")
    .select("matched_je_line_id")
    .not("matched_je_line_id", "is", null);
  const matchedIds = new Set(
    (alreadyMatched ?? [])
      .map((m) => m.matched_je_line_id)
      .filter((x): x is string => !!x),
  );

  const { data: jeLines } = await admin
    .from("journal_lines")
    .select(
      `
      id, debit_php, credit_php,
      journal_entries!inner ( posting_date, status )
    `,
    )
    .eq("account_id", accountId)
    .eq("journal_entries.status", "posted")
    .gte("journal_entries.posting_date", windowStart)
    .lte("journal_entries.posting_date", windowEnd);

  if (!jeLines || jeLines.length === 0) return { matched: 0 };

  // Bucket JE lines by signed amount for O(1) lookup.
  // Signed amount = debit - credit (debit on cash = inflow, credit = outflow).
  type JeBucket = { id: string; postingDate: string; consumed: boolean };
  const bucket = new Map<number, JeBucket[]>();
  for (const je of jeLines) {
    if (matchedIds.has(je.id)) continue;
    const je2 = je as unknown as {
      id: string;
      debit_php: number;
      credit_php: number;
      journal_entries: { posting_date: string };
    };
    const signed = Number(je2.debit_php) - Number(je2.credit_php);
    const arr = bucket.get(signed) ?? [];
    arr.push({
      id: je2.id,
      postingDate: je2.journal_entries.posting_date,
      consumed: false,
    });
    bucket.set(signed, arr);
  }

  const matches: { bankLineId: string; jeLineId: string }[] = [];
  for (const bl of bankLines) {
    const candidates = bucket.get(Number(bl.amount_php));
    if (!candidates) continue;
    const ranked = candidates
      .filter((c) => !c.consumed)
      .map((c) => ({
        c,
        delta: Math.abs(
          Date.parse(c.postingDate) - Date.parse(bl.transaction_date),
        ),
      }))
      .sort((a, b) => a.delta - b.delta);
    if (ranked.length === 0) continue;
    // Require a unique best match (no ties within 1 day) to avoid wrong-pick.
    if (ranked.length > 1 && ranked[0].delta === ranked[1].delta) continue;
    ranked[0].c.consumed = true;
    matches.push({ bankLineId: bl.id, jeLineId: ranked[0].c.id });
  }

  if (matches.length === 0) return { matched: 0 };

  // Update each matched bank line. Doing this in a loop is O(N) writes; the
  // payoff is each row gets its own matched_je_line_id. Could be batched
  // with a CTE if we ever hit performance issues.
  const session = await requireAdminStaff();
  const nowIso = new Date().toISOString();
  for (const m of matches) {
    await admin
      .from("bank_statement_lines")
      .update({
        matched_je_line_id: m.jeLineId,
        matched_at: nowIso,
        matched_by: session.user_id,
        match_method: "auto",
      })
      .eq("id", m.bankLineId);
  }

  return { matched: matches.length };
}

function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00+08:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function rerunAutoMatch(statementId: string): Promise<ActionResult> {
  await requireAdminStaff();
  const admin = createAdminClient();
  const { data: st } = await admin
    .from("bank_statements")
    .select("account_id")
    .eq("id", statementId)
    .maybeSingle();
  if (!st) return { ok: false, error: "Statement not found." };
  await runAutoMatch(statementId, st.account_id);
  revalidatePath(`/staff/admin/accounting/bank-rec/${statementId}`);
  return { ok: true };
}

const ManualMatchSchema = z.object({
  bank_line_id: z.string().uuid(),
  je_line_id: z.string().uuid(),
});

export async function manualMatch(
  input: z.infer<typeof ManualMatchSchema>,
): Promise<ActionResult> {
  const session = await requireAdminStaff();
  const parsed = ManualMatchSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("bank_statement_lines")
    .update({
      matched_je_line_id: parsed.data.je_line_id,
      matched_at: new Date().toISOString(),
      matched_by: session.user_id,
      match_method: "manual",
    })
    .eq("id", parsed.data.bank_line_id);
  if (error) return { ok: false, error: error.message };

  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "bank_line.matched_manual",
    resource_type: "bank_statement_lines",
    resource_id: parsed.data.bank_line_id,
    metadata: { je_line_id: parsed.data.je_line_id },
  });

  const { data: bl } = await admin
    .from("bank_statement_lines")
    .select("statement_id")
    .eq("id", parsed.data.bank_line_id)
    .maybeSingle();
  if (bl?.statement_id) {
    revalidatePath(`/staff/admin/accounting/bank-rec/${bl.statement_id}`);
  }
  return { ok: true };
}

export async function unmatchBankLine(bankLineId: string): Promise<ActionResult> {
  const session = await requireAdminStaff();
  const admin = createAdminClient();
  const { data: bl } = await admin
    .from("bank_statement_lines")
    .select("statement_id, matched_je_line_id")
    .eq("id", bankLineId)
    .maybeSingle();
  if (!bl) return { ok: false, error: "Line not found." };

  const { error } = await admin
    .from("bank_statement_lines")
    .update({
      matched_je_line_id: null,
      matched_at: null,
      matched_by: null,
      match_method: null,
    })
    .eq("id", bankLineId);
  if (error) return { ok: false, error: error.message };

  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "bank_line.unmatched",
    resource_type: "bank_statement_lines",
    resource_id: bankLineId,
    metadata: { was_matched_to: bl.matched_je_line_id },
  });

  if (bl.statement_id) {
    revalidatePath(`/staff/admin/accounting/bank-rec/${bl.statement_id}`);
  }
  return { ok: true };
}

export async function uploadAndRedirect(
  input: z.infer<typeof UploadSchema>,
) {
  const r = await uploadBankStatement(input);
  if (r.ok) {
    redirect(`/staff/admin/accounting/bank-rec/${r.data.id}`);
  }
  return r;
}
