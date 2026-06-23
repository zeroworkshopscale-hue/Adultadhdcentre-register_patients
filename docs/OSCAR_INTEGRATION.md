# OSCAR Integration — Architecture & Operations

This document explains how the ADHD Intake Dashboard connects to **OSCAR EMR**
using browser automation, how to run it end-to-end, and what work remains.

## Decisions (finalized)

1. Integration is via the **OSCAR website** (browser automation) — no OSCAR APIs,
   no direct database access.
2. **Credentials are never stored.** Each user enters their own OSCAR URL,
   username, and password to start a session.
3. **Free / open-source only** — Node, Express, Playwright, Chromium.
4. Final hosting under **parharsaacportal.ca**.

## Two-process design

| Process | Tech | Runs on | Responsibility |
|---|---|---|---|
| **Frontend** | React 19 + TanStack Start (Lovable) | Cloudflare-style edge / static | The existing dashboard UI. Extracts email data client-side; calls the backend for OSCAR work. |
| **Backend** | Node + Express + **Playwright** | A Chromium-capable Node host (VM/container or local agent) | Logs into OSCAR, searches by email, streams results. See [`../server/README.md`](../server/README.md). |

**Why two processes:** the Lovable build targets Cloudflare (serverless edge),
which cannot launch Chromium. Playwright needs a long-running Node process, so
OSCAR automation lives in `server/` and the browser talks to it over HTTP/SSE.

```
[ React dashboard ] ──HTTP──▶ [ server/ Express+Playwright ] ──web UI──▶ [ OSCAR/KAI ]
        ▲   └──────────────── SSE (live status) ───────────────┘
        └ existing UI, unchanged; fake pipeline replaced by real calls
```

## End-to-end flow

1. **Connect.** Operator enters OSCAR URL + username + password in the Connect
   panel → `POST /api/oscar/login`. The backend launches an isolated Chromium
   context, logs into OSCAR, verifies success, and returns an opaque
   `sessionId`. The password is discarded; only the live OSCAR session (cookie)
   is kept in memory.
2. **Drop an email.** The existing drop zone parses the `.msg`/`.eml`/`.txt`
   client-side (`src/lib/extract.ts`) to get the patient email.
3. **Search.** `POST /api/intake { email }` → a job is queued →
   `GET /api/intake/:jobId/events` (SSE) streams progress onto the Processing
   Status panel:
   `Email Imported → Patient Data Extracted → Searching OSCAR →
    Patient Found (#NNN) | Patient Not Found | Manual Review → Added To Dashboards`.
4. **Populate.** On `found`, the demographic number and chart details (email,
   province, name) fill the **Daily Sheet** and **Scheduling Queue** rows.
   On `not_found` / multiple matches, the row is flagged for manual handling.

## What changed in the frontend

- `src/lib/oscarService.ts` (new) — the only module that talks to the backend
  (`login`, `logout`, `submitIntake`, `streamIntake`).
- `src/routes/index.tsx` — **removed all fake logic** (`fakeDemo()`, random
  found/created outcomes, `setTimeout` delays, simulated steps). Added a minimal
  Connect panel and a **batch queue** (see below) wired to real OSCAR search via
  SSE. The dashboard layout/components are otherwise unchanged.
- `src/styles.css` — registered the `success`/`warning` color tokens in
  `@theme inline` (they were defined but never mapped to utilities).

No new pages, no redesign.

## Batch processing

Staff can drag in many emails at once (5, 10, 20+). The behavior:

- Dropping files creates a **processing queue**; each email is an independent
  item. A concurrency-limited pool (`CONCURRENCY = 3` in `index.tsx`) drives it.
- **Results appear progressively** — each row is added to both dashboards the
  moment its email finishes, not after the whole batch.
- **One failure never stops the batch.** Per-item errors (unreadable file, OSCAR
  error) resolve as a `Failed`/`Manual Review` row and the pool continues.
