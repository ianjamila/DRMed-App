# drmed.ph

Medical laboratory web platform for [drmed.ph](https://drmed.ph) — a unified Next.js + Supabase app serving three surfaces:

- **Marketing site** — public service info and online booking
- **Patient portal** — patients sign in with DRM-ID + receipt PIN to view and download released lab results
- **Staff portal** — reception, medtechs, pathologists, and admins manage the daily lab workflow

Built for compliance with the Philippine Data Privacy Act (RA 10173).

---

## Tech stack

- **Framework:** Next.js 15 (App Router, TypeScript, Server Components by default)
- **Styling:** Tailwind CSS v4 + shadcn/ui
- **Backend:** Supabase (Postgres, Auth, Storage, Edge Functions, Row Level Security)
- **Forms:** react-hook-form + zod
- **Hosting:** Vercel (single project, single domain)
- **Notifications:** Resend (email), Semaphore (PH SMS)
- **Accounting sync:** Google Sheets API via service account

---

## Getting started

### Prerequisites

- Node.js 20+
- npm 10+
- A Supabase project (region: `ap-southeast-1` Singapore is closest to PH)
- Supabase CLI (`npm i -g supabase`)
- A Vercel account linked to this repo

### First-time setup

1. Clone and install:
   ```bash
   git clone https://github.com/<your-org>/drmed.git
   cd drmed
   npm install
   ```

2. Copy the environment template:
   ```bash
   cp .env.example .env.local
   ```
   Fill in the values — see [Environment variables](#environment-variables) below.

3. Link your Supabase project locally:
   ```bash
   supabase login
   supabase link --project-ref <your-project-ref>
   ```

4. Apply database migrations:
   ```bash
   supabase db push
   ```

5. Generate TypeScript types from the schema:
   ```bash
   npm run db:types
   ```

6. Run the dev server:
   ```bash
   npm run dev
   ```
   Visit [http://localhost:3000](http://localhost:3000).

---

## Environment variables

See `.env.example` for the full list. You'll need separate values for local dev, preview deployments, and production. Add them to:

- `.env.local` for local dev (gitignored)
- Vercel project settings for preview and production

**Never commit `.env.local` or any file containing real keys.**

The service-role key (`SUPABASE_SERVICE_ROLE_KEY`) bypasses Row Level Security and must NEVER be exposed to the browser. It is only imported by `src/lib/supabase/admin.ts` and only used in Server Actions, Route Handlers, and Edge Functions.

---

## Project structure

```
src/
├── app/
│   ├── (marketing)/       Public marketing pages
│   ├── (patient)/portal/  Patient portal (DRM-ID + PIN auth)
│   ├── (staff)/staff/     Staff portal (Supabase Auth)
│   └── api/               Route handlers (cron, webhooks)
├── components/
│   ├── ui/                shadcn/ui primitives
│   ├── marketing/         Marketing-only components
│   ├── patient/           Patient portal components
│   ├── staff/             Staff portal components
│   └── shared/            Cross-surface components
├── lib/
│   ├── supabase/          Browser, server, and admin clients
│   ├── auth/              Patient session JWT helpers
│   ├── audit/             Audit logging helpers
│   ├── utils/             General utilities
│   └── validations/       zod schemas
└── types/
    └── database.ts        Generated from Supabase schema

supabase/
├── migrations/            SQL migrations (versioned)
└── functions/             Edge functions
```

---

## Authentication

Two completely separate auth flows. **Do not conflate them.**

### Staff (Supabase Auth)

Email + password (+ optional TOTP MFA). Sessions managed by Supabase. After sign-in, middleware verifies the user has an active `staff_profiles` row.

### Patients (custom — NOT Supabase Auth)

Patients authenticate with their **DRM-ID** (e.g. `DRM-0001`) plus the **Secure PIN** printed on their receipt. The PIN is a server-generated 8-character random string, hashed with bcrypt, scoped to a visit, and expires after 60 days.

Patients do not have Supabase Auth accounts. Their sessions are short-lived signed JWTs stored in HttpOnly cookies. RLS policies for patient queries use a Postgres setting (`app.current_patient_id`) set by the server before each query.

---

## Operational workflow

```
Patient walks in
  → Reception creates patient + visit (issues DRM-ID + receipt PIN)
  → Reception requests test(s)               [status: requested]
  → Medtech claims and processes test        [status: in_progress]
  → Medtech uploads PDF result               [status: result_uploaded]
  → (Optional) Pathologist signs off         [status: ready_for_release]
  → Patient pays at reception                [visit.payment_status: paid]
  → Reception releases result                [status: released]
  → Patient gets SMS + email notification
  → Patient signs into portal, downloads PDF
```

The release step is **gated by payment at the database level** (Postgres trigger). The UI also enforces this, but the trigger is the source of truth.

---

## Available scripts

| Command | Description |
|---|---|
| `npm run dev` | Start dev server with Turbopack |
| `npm run build` | Production build |
| `npm run start` | Start production server (after build) |
| `npm run lint` | Run ESLint |
| `npm run typecheck` | TypeScript check, no emit |
| `npm run db:types` | Regenerate `src/types/database.ts` from linked Supabase project |
| `npm run db:diff` | Generate a new migration from local schema changes |
| `npm run db:reset` | Reset local Supabase to migrations (destroys local data) |

---

## Implementation plan

The full phased build plan lives in [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md). When working with Claude Code, instruct it to read the plan and execute one phase at a time, stopping at each phase's verification checklist.

---

## Compliance notes (RA 10173)

- All access to patient data is logged in the `audit_log` table
- Patient PINs are bcrypt-hashed and never logged in plain form
- Lab result PDFs are stored in a private Supabase Storage bucket; downloads always go through 5-minute signed URLs created server-side
- A Privacy Notice is published at `/privacy`
- Data Protection Officer contact info is in the footer and on the Privacy Notice page
- Breach notification runbook lives in `docs/runbooks/breach.md` (to be created in Phase 8)

---

## Deployment

The `main` branch auto-deploys to production on Vercel. Pull requests get preview deployments. Database migrations must be applied to the linked Supabase project separately:

```bash
supabase db push
```

For schema changes, follow this order:
1. Create migration locally (`supabase db diff -f <name>`)
2. Test against a local Supabase instance (`supabase start`)
3. Open PR — preview deployment will fail if migrations haven't been pushed
4. Apply to staging Supabase, verify, then production

---

## License

Proprietary. All rights reserved.

---

## Contact

For technical issues: see the issue tracker.
For lab operations: contact reception at drmed.ph.
For data privacy concerns: see `/privacy` for the Data Protection Officer's contact details.
