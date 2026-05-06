import { createAdminClient } from "@/lib/supabase/admin";
import { CONTACT } from "@/lib/marketing/site";
import { DisplayPoller } from "./poller";

export const metadata = {
  title: "Now serving · drmed.ph",
  // Keep the display out of search engines and AI crawlers — it's an
  // internal kiosk view, not public content.
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

interface Serving {
  drm_id: string;
  display_name: string;
  service_name: string;
  started_at: string | null;
}

interface Waiting {
  drm_id: string;
  display_name: string;
  service_name: string;
}

const NAME_FALLBACK = "—";

function maskName(first: string | null, last: string | null): string {
  if (!first && !last) return NAME_FALLBACK;
  const f = (first ?? "").trim();
  const l = (last ?? "").trim();
  const lInitial = l ? `${l[0]}.` : "";
  return [f, lInitial].filter(Boolean).join(" ") || NAME_FALLBACK;
}

async function loadDisplayData(): Promise<{
  nowServing: Serving[];
  waiting: Waiting[];
  closuresToday: { closed_on: string; reason: string }[];
}> {
  const admin = createAdminClient();

  // Manila "today" for the closure banner.
  const today = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  const [
    { data: inProgress },
    { data: requested },
    { data: closures },
  ] = await Promise.all([
    admin
      .from("test_requests")
      .select(
        `
          id, started_at,
          services!inner ( name ),
          visits!inner (
            patients!inner ( drm_id, first_name, last_name )
          )
        `,
      )
      .eq("status", "in_progress")
      .order("started_at", { ascending: false })
      .limit(6),
    admin
      .from("test_requests")
      .select(
        `
          id,
          services!inner ( name ),
          visits!inner (
            patients!inner ( drm_id, first_name, last_name )
          )
        `,
      )
      .eq("status", "requested")
      .order("requested_at", { ascending: true })
      .limit(8),
    admin
      .from("clinic_closures")
      .select("closed_on, reason")
      .gte("closed_on", today)
      .lte("closed_on", today),
  ]);

  const nowServing: Serving[] = [];
  for (const r of inProgress ?? []) {
    const svc = Array.isArray(r.services) ? r.services[0] : r.services;
    const visit = Array.isArray(r.visits) ? r.visits[0] : r.visits;
    const patient = Array.isArray(visit?.patients)
      ? visit.patients[0]
      : visit?.patients;
    if (!svc || !patient) continue;
    nowServing.push({
      drm_id: patient.drm_id,
      display_name: maskName(patient.first_name, patient.last_name),
      service_name: svc.name,
      started_at: r.started_at,
    });
  }

  const waiting: Waiting[] = [];
  for (const r of requested ?? []) {
    const svc = Array.isArray(r.services) ? r.services[0] : r.services;
    const visit = Array.isArray(r.visits) ? r.visits[0] : r.visits;
    const patient = Array.isArray(visit?.patients)
      ? visit.patients[0]
      : visit?.patients;
    if (!svc || !patient) continue;
    waiting.push({
      drm_id: patient.drm_id,
      display_name: maskName(patient.first_name, patient.last_name),
      service_name: svc.name,
    });
  }

  return { nowServing, waiting, closuresToday: closures ?? [] };
}

export default async function DisplayPage() {
  const { nowServing, waiting, closuresToday } = await loadDisplayData();
  const closure = closuresToday[0] ?? null;

  return (
    <div className="min-h-screen bg-[color:var(--color-brand-navy)] p-6 text-white sm:p-10">
      <DisplayPoller intervalSec={10} />

      <header className="flex items-baseline justify-between gap-4">
        <h1 className="font-[family-name:var(--font-heading)] text-3xl font-extrabold tracking-tight sm:text-5xl">
          Now serving
        </h1>
        <p className="text-xs font-mono uppercase tracking-widest text-white/60">
          drmed.ph
        </p>
      </header>

      {closure ? (
        <div className="mt-6 rounded-xl border border-amber-300/40 bg-amber-300/10 p-4 text-amber-100">
          <p className="text-xs font-bold uppercase tracking-wider text-amber-200">
            Closure today
          </p>
          <p className="mt-1 text-sm sm:text-base">{closure.reason}</p>
        </div>
      ) : null}

      <section className="mt-8 grid gap-3 sm:gap-4">
        {nowServing.length === 0 ? (
          <p className="rounded-xl border border-white/15 bg-white/5 p-6 text-center text-sm text-white/70 sm:text-base">
            No tests currently in progress.
          </p>
        ) : (
          nowServing.map((row) => (
            <article
              key={`${row.drm_id}-${row.service_name}`}
              className="grid grid-cols-[auto_1fr] items-center gap-4 rounded-xl border border-[color:var(--color-brand-cyan)]/40 bg-white/10 p-4 sm:p-6"
            >
              <p className="font-mono text-2xl font-extrabold text-[color:var(--color-brand-cyan)] sm:text-4xl">
                {row.drm_id}
              </p>
              <div>
                <p className="font-[family-name:var(--font-heading)] text-xl font-extrabold sm:text-3xl">
                  {row.display_name}
                </p>
                <p className="text-sm text-white/70 sm:text-base">
                  {row.service_name}
                </p>
              </div>
            </article>
          ))
        )}
      </section>

      <section className="mt-10 grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-white/15 bg-white/5 p-5 sm:p-6">
          <p className="text-xs font-bold uppercase tracking-wider text-white/60">
            Waiting list
          </p>
          {waiting.length === 0 ? (
            <p className="mt-3 text-sm text-white/70">
              No tests pending — please proceed to reception when called.
            </p>
          ) : (
            <ol className="mt-3 grid gap-2 text-sm">
              {waiting.map((row, i) => (
                <li
                  key={`${row.drm_id}-${row.service_name}-${i}`}
                  className="flex items-baseline justify-between gap-3 border-b border-white/10 pb-2 last:border-b-0 last:pb-0"
                >
                  <span className="font-mono text-white/60">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="flex-1 font-mono text-white/80">
                    {row.drm_id}
                  </span>
                  <span className="text-white/70">{row.service_name}</span>
                </li>
              ))}
            </ol>
          )}
        </div>

        <div className="rounded-xl border border-white/15 bg-white/5 p-5 sm:p-6">
          <p className="text-xs font-bold uppercase tracking-wider text-white/60">
            Reminders
          </p>
          <ul className="mt-3 grid gap-2 text-sm sm:text-base">
            <li>
              <span className="font-bold text-[color:var(--color-brand-cyan)]">
                Fasting:
              </span>{" "}
              FBS, Lipid Profile, OGTT — at least 8 hours, water only.
            </li>
            <li>
              <span className="font-bold text-[color:var(--color-brand-cyan)]">
                Hours:
              </span>{" "}
              {CONTACT.hours}
            </li>
            <li>
              <span className="font-bold text-[color:var(--color-brand-cyan)]">
                Bring:
              </span>{" "}
              Valid ID, plus your HMO card if applicable.
            </li>
            <li>
              <span className="font-bold text-[color:var(--color-brand-cyan)]">
                Lost your receipt?
              </span>{" "}
              Reception can reissue your Secure PIN.
            </li>
          </ul>
        </div>
      </section>

      <footer className="mt-10 text-center text-xs uppercase tracking-widest text-white/40">
        Auto-refreshes every 10 seconds · Patient privacy: only DRM-IDs and
        first names are shown
      </footer>
    </div>
  );
}
