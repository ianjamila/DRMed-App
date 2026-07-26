import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Design-handoff bundle is reference-only (export keywords stripped, not built).
    "design-handoff/**",
    // Nested git worktrees are gitignored stale-branch copies — not in lint scope.
    ".worktrees/**",
    // Marketing-kit dashboards are standalone JSX artifacts pasted into
    // external viewers — not part of the app build, not on app lint rules.
    "DRMed-marketing-kit/**",
  ]),
]);

export default eslintConfig;