- The **Batch Status** panel shows live counters: Total / Processed / Successful
  / Manual Review / Failed, a progress bar, and a per-email queue list.
- **One OSCAR login is reused for the whole batch.** The frontend submits every
  email under the same `sessionId`; the backend's `runExclusive` serialises them
  onto that one authenticated session — **at most one OSCAR search runs at a
  time**, so OSCAR is never overwhelmed regardless of batch size. The frontend
  pool limit (3) only bounds open SSE connections / pipelines file reads.

Outcome → counter mapping: `found` = Successful; `error` = Failed; everything
else needing a human (`not_found`, multiple matches, no email in the message) =
Manual Review.

## Run locally (full stack)

```bash
# 1) Backend
cd server
npm install
npm run install:browser        # one-time Chromium download
npm run dev                    # http://localhost:8787

# 2) Frontend (repo root, separate terminal)
cp .env.example .env           # sets VITE_OSCAR_SERVICE_URL=http://localhost:8787
bun install                    # or: npm install
bun run dev                    # open the printed URL
```

Then: Connect to OSCAR → drop an intake email → watch the search run live.

## Required environment variables

- **Frontend** (root `.env`): `VITE_OSCAR_SERVICE_URL` (required),
  `VITE_OSCAR_DEFAULT_URL` (optional prefill). See root `.env.example`.
- **Backend** (`server/.env`): `PORT`, `CORS_ORIGINS`, `PLAYWRIGHT_HEADLESS`,
  `BROWSER_CHANNEL`, `SESSION_IDLE_MINUTES`, `OSCAR_TIMEOUT_MS`. See
  `server/.env.example`.

## Deployment requirements

- Host the **backend on a Chromium-capable Node host** (not Cloudflare/Vercel
  edge). Options:
  - **Local agent** (recommended for PHI): the backend runs on the clinic PC;
    OSCAR credentials and patient data never leave the machine. Cleanly avoids
    PIPEDA/data-residency review.
  - **Cloud worker**: a Canadian-region VM/container; requires a privacy review
    because OSCAR credentials and PHI transit/live (in memory) on that host.
- Put both behind `parharsaacportal.ca` via a reverse proxy (e.g. `/api/*` →
  backend). Set `CORS_ORIGINS=https://parharsaacportal.ca`. Disable proxy
  buffering on the SSE route.
- TLS everywhere (credentials are POSTed to the backend).

## Remaining work items

**Backend / automation**
- [ ] **Patient creation** (Priority for next phase) — drive the OSCAR
      add-demographic form, read back the new demographic number; gate on
      required-field completeness; duplicate guard (name + DOB) before creating.
- [ ] **Session re-login** on OSCAR timeout (emit `REAUTH_REQUIRED` or
      auto-relogin) instead of erroring the next search.
- [ ] **MFA/2FA** handling if the OSCAR instance enforces it.
- [ ] Move job queue + session store to Redis/BullMQ if running multiple
      backend instances.
- [ ] Harden session auth (httpOnly cookie + portal auth in front of the worker).

**Validation against the live instance**
- [ ] Confirm the **patient-creation** form selectors on a test OSCAR account
      (search + login selectors are already confirmed via the Python project).

## Information still needed from the Adult ADHD Centre team

1. A **non-production OSCAR account + test patient** to build/validate patient
   creation without touching real PHI.
2. OSCAR's **required fields & validation rules** for creating a demographic
   (mandatory fields, health-card requirement, provider/roster, default program).
3. Whether **MFA/2FA** is enforced on OSCAR logins.
4. Confirmed **OSCAR base URL** and the **session timeout** length.
5. Confirmation that **automated web access is permitted** by KAI's terms.
6. Hosting decision: **local agent vs Canadian cloud** (drives the PIPEDA path).
7. Expected **volume / concurrency** (emails/day, simultaneous users).
8. **Duplicate policy**: match on email only, or email + name/DOB.
