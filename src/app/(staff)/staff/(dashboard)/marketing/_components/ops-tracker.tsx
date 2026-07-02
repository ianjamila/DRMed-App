"use client";

// Marketing operations tracker, ported from the standalone marketing-kit tool
// (DRMed-marketing-kit/dashboards/drmed-ops-tracker.jsx). Fully client-side:
// daily/weekly/monthly/quarterly checklists that auto-reset each period, the
// 12-week launch roadmap, and the campaign status board — all persisted in
// localStorage. Keeps the marketing kit's own palette (matches the ad
// dashboard), distinct from the staff-portal brand tokens.

import { useEffect, useState, useSyncExternalStore } from "react";
import {
  CheckCircle2,
  Circle,
  CalendarDays,
  Repeat,
  Map,
  Megaphone,
  RotateCcw,
  type LucideIcon,
} from "lucide-react";

/* ---------- palette (matches ad-dashboard.tsx) ---------- */
const C = {
  ink: "#0B3A3D",
  bg: "#EDF2F1",
  surface: "#FFFFFF",
  line: "#D8E4E2",
  sub: "#5C7271",
  text: "#11302F",
  accent: "#E8743B",
  good: "#1B9C76",
  warn: "#C98A00",
  bad: "#D1503F",
  meta: "#5B6CFF",
};
const KEY = "drmed_ops_v1";

