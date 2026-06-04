import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// First unit-test runner in the repo. Pure logic only (no DB / no RSC) —
// modules under test must not `import "server-only"`. The `@/` alias mirrors
// tsconfig.json so test files import the same way app code does.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
  },
});
