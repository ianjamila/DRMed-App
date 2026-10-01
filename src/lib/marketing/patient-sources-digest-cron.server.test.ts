import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/audit/log", () => ({ audit: async () => undefined }));
vi.mock("@/lib/observability/report-error", () => ({ reportError: async () => undefined }));
vi.mock("@/lib/notifications/email", () => ({ sendEmail: async () => ({ ok: true, id: "x" }) }));
vi.mock("@/lib/notifications/staff-alert-recipients", () => ({ resolveStaffAlertRecipients: async () => ({}) }));
vi.mock("@/lib/marketing/patient-sources-digest.server", () => ({ buildPatientSourcesDigestEmail: async () => ({ ok: false, message: "unused" }) }));

import { normaliseAlertSentMetadata, alertLastSentLine } from "@/lib/notifications/alert-last-sent";
import type { SendResult } from "@/lib/notifications/email";
import {
  runPatientSourcesDigest,
  supabaseDigestStore,
  type DigestRowStatus,
  type DigestRunDeps,
  type DigestSendStore,
} from "./patient-sources-digest-cron.server";

const PERIOD = { from: "2026-09-28", to: "2026-10-04" };
const NOW = new Date("2026-10-04T23:00:00Z"); // Monday 07:00 Manila, 2026-10-05

function setup(over: Partial<DigestRunDeps> = {}, preset: Record<string, DigestRowStatus> = {}) {
  const rows = new Map<string, { status: DigestRowStatus; attempts: number; error?: string | null }>(
    Object.entries(preset).map(([k, status]) => [k, { status, attempts: 1 }] as const),
  );
  const audits: Array<{ action: string; metadata: Record<string, unknown> }> = [];
  const sends: Array<{ to: string; subject: string; idempotencyKey?: string }> = [];
  const reported: string[] = [];
  const claims: Array<{ recipient: string; includeUnknown: boolean }> = [];
  let recordError: string | null = null;
  const store: DigestSendStore = {
    // Mirrors the SQL claim's contract; one synchronous read-modify-write, like the single statement.
    claim: async (_k, _f, _t, recipient, includeUnknown) => {
      claims.push({ recipient, includeUnknown });
      const row = rows.get(recipient);
      if (!row) {
        rows.set(recipient, { status: "sending", attempts: 1 });
        return { attempts: 1, error: null };
      }
      if (row.status === "failed" || (includeUnknown && row.status === "unknown")) {
        row.status = "sending";
        row.attempts += 1;
        return { attempts: row.attempts, error: null };
      }
      return { attempts: null, error: null };
    },
    statusOf: async (_k, _f, recipient) => rows.get(recipient)?.status ?? null,
    record: async (_k, _f, recipient, patch) => {
      const row = rows.get(recipient);
      if (row && !recordError) {
        row.status = patch.status;
        row.error = patch.error ?? null;
      }
      return recordError;
    },
  };
  const build = vi.fn(async (_kind: string, _anchor: string) => ({
    ok: true as const,
    kind: "email" as const,
    period: PERIOD,
    subject: "Patient sources, Wk of 28 Sep: 12 new (▲ 4)",
    html: "<p>h</p>",
    text: "t",
  }));
  const resolveRecipients = vi.fn(async () => ({
    enabled: true,
    emails: ["Owner@Example.com", "ops@example.com"],
    staffOn: [],
    staffWithoutEmail: [],
    loadError: null as string | null,
  }));
  let sendImpl: (to: string) => Promise<SendResult> = async () => ({ ok: true, id: "em_1" });
  const deps: DigestRunDeps = {
    now: () => NOW,
    resolveRecipients,
    build,
    store,
    send: async (input) => {
      sends.push({ to: input.to, subject: input.subject, idempotencyKey: input.idempotencyKey });
      return sendImpl(input.to);
    },
    audit: async (e) => void audits.push({ action: e.action, metadata: (e.metadata ?? {}) as Record<string, unknown> }),
    reportError: async (a) => void reported.push(a.scope),
    ...over,
  };
  return {
    deps, rows, audits, sends, reported, claims, build, resolveRecipients,
    setSend: (fn: (to: string) => Promise<SendResult>) => (sendImpl = fn),
    setRecordError: (e: string | null) => (recordError = e),
  };
}
const sentMeta = (audits: Array<{ action: string; metadata: Record<string, unknown> }>) =>
  audits.find((a) => a.action === "system.patient_sources_weekly.sent")!.metadata;

