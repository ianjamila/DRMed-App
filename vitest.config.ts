import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// First unit-test runner in the repo. Pure logic only (no DB / no RSC) —
// modules under test must not `import "server-only"`. The `@/` alias mirrors
// tsconfig.json so test files import the same way app code does.
//
// `.test.tsx` is included for the handful of *client* components worth
// asserting markup on (e.g. the staff sidebar's collapsed-by-default
// sections). Those render through `react-dom/server`'s
// renderToStaticMarkup — still no DOM, still no RSC.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.test.ts"],
  },
});