/* ---------- period keys (auto-reset checklists each period) ---------- */
const today = new Date();
const pad = (n: number) => String(n).padStart(2, "0");
const dayKey = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${pad(Math.ceil(((t.getTime() - y0.getTime()) / 86400000 + 1) / 7))}`;
}
const weekKey = isoWeek(today);
const monthKey = `${today.getFullYear()}-${pad(today.getMonth() + 1)}`;
const qKey = `${today.getFullYear()}-Q${Math.floor(today.getMonth() / 3) + 1}`;

/* ---------- cadence tasks (from Plan v2 §9) ---------- */
type CadenceId = "daily" | "weekly" | "monthly" | "quarterly";

interface Cadence {
  id: CadenceId;
  label: string;
  period: string;
  budget: string;
  icon: LucideIcon;
  tasks: string[];
}

const CADENCES: Cadence[] = [
  {
    id: "daily",
    label: "Daily",
    period: dayKey,
    budget: "≤30–45 min",
    icon: Repeat,
    tasks: [
      "Reply to all Messenger / form / call leads (speed = conversion)",
      "Check ad accounts: spend pacing, disapprovals, CPC/CPL spikes",
      "Produce 1 raw creative asset (post, Reel hook, tip, promo graphic)",
      "Reply to new Google/Facebook reviews",
      "Log today's bookings by source (front desk: “how did you hear about us?”)",
    ],
  },
  {
    id: "weekly",
    label: "Weekly",
    period: weekKey,
    budget: "~1–2 hrs",
    icon: CalendarDays,
    tasks: [
      "Review scoreboard: bookings + cost/booking by source & tier",
      "Kill losers, scale winners; adjust budgets/bids",
      "Pull Google Search Terms report → add negative keywords",
      "Refresh ads past ~2–3 weeks or frequency > 2.5 (fatigue)",
      "Corporate pipeline review: new HR leads, pilots, quotes → contracts",
      "Queue next week's organic + paid creative batch",
    ],
  },
  {
    id: "monthly",
    label: "Monthly",
    period: monthKey,
    budget: "~half-day",
    icon: CalendarDays,
    tasks: [
      "Plan next month's campaign(s) from library + seasonal calendar",
      "Build them: copy pack (Claude) → visuals (Canva) → launch",
      "Send the monthly newsletter + launch-synced promo email",
      "Full performance report + double-down / drop decisions",
      "Competitor & price sweep (KeyHealth, Dynami, RK Scan, KBM, chains)",
      "Pricing/promo decisions (QCID, payday, seasonal)",
      "Refresh content calendar; export ads baseline CSV → dashboard",
    ],
  },
  {
    id: "quarterly",
    label: "Quarterly",
    period: qKey,
    budget: "steering",
    icon: Map,
    tasks: [
      "Revisit positioning, packages & pricing vs market",
      "Review unit economics; reallocate channel budget",
      "New pillars / channels decision",
      "Phase 2 gate: any manning-agency commitment? (seafarer PEME)",
      "Hours-gap decision review (6am open / Sunday test)",
    ],
  },
];

/* ---------- 12-week roadmap (Plan v2 §8) ---------- */
interface RoadmapPhase {
  wk: string;
  name: string;
  detail: string;
}

const ROADMAP: RoadmapPhase[] = [
  { wk: "Wk 1", name: "Baseline & tracking", detail: "Export Meta+Google baseline · GA4 conversions + UTMs · optimize GBP · turn on review requests" },
  { wk: "Wk 1–2", name: "Restructure live ads", detail: "Apply channel-role split · add negatives · pause off-target spend" },
  { wk: "Wk 2–3", name: "Pages & positioning", detail: "Landing pages (C1, C4, C5) · transparent pricing pages · new positioning site-wide" },
  { wk: "Wk 3–4", name: "Launch B2C + retargeting", detail: "Campaigns 1, 2, 8 live · corporate one-pager + prospect list started" },
  { wk: "Wk 4–6", name: "Corporate + specialists", detail: "Campaign 5 lead-gen + outbound · Campaign 6 · first onsite pilot" },
  { wk: "Wk 6–12", name: "Optimize & compound", detail: "Seasonal calendar · weekly scoreboard · creative refresh · scale winners" },
];

/* ---------- campaign board ---------- */
interface Campaign {
  n: number;
  name: string;
  ch: string;
}

const CAMPAIGNS: Campaign[] = [
  { n: 1, name: "Beat the Hospital Price", ch: "Google + Messenger" },
  { n: 2, name: "Results Tomorrow, No Rush Fee", ch: "Meta + Google" },
  { n: 3, name: "We Come to You", ch: "Meta + Google" },
  { n: 4, name: "One Roof: Lab + 20 Specialists", ch: "Meta + Google" },
  { n: 5, name: "Corporate Health Partner", ch: "Lead-gen + outbound" },
  { n: 6, name: "Specialist Spotlight", ch: "Google + Meta" },
  { n: 7, name: "Seasonal & Condition", ch: "Meta-led calendar" },
  { n: 8, name: "Retargeting + Reputation", ch: "Meta RT + email/SMS" },
];

const STATUSES = ["Brief", "Built", "Live", "Paused"] as const;
type CampaignStatus = (typeof STATUSES)[number];

const statusColor = (s: CampaignStatus) =>
  s === "Live" ? C.good : s === "Built" ? C.meta : s === "Paused" ? C.warn : C.sub;

const DEFAULT_STATUS: Record<number, CampaignStatus> = { 1: "Built", 5: "Built" };

/* ---------- persisted state shapes ---------- */
interface CadenceState {
  period: string;
  checked: boolean[];
}
type DoneState = Record<string, CadenceState>;
type StatusState = Record<number, CampaignStatus>;
type TabId = "cadence" | "roadmap" | "campaigns";

// Hydration flag without a setState-in-an-effect step: the server snapshot is
// false, the client snapshot is true, so the first post-hydration render flips
// it (same useSyncExternalStore approach as run-review-client.tsx).
const emptySubscribe = () => () => {};
const getHydrated = () => true;
const getServerHydrated = () => false;

// Parse the persisted JSON defensively — the shape lives in localStorage and
// could be from an older version of this tool (or hand-edited).
function readSaved(raw: string): { done: DoneState; status: StatusState; phase: number } | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>; // narrowed to object above
    const done: DoneState = {};
    if (typeof obj.done === "object" && obj.done !== null) {
      for (const [k, v] of Object.entries(obj.done)) {
        if (typeof v !== "object" || v === null) continue;
        const c = v as Record<string, unknown>; // narrowed to object above
        if (typeof c.period === "string" && Array.isArray(c.checked)) {
          done[k] = { period: c.period, checked: c.checked.map(Boolean) };
        }
      }
    }
    const status: StatusState = {};
    if (typeof obj.status === "object" && obj.status !== null) {
      for (const [k, v] of Object.entries(obj.status)) {
        const n = Number(k);
        if (
          Number.isFinite(n) &&
          typeof v === "string" &&
          (STATUSES as readonly string[]).includes(v)
        ) {
          status[n] = v as CampaignStatus; // membership checked above
        }
      }
    }
    const phase = typeof obj.phase === "number" ? obj.phase : 0;
    return { done, status, phase };
  } catch {
    return null;
  }
}

// Read the persisted tracker state from localStorage. SSR-guarded so the lazy
// useState initializers below can call it on the server too (returns null
// there; the render is gated on hydration anyway).
function loadSaved(): { done: DoneState; status: StatusState; phase: number } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? readSaved(raw) : null;
  } catch {
    /* blocked storage — start fresh */
    return null;
  }
}

// Period-reset: keep a saved checklist only when it is for the current period
// and still matches the task list; otherwise start the period fresh.
function buildDone(saved: DoneState | undefined): DoneState {
  const fresh: DoneState = {};
  for (const c of CADENCES) {
    const s = saved?.[c.id];
    fresh[c.id] =
      s && s.period === c.period && s.checked.length === c.tasks.length
        ? s
        : { period: c.period, checked: c.tasks.map(() => false) };
  }
  return fresh;
}

function TabButton({
  id,
  icon: Icon,
  label,
  active,
  onSelect,
}: {
  id: TabId;
  icon: LucideIcon;
  label: string;
  active: boolean;
  onSelect: (id: TabId) => void;
}) {
  return (
    <button
      onClick={() => onSelect(id)}
      className="flex items-center gap-1.5 text-sm rounded-lg px-3 py-1.5 font-medium"
      style={
        active
          ? { background: C.ink, color: "#fff" }
          : { background: C.surface, border: `1px solid ${C.line}`, color: C.sub }
      }
    >
      <Icon size={14} /> {label}
    </button>
  );
}

export function OpsTracker() {
  // Saved state is read once, lazily, in the initializers below (no
  // setState-in-effect rehydration step). `hydrated` gates the render so the
  // server (which can't see localStorage and may sit in another timezone)
  // never paints mismatched HTML.
  const hydrated = useSyncExternalStore(emptySubscribe, getHydrated, getServerHydrated);
  const [saved] = useState(() => loadSaved());
  const [done, setDone] = useState<DoneState>(() => buildDone(saved?.done)); // {cadenceId: {period, checked:[bool]}}
  const [status, setStatus] = useState<StatusState>(() => ({
    ...DEFAULT_STATUS,
    ...(saved?.status ?? {}),
  }));
  // Current roadmap phase index, clamped in case the saved value predates a
  // roadmap edit.
  const [phase, setPhase] = useState(() =>
    Math.min(Math.max(saved?.phase ?? 0, 0), ROADMAP.length - 1),
  );
  const [tab, setTab] = useState<TabId>("cadence");

  /* persist */
  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(KEY, JSON.stringify({ done, status, phase }));
    } catch {
      /* storage full or blocked — state stays in memory for this session */
    }
  }, [done, status, phase, hydrated]);

  const toggle = (cid: CadenceId, i: number) =>
    setDone((d) => {
      const cur = d[cid] ?? { period: "", checked: [] };
      const checked = [...cur.checked];
      checked[i] = !checked[i];
      return { ...d, [cid]: { ...cur, checked } };
    });

  const progress = (cid: CadenceId): number => {
    const c = done[cid];
    if (!c || c.checked.length === 0) return 0;
    return c.checked.filter(Boolean).length / c.checked.length;
  };

  const resetCadence = (cid: CadenceId) => {
    const c = CADENCES.find((x) => x.id === cid);
    if (!c) return;
    setDone((d) => ({
      ...d,
      [cid]: { period: c.period, checked: c.tasks.map(() => false) },
    }));
  };

  const dateStr = today.toLocaleDateString("en-PH", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  if (!hydrated) return null;

  return (
    <div
      className="w-full rounded-2xl p-4 sm:p-6"
      style={{
        background: C.bg,
        color: C.text,
        fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      }}
    >
      <div className="mx-auto" style={{ maxWidth: 980 }}>
        {/* header */}
        <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
          <div>
            <div className="flex items-center gap-2">
              <div
                className="rounded-lg px-2 py-1 text-xs font-bold"
                style={{ background: C.ink, color: "#fff", letterSpacing: ".04em" }}
              >
                DRMed
              </div>
              <h1 className="text-xl font-semibold" style={{ color: C.ink }}>
                Marketing Operations
              </h1>
            </div>
            <p className="text-sm mt-1" style={{ color: C.sub }}>
              {dateStr} · cadence, roadmap &amp; campaign status (Plan v2 §5, §8, §9)
            </p>
          </div>
          <div className="flex gap-2">
            <TabButton id="cadence" icon={Repeat} label="Cadence" active={tab === "cadence"} onSelect={setTab} />
            <TabButton id="roadmap" icon={Map} label="Roadmap" active={tab === "roadmap"} onSelect={setTab} />
            <TabButton id="campaigns" icon={Megaphone} label="Campaigns" active={tab === "campaigns"} onSelect={setTab} />
          </div>
        </div>

        {/* ------- CADENCE ------- */}
        {tab === "cadence" && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {CADENCES.map((c) => {
              const p = progress(c.id);
              const cur = done[c.id];
              return (
                <div
                  key={c.id}
                  className="rounded-2xl p-4"
                  style={{ background: C.surface, border: `1px solid ${C.line}` }}
                >
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <c.icon size={15} style={{ color: C.ink }} />
                      <span className="font-semibold" style={{ color: C.ink }}>
                        {c.label}
                      </span>
                      <span className="text-xs" style={{ color: C.sub }}>
                        · {c.budget}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium" style={{ color: p === 1 ? C.good : C.sub }}>
                        {cur ? `${cur.checked.filter(Boolean).length}/${cur.checked.length}` : ""}
                      </span>
                      <button
                        onClick={() => resetCadence(c.id)}
                        title="Reset this checklist"
                        style={{ color: C.sub }}
                      >
                        <RotateCcw size={13} />
                      </button>
                    </div>
                  </div>
                  <div className="rounded-full overflow-hidden mb-3" style={{ background: C.bg, height: 5 }}>
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: p * 100 + "%",
                        background: p === 1 ? C.good : C.accent,
                        transition: "width .2s",
                      }}
                    />
                  </div>
                  <div className="space-y-1.5">
                    {c.tasks.map((t, i) => {
                      const on = cur ? cur.checked[i] : false;
                      return (
                        <button
                          key={i}
                          onClick={() => toggle(c.id, i)}
                          className="flex items-start gap-2 w-full text-left"
                        >
                          {on ? (
                            <CheckCircle2 size={16} style={{ color: C.good, marginTop: 2, flexShrink: 0 }} />
                          ) : (
                            <Circle size={16} style={{ color: C.line, marginTop: 2, flexShrink: 0 }} />
                          )}
                          <span
                            className="text-sm"
                            style={{ color: on ? C.sub : C.text, textDecoration: on ? "line-through" : "none" }}
                          >
                            {t}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <div className="text-xs mt-3" style={{ color: C.sub }}>
                    Auto-resets each{" "}
                    {c.id === "daily" ? "day" : c.id === "weekly" ? "week" : c.id === "monthly" ? "month" : "quarter"}{" "}
                    · period {c.period}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ------- ROADMAP ------- */}
        {tab === "roadmap" && (
          <div className="rounded-2xl p-4" style={{ background: C.surface, border: `1px solid ${C.line}` }}>
            <div className="text-sm font-semibold mb-3" style={{ color: C.ink }}>
              12-week launch roadmap — tap a phase to mark it current
            </div>
            <div className="space-y-1">
              {ROADMAP.map((r, i) => {
                const state = i < phase ? "done" : i === phase ? "current" : "next";
                return (
                  <button
                    key={i}
                    onClick={() => setPhase(i)}
                    className="w-full text-left flex items-start gap-3 rounded-xl p-3"
                    style={{
                      background: state === "current" ? C.ink + "0D" : "transparent",
                      border: `1px solid ${state === "current" ? C.ink : "transparent"}`,
                    }}
                  >
                    <div className="flex flex-col items-center" style={{ width: 20 }}>
                      {state === "done" ? (
                        <CheckCircle2 size={18} style={{ color: C.good }} />
                      ) : (
                        <Circle size={18} style={{ color: state === "current" ? C.accent : C.line }} />
                      )}
                      {i < ROADMAP.length - 1 && (
                        <div
                          style={{
                            width: 2,
                            flex: 1,
                            minHeight: 18,
                            background: i < phase ? C.good : C.line,
                            marginTop: 2,
                          }}
                        />
                      )}
                    </div>
                    <div className="pb-2">
                      <div className="flex items-center gap-2">
                        <span
                          className="text-xs font-semibold rounded-full px-2 py-0.5"
                          style={{ background: C.bg, color: C.sub }}
                        >
                          {r.wk}
                        </span>
                        <span className="font-medium text-sm" style={{ color: state === "next" ? C.sub : C.text }}>
                          {r.name}
                        </span>
                        {state === "current" && (
                          <span className="text-xs font-semibold" style={{ color: C.accent }}>
                            ← you are here
                          </span>
                        )}
                      </div>
                      <div className="text-xs mt-1" style={{ color: C.sub }}>
                        {r.detail}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
            <div className="text-xs mt-2" style={{ color: C.sub }}>
              Phase 2 (parked): seafarer/OFW PEME — revisit only on a manning-agency commitment or passage
              of the PEME choice bill.
            </div>
          </div>
        )}

        {/* ------- CAMPAIGNS ------- */}
        {tab === "campaigns" && (
          <div className="rounded-2xl" style={{ background: C.surface, border: `1px solid ${C.line}` }}>
            <div className="px-4 pt-3 pb-2 text-sm font-semibold" style={{ color: C.ink }}>
              Campaign status board — set each campaign&apos;s stage
            </div>
            <div>
              {CAMPAIGNS.map((c) => {
                const s = status[c.n] ?? "Brief";
                return (
                  <div
                    key={c.n}
                    className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
                    style={{ borderTop: `1px solid ${C.line}` }}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span
                        className="text-xs font-bold rounded-lg px-2 py-1"
                        style={{ background: C.bg, color: C.ink }}
                      >
                        C{c.n}
                      </span>
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate" style={{ color: C.text }}>
                          {c.name}
                        </div>
                        <div className="text-xs" style={{ color: C.sub }}>
                          {c.ch}
                        </div>
                      </div>
                    </div>
                    <div className="flex gap-1">
                      {STATUSES.map((st) => (
                        <button
                          key={st}
                          onClick={() => setStatus((x) => ({ ...x, [c.n]: st }))}
                          className="text-xs rounded-full px-2.5 py-1 font-medium"
                          style={
                            s === st
                              ? { background: statusColor(st), color: "#fff" }
                              : { background: C.bg, color: C.sub }
                          }
                        >
                          {st}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="px-4 py-3 text-xs" style={{ color: C.sub, borderTop: `1px solid ${C.line}` }}>
              Rhythm: 1–2 campaigns live at a time for B2C + always-on C5 (corporate) and C8
              (retargeting/reputation). New launches happen at the monthly cadence, paired with a
              newsletter send.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