describe("runPatientSourcesDigest", () => {
  it("claims and sends once per recipient, with an idempotency key per attempt, then records and audits", async () => {
    const t = setup();
    const out = await runPatientSourcesDigest(t.deps, { kind: "week" });
    expect(out).toMatchObject({ status: 200, failed: false });
    expect(t.sends.map((s) => s.to)).toEqual(["Owner@Example.com", "ops@example.com"]);
    expect(t.sends[0]!.idempotencyKey).toBe("patient_sources_weekly:2026-09-28:owner@example.com:1");
    expect([...t.rows.values()].map((r) => r.status)).toEqual(["sent", "sent"]);
    expect(t.build).toHaveBeenCalledWith("week", "2026-10-05");
    expect(t.audits.map((a) => a.action)).toEqual(["system.patient_sources_weekly.sent", "system.patient_sources_weekly.completed"]);
    expect(sentMeta(t.audits)).toMatchObject({ period_from: "2026-09-28", period_to: "2026-10-04", recipients: 2, sent: 2, failed: 0, unknown: 0, already_sent: 0 });
    expect(sentMeta(t.audits)).not.toHaveProperty("skipped");
  });

  it("a switched-off / empty alert: no build, no send, still audited and completed (the heartbeat)", async () => {
    const t = setup();
    t.resolveRecipients.mockResolvedValue({ enabled: false, emails: [], staffOn: [], staffWithoutEmail: [], loadError: null });
    const out = await runPatientSourcesDigest(t.deps, { kind: "week" });
    expect(out).toMatchObject({ status: 200, failed: false });
    expect(t.build).not.toHaveBeenCalled();
    expect(t.sends).toHaveLength(0);
    expect(sentMeta(t.audits)).toMatchObject({ recipients: 0, sent: 0, skipped: "turned off in Email Alerts" });
    expect(t.audits.at(-1)!.action).toBe("system.patient_sources_weekly.completed");
  });

  it("reports an unreadable recipient list instead of 'nobody is switched on'", async () => {
    const t = setup();
    t.resolveRecipients.mockResolvedValue({ enabled: true, emails: [], staffOn: [], staffWithoutEmail: [], loadError: "staff list: down" });
    await runPatientSourcesDigest(t.deps, { kind: "week" });
    expect(sentMeta(t.audits).skipped).toMatch(/couldn't read who gets this alert/);
    expect(sentMeta(t.audits).recipients_error).toBe("staff list: down");
  });

  it("everyone already has it: nothing sent, a skipped REASON (not a failure), completed", async () => {
    const t = setup({}, { "owner@example.com": "sent", "ops@example.com": "sent" });
    const out = await runPatientSourcesDigest(t.deps, { kind: "week" });
    expect(out).toMatchObject({ status: 200, failed: false });
    expect(t.sends).toHaveLength(0);
    expect(sentMeta(t.audits)).toMatchObject({ recipients: 2, sent: 0, failed: 0, already_sent: 2, skipped: "already sent to everyone for this period" });
    expect(alertLastSentLine(normaliseAlertSentMetadata(sentMeta(t.audits)))).toBe("sent to 0 of 2 (already sent to everyone for this period)");
    expect(t.audits.at(-1)!.action).toBe("system.patient_sources_weekly.completed");
  });

  it("two overlapping invocations: each recipient is emailed exactly once", async () => {
    const t = setup();
    const [a, b] = await Promise.all([
      runPatientSourcesDigest(t.deps, { kind: "week" }),
      runPatientSourcesDigest(t.deps, { kind: "week" }),
    ]);
    expect(t.sends.map((s) => s.to).sort()).toEqual(["Owner@Example.com", "ops@example.com"]);
    expect([a.failed, b.failed]).toEqual([false, false]);
  });

  it("a DEFINITE failure is recorded failed, flags the monitor, and is retried on the next run; sent rows are not", async () => {
    const t = setup();
    t.setSend(async (to) => (to === "ops@example.com" ? { ok: false, kind: "error", error: "Resend 422: bad", definite: true } : { ok: true, id: "em_1" }));
    const first = await runPatientSourcesDigest(t.deps, { kind: "week" });
    expect(first.failed).toBe(true);
    expect(t.rows.get("ops@example.com")!.status).toBe("failed");
    expect(sentMeta(t.audits)).toMatchObject({ sent: 1, failed: 1, unknown: 0 });

    t.setSend(async () => ({ ok: true, id: "em_2" }));
    t.sends.length = 0;
    const second = await runPatientSourcesDigest(t.deps, { kind: "week" });
    expect(t.sends.map((s) => s.to)).toEqual(["ops@example.com"]);
    expect(t.sends[0]!.idempotencyKey).toBe("patient_sources_weekly:2026-09-28:ops@example.com:2");
    expect(second.failed).toBe(false);
  });

  it("an UNCERTAIN failure (fetch threw / unreadable reply) is recorded unknown and never re-sent automatically", async () => {
    const t = setup();
    t.setSend(async () => ({ ok: false, kind: "error", error: "socket hang up", definite: false }));
    const first = await runPatientSourcesDigest(t.deps, { kind: "week" });
    expect(first.failed).toBe(true);
    expect([...t.rows.values()].map((r) => r.status)).toEqual(["unknown", "unknown"]);
    expect(sentMeta(t.audits)).toMatchObject({ sent: 0, failed: 0, unknown: 2 });

    t.sends.length = 0;
    t.setSend(async () => ({ ok: true, id: "em_3" }));
    const second = await runPatientSourcesDigest(t.deps, { kind: "week" });
    expect(t.sends).toHaveLength(0); // nothing re-sends by itself
    expect(second.failed).toBe(true); // …and the unknown rows keep the monitor red until an operator looks
    expect(sentMeta(t.audits.slice(2))).toMatchObject({ unknown: 2, already_sent: 0 });
  });

  it("tells the owner about an unconfirmed delivery in the Last-sent line (skipped string), combined with other reasons", async () => {
    const t = setup();
    t.setSend(async (to) =>
      to === "ops@example.com" ? { ok: false, kind: "error", error: "socket hang up", definite: false } : { ok: true, id: "em_ok" },
    );
    await runPatientSourcesDigest(t.deps, { kind: "week" });
    const line = alertLastSentLine(normaliseAlertSentMetadata(sentMeta(t.audits)));
    expect(line).toBe("sent to 1 of 2 (1 delivery not confirmed — check Resend before re-sending)");

    const t2 = setup();
    t2.setSend(async () => ({ ok: false, kind: "error", error: "socket hang up", definite: false }));
    await runPatientSourcesDigest(t2.deps, { kind: "week" });
    expect(normaliseAlertSentMetadata(sentMeta(t2.audits)).skipped).toBe("2 deliveries not confirmed — check Resend before re-sending");
    // a later run that only finds the unknown rows still says so
    await runPatientSourcesDigest(t2.deps, { kind: "week" });
    expect(normaliseAlertSentMetadata(sentMeta(t2.audits.slice(2))).skipped).toBe("2 deliveries not confirmed — check Resend before re-sending");

    const t3 = setup();
    t3.setSend(async () => ({ ok: false, kind: "skipped", reason: "email not configured" }));
    await runPatientSourcesDigest(t3.deps, { kind: "week" });
    expect(normaliseAlertSentMetadata(sentMeta(t3.audits)).skipped).toBe("email not configured");
  });

  it("a missing `definite` flag counts as uncertain, and a thrown send does too", async () => {
    const t = setup();
    t.setSend(async (to) => {
      if (to === "ops@example.com") throw new Error("boom");
      return { ok: false, kind: "error", error: "no flag" };
    });
    await runPatientSourcesDigest(t.deps, { kind: "week" });
    expect([...t.rows.values()].map((r) => r.status)).toEqual(["unknown", "unknown"]);
  });

  it("an operator retry with include_unknown re-sends unknown rows (and only then)", async () => {
    const t = setup({}, { "owner@example.com": "unknown", "ops@example.com": "sent" });
    const out = await runPatientSourcesDigest(t.deps, { kind: "week", periodFrom: "2026-09-21", includeUnknown: true });
    expect(t.claims.every((c) => c.includeUnknown)).toBe(true);
    expect(t.sends.map((s) => s.to)).toEqual(["Owner@Example.com"]);
    expect(out.failed).toBe(false);
  });

  it("a SKIPPED send (not live / not configured) is a definite failure: row failed, reason surfaced, not blocking", async () => {
    const t = setup();
    t.setSend(async () => ({ ok: false, kind: "skipped", reason: "NOTIFICATIONS_LIVE not enabled in this environment" }));
    const out = await runPatientSourcesDigest(t.deps, { kind: "week" });
    expect(out.failed).toBe(true);
    expect([...t.rows.values()].map((r) => r.status)).toEqual(["failed", "failed"]);
    expect(sentMeta(t.audits)).toMatchObject({ sent: 0, failed: 2, skipped: "NOTIFICATIONS_LIVE not enabled in this environment" });
  });

  it("a claim that finds a row still in flight sends nothing and says so", async () => {
    const t = setup({}, { "owner@example.com": "sending", "ops@example.com": "sent" });
    const out = await runPatientSourcesDigest(t.deps, { kind: "week" });
    expect(t.sends).toHaveLength(0);
    expect(sentMeta(t.audits)).toMatchObject({ already_sent: 1, in_flight: 1 });
    expect(out.failed).toBe(false);
  });

  it("a record-write error after a send is reported and flags the monitor — never thrown", async () => {
    const t = setup();
    t.setRecordError("db down");
    const out = await runPatientSourcesDigest(t.deps, { kind: "week" });
    expect(out.failed).toBe(true);
    expect(t.reported).toContain("cron/patient-sources-digest");
    expect(t.audits.map((a) => a.action)).toContain("system.patient_sources_weekly.completed");
  });

  it("a claim error flags the monitor and sends nothing to that recipient", async () => {
    const t = setup();
    t.deps.store.claim = async () => ({ attempts: null, error: "rpc down" });
    const out = await runPatientSourcesDigest(t.deps, { kind: "week" });
    expect(out.failed).toBe(true);
    expect(t.sends).toHaveLength(0);
    expect(sentMeta(t.audits)).toMatchObject({ failed: 2, sent: 0 });
  });

  it("a report/spend failure: 500, nothing sent, the monitor fails, and NO heartbeat is written", async () => {
    const t = setup();
    t.build.mockResolvedValue({ ok: false, message: "report: boom" } as never);
    const out = await runPatientSourcesDigest(t.deps, { kind: "week" });
    expect(out).toMatchObject({ status: 500, failed: true });
    expect(t.sends).toHaveLength(0);
    expect(t.audits).toHaveLength(0);
    expect(t.reported).toContain("cron/patient-sources-digest");
  });

  it("too_early completes without sending (and says why on the Email Alerts line)", async () => {
    const t = setup();
    t.build.mockResolvedValue({ ok: true, kind: "too_early", period: { from: "2023-11-01", to: "2023-11-30" } } as never);
    const out = await runPatientSourcesDigest(t.deps, { kind: "week" });
    expect(out).toMatchObject({ status: 200, failed: false });
    expect(t.sends).toHaveLength(0);
    expect(sentMeta(t.audits).skipped).toMatch(/first date/);
    expect(t.audits.at(-1)!.action).toBe("system.patient_sources_weekly.completed");
  });

  it("?period_from= targets that period (a rollover cannot move it) and re-resolves recipients now", async () => {
    const t = setup();
    // The cron ran late: it is now Monday 2026-10-12 Manila, but the retry names the week of 2026-09-28.
    t.deps.now = () => new Date("2026-10-11T23:00:00Z");
    await runPatientSourcesDigest(t.deps, { kind: "week", periodFrom: "2026-09-28" });
    expect(t.build).toHaveBeenCalledWith("week", "2026-10-05"); // the day AFTER that week → the builder derives Sep 28–Oct 4
    expect(t.resolveRecipients).toHaveBeenCalledTimes(1);
    expect(sentMeta(t.audits)).toMatchObject({ period_from: "2026-09-28", period_to: "2026-10-04" });
  });

  it("monthly uses its own key, audit actions and period", async () => {
    const t = setup();
    t.build.mockResolvedValue({ ok: true as const, kind: "email" as const, period: { from: "2026-09-01", to: "2026-09-30" }, subject: "S", html: "h", text: "t" });
    await runPatientSourcesDigest(t.deps, { kind: "month" });
    expect(t.audits.map((a) => a.action)).toEqual(["system.patient_sources_monthly.sent", "system.patient_sources_monthly.completed"]);
    expect(t.sends[0]!.idempotencyKey).toBe("patient_sources_monthly:2026-09-01:owner@example.com:1");
  });
});

describe("supabaseDigestStore", () => {
  function fakeAdmin(o: { rpc?: { data: unknown; error: { message: string } | null }; status?: string | null; update?: { data: unknown; error: { message: string } | null } }) {
    const calls: Array<[string, unknown[]]> = [];
    const chain = (result: unknown) => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in"]) {
        b[m] = (...a: unknown[]) => {
          calls.push([m, a]);
          return b;
        };
      }
      b.maybeSingle = async () => result;
      b.then = (ok: (v: unknown) => unknown) => Promise.resolve(result).then(ok);
      return b;
    };
    const admin = {
      rpc: async (fn: string, args: unknown) => {
        calls.push(["rpc", [fn, args]]);
        return o.rpc ?? { data: 1, error: null };
      },
      from: (t: string) => {
        calls.push(["from", [t]]);
        return {
          select: (...a: unknown[]) => {
            calls.push(["select", a]);
            return chain({ data: o.status === undefined ? null : { status: o.status }, error: null });
          },
          update: (...a: unknown[]) => {
            calls.push(["update", a]);
            return chain(o.update ?? { data: [{ recipient: "x" }], error: null });
          },
        };
      },
    } as never;
    return { admin, calls };
  }

  it("claim maps the attempt number, NULL (not claimed) and an error", async () => {
    const ok = fakeAdmin({ rpc: { data: 2, error: null } });
    expect(await supabaseDigestStore(ok.admin).claim("patient_sources_weekly", "2026-09-28", "2026-10-04", "a@x.com", true)).toEqual({ attempts: 2, error: null });
    expect(ok.calls[0]).toEqual([
      "rpc",
      ["_ps_digest_claim", { p_key: "patient_sources_weekly", p_from: "2026-09-28", p_to: "2026-10-04", p_recipient: "a@x.com", p_include_unknown: true }],
    ]);
    expect(await supabaseDigestStore(fakeAdmin({ rpc: { data: null, error: null } }).admin).claim("patient_sources_weekly", "a", "b", "r", false)).toEqual({ attempts: null, error: null });
    expect(await supabaseDigestStore(fakeAdmin({ rpc: { data: null, error: { message: "nope" } } }).admin).claim("patient_sources_weekly", "a", "b", "r", false)).toEqual({ attempts: null, error: "nope" });
  });
  it("statusOf reads the row's status or null", async () => {
    expect(await supabaseDigestStore(fakeAdmin({ status: "unknown" }).admin).statusOf("patient_sources_weekly", "2026-09-28", "a@x.com")).toBe("unknown");
    expect(await supabaseDigestStore(fakeAdmin({ status: null }).admin).statusOf("patient_sources_weekly", "2026-09-28", "a@x.com")).toBeNull();
  });
  it("record updates only a row this run claimed (sending) or an operator re-opened (unknown)", async () => {
    const f = fakeAdmin({});
    expect(await supabaseDigestStore(f.admin).record("patient_sources_weekly", "2026-09-28", "a@x.com", { status: "sent", providerId: "em_1" })).toBeNull();
    const update = f.calls.find(([m]) => m === "update")![1][0] as Record<string, unknown>;
    expect(update).toMatchObject({ status: "sent", provider_id: "em_1", last_error: null });
    expect(f.calls).toContainEqual(["in", ["status", ["sending", "unknown"]]]);
  });
  it("record reports an error, and a missing row", async () => {
    expect(await supabaseDigestStore(fakeAdmin({ update: { data: null, error: { message: "db down" } } }).admin).record("patient_sources_weekly", "a", "r", { status: "failed", error: "x" })).toBe("db down");
    expect(await supabaseDigestStore(fakeAdmin({ update: { data: [], error: null } }).admin).record("patient_sources_weekly", "a", "r", { status: "sent" })).toMatch(/no claimed row/);
  });
});

describe("module guard", () => {
  it("names none of the admin-only functions", () => {
    const src = readFileSync("src/lib/marketing/patient-sources-digest-cron.server.ts", "utf8");
    for (const name of ["patient_sources_revenue", "patient_sources_overlaps", "patient_sources_referrers", "patient_sources_people", "ad_spend_daily_totals", "ad_spend_coverage", "ad_spend_rows", "patient_sources_report"]) {
      expect(src, name).not.toContain(name);
    }
  });
});
