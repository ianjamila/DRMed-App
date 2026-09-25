/**
 * What each package in the Quick Quote catalog includes, and which picked
 * tests a picked package already covers.
 *
 * A package (0040) is one priced service whose tests live in
 * `package_components`. The quote list showed it as a bare name and price, so
 * reception had to open the services admin to answer "what's in it?", and
 * nothing stopped a quote charging for CBC twice — once inside the package
 * and once on its own.
 *
 * No `server-only` import: the page builds the lists and the client
 * workbench checks overlaps, both from this one file.
 */

export interface PackageIncludedTest {
  id: string;
  name: string;
  /** The test's service code, so a search for "FBS" finds the packages covering it. */
  code?: string;
}

interface EmbeddedComponent {
  id: string;
  name: string;
  code?: string | null;
}

/** A `package_components` row as the quote page selects it. */
export interface PackageComponentRow {
  package_service_id: string;
  sort_order: number;
  // PostgREST types an embedded to-one as an object or a one-element array
  // depending on how it infers the relationship.
  component: EmbeddedComponent | EmbeddedComponent[] | null;
}

/**
 * Package service id → its tests, in the package's own `sort_order` (name
 * breaks a tie so the list never reshuffles between loads). A row whose
 * component service is unreadable is dropped rather than shown as a blank.
 */
export function packageContents(
  rows: readonly PackageComponentRow[],
): Map<string, PackageIncludedTest[]> {
  const sorted = [...rows]
    .map((r) => ({
      pkg: r.package_service_id,
      order: r.sort_order,
      comp: Array.isArray(r.component) ? r.component[0] : r.component,
    }))
    .filter((r): r is typeof r & { comp: EmbeddedComponent } => Boolean(r.comp))
    .sort(
      (a, b) =>
        a.order - b.order ||
        a.comp.name.localeCompare(b.comp.name) ||
        a.comp.id.localeCompare(b.comp.id),
    );

  const out = new Map<string, PackageIncludedTest[]>();
  for (const r of sorted) {
    const arr = out.get(r.pkg) ?? [];
    arr.push({ id: r.comp.id, name: r.comp.name, ...(r.comp.code ? { code: r.comp.code } : {}) });
    out.set(r.pkg, arr);
  }
  return out;
}

/**
 * For each picked service that one of the other picked services (a package)
 * already includes: the name of the first such package, in picked order.
 */
export function coveredByPickedPackage(
  picked: readonly { id: string; name: string; includes: readonly PackageIncludedTest[] }[],
): Map<string, string> {
  const covered = new Map<string, string>();
  for (const pkg of picked) {
    for (const t of pkg.includes) {
      if (t.id === pkg.id || covered.has(t.id)) continue;
      if (picked.some((p) => p.id === t.id)) covered.set(t.id, pkg.name);
    }
  }
  return covered;
}

export interface QuoteSearchMatch<S> {
  service: S;
  /**
   * The included tests that made a package match, when it matched ONLY
   * through them — so the row can say why a search for "urinalysis" turned
   * up the Executive Package. Empty for a direct name/code match.
   */
  viaIncludes: string[];
}

/**
 * The Quick Quote search: services whose name or code contains the query,
 * then packages that don't match themselves but include a test whose name or code does.
 * Direct matches come first — someone typing "urinalysis" most likely wants
 * the test itself — and each group keeps the catalog's own order.
 */
export function matchQuoteServices<
  S extends { name: string; code: string; includes: readonly PackageIncludedTest[] },
>(services: readonly S[], query: string): QuoteSearchMatch<S>[] {
  const q = query.trim().toLowerCase();
  if (!q) return services.map((service) => ({ service, viaIncludes: [] }));

  const direct: QuoteSearchMatch<S>[] = [];
  const viaPackage: QuoteSearchMatch<S>[] = [];
  for (const service of services) {
    if (`${service.name} ${service.code}`.toLowerCase().includes(q)) {
      direct.push({ service, viaIncludes: [] });
      continue;
    }
    const hits = service.includes
      .filter((t) => `${t.name} ${t.code ?? ""}`.toLowerCase().includes(q))
      .map((t) => t.name);
    if (hits.length > 0) viaPackage.push({ service, viaIncludes: hits });
  }
  return [...direct, ...viaPackage];
}
