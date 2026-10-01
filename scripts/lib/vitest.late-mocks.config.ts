// Base vitest config + the late-mocks setup file. Used only by
// `npm run test:stress -- --late-mocks <ms>`, which sets LATE_MOCKS_MS.
import { defineConfig, mergeConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import base from "../../vitest.config";

export default mergeConfig(
  base,
  defineConfig({
    test: {
      setupFiles: [fileURLToPath(new URL("./late-mocks-setup.ts", import.meta.url))],
    },
  }),
);
