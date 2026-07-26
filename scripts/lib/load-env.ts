/**
 * Side-effect module: populates `process.env` for a `scripts/` runner.
 *
 * Import this FIRST, before anything that reads `process.env` at module scope:
 *
 *     import "./lib/load-env";
 *
 * ES module imports are all evaluated before the importing module's body runs,
 * so top-level `const URL = process.env.NEXT_PUBLIC_SUPABASE_URL` reads in the
 * script itself are safe wherever they sit. Keeping this import first matters
 * only for *other* imports that read env at their own module scope.
 *
 * Defaults to `.env.development.local` (the local Supabase stack). See
 * ./env-guard.ts for the resolution and opt-in rules.
 */
import { loadScriptEnv } from "./env-guard";

loadScriptEnv();
