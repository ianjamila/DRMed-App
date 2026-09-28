import { getServiceAccountToken } from "../google/service-account-token";
import { readSheetTabs } from "./reader";
import type { RawTabs } from "./types";

export const SHEETS_READONLY_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";

export function missingSheetEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return ["LEGACY_SHEET_ID", "GOOGLE_SERVICE_ACCOUNT_JSON"].filter((k) => !env[k]);
}

/** The runner's readSheet dependency, built from env. Throws a plain message naming what is missing. */
export function sheetReaderFromEnv(env: NodeJS.ProcessEnv = process.env): () => Promise<RawTabs> {
  return async () => {
    const missing = missingSheetEnv(env);
    if (missing.length) throw new Error(`Sheet sync is not configured: missing ${missing.join(", ")}`);
    return readSheetTabs({
      sheetId: env.LEGACY_SHEET_ID!,
      token: () => getServiceAccountToken(env.GOOGLE_SERVICE_ACCOUNT_JSON!, SHEETS_READONLY_SCOPE),
    });
  };
}
