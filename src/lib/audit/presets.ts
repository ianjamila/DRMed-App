/**
 * One-click filters on the Audit Log (`/staff/audit`).
 *
 * Each sets the page's `action` filter, which matches as a PREFIX, so
 * "statement.email" covers both `statement.emailed` and
 * `statement.email_failed`. `presets.test.ts` fails when a preset stops
 * matching any action the code writes, so a renamed action cannot leave a
 * chip that silently finds nothing.
 */
export interface AuditPreset {
  label: string;
  action: string;
  hint: string;
}

export const AUDIT_PRESETS: readonly AuditPreset[] = [
  {
    label: "Statement emails",
    action: "statement.email",
    hint: "Statements of account emailed to patients — sent and failed attempts, with the address used",
  },
  {
    label: "All statement access",
    action: "statement.",
    hint: "Statements of account viewed, printed or emailed",
  },
  {
    label: "Receipts",
    action: "receipt.",
    hint: "Receipts viewed or printed",
  },
  {
    label: "Result downloads",
    action: "result.downloaded",
    hint: "Results patients downloaded from the portal",
  },
];
