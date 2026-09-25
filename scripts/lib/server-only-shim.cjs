/**
 * `--require` preload that neutralises the `server-only` marker package for
 * `tsx` runners that need to call a function which lazily imports a
 * server-only module — currently `loadResultDocumentInput` in
 * src/lib/results/loaders.ts, which lazy-imports src/lib/supabase/admin.ts
 * and ./signatures.ts, both `import "server-only"`.
 *
 * `server-only`'s default export unconditionally throws — it is only made
 * inert under Next's RSC bundler, which resolves the package's `exports`
 * "react-server" condition to `empty.js` instead of `index.js` (see
 * node_modules/server-only/package.json). Passing `--conditions=react-server`
 * to `tsx` would do the same thing globally, but that also repoints React's
 * own conditional exports, which breaks @react-pdf/renderer's reconciler
 * (verified empirically 2026-09-25 — it throws deep in
 * @react-pdf/reconciler on a `--conditions=react-server` run). So instead of
 * a resolution condition, this preloads a synthetic, already-"loaded" cache
 * entry for `server-only`'s resolved path — the same effect as `empty.js`,
 * scoped to exactly this one package, before anything else requires it.
 *
 * Usage: `tsx --require ./scripts/lib/server-only-shim.cjs <script>.ts`
 * (see the `smoke:chemistry` npm script).
 */
const path = require.resolve("server-only");
require.cache[path] = {
  id: path,
  filename: path,
  loaded: true,
  exports: {},
};
