# OSCAR Automation Service

Browser-automation backend for the ADHD Intake Dashboard. It drives the **OSCAR
EMR web interface** with [Playwright](https://playwright.dev) to:

1. Log a user into OSCAR with their own credentials.
2. Search OSCAR for a patient **by email address**.
3. Return the demographic number + chart details (or "not found") to the
   frontend, streamed live over Server-Sent Events (SSE).

It uses **no OSCAR APIs and no direct database access** — only the website, as
decided for this project. It is **100% free / open-source** (Node, Express,
Playwright, Chromium).

> **Scope:** Patient _creation_ is intentionally **not** implemented yet. An
> unmatched email returns `not_found`. See [Remaining work](#remaining-work).

---

## Why this is a separate service

The frontend (Lovable / TanStack Start) builds for **Cloudflare**, a serverless
edge runtime that **cannot launch Chromium**. Playwright needs a long-running
Node process with a real browser binary, so the automation must run here, as its
own process, and the frontend talks to it over HTTP/SSE.

---

## Architecture

```
Browser (React app)
   │  POST /api/oscar/login        { oscarUrl, username, password } -> { sessionId }
   │  POST /api/intake             { email }  (X-Session-Id header) -> { jobId }
   │  GET  /api/intake/:id/events  (SSE)      <- live JobEvents
   ▼
Express (this service)
   ├─ routes/          HTTP + SSE endpoints, request validation (zod)
   ├─ session/         one isolated Playwright BrowserContext per logged-in user
   │                   · per-session action serialisation (one nav at a time)
   │                   · idle eviction (the only implicit logout)
   ├─ jobs/            in-memory job queue; emits JobEvents over SSE
   └─ oscar/           Playwright client: login + search by email
                       (ported from the proven Python implementation)
   ▼
OSCAR / KAI  (Angular SPA login -> classic /oscar/*.jsp endpoints)
```

### Key design points

| Concern | Decision |
|---|---|
| **Framework** | Playwright (auto-waiting, isolated contexts, bundled Chromium). |
| **Sessions** | One `BrowserContext` per user, keyed by an opaque `sessionId`. Login once; the OSCAR cookie is reused for every search. |
| **Credentials** | Used to drive the login form, then **discarded**. Never written to disk, DB, env, or logs (`logger.ts` redacts `pass|pwd|secret|token`). The live browser context is the only retained artifact. |
| **Frontend ↔ backend** | Job + SSE. The browser submits an email and subscribes to a one-way event stream that maps onto the existing Processing-Status panel. |
| **Concurrency** | Different users run in parallel (separate contexts); actions on the _same_ session are serialised. |

---

## Run locally

Prerequisites: **Node 18+** (tested on Node 24).

```bash
cd server
npm install
npm run install:browser      # one-time: downloads Chromium (~150 MB)
cp .env.example .env         # optional; sensible defaults work as-is
npm run dev                  # http://localhost:8787  (watch mode)
```

Check it's up:

```bash
curl http://localhost:8787/health      # -> {"ok":true}
```

Then start the frontend (repo root) and set `VITE_OSCAR_SERVICE_URL` to point at
this service — see the root `.env.example`.

### Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Start with auto-reload (tsx watch). |
| `npm start` | Start once (tsx). |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run install:browser` | Download Playwright's Chromium. |

---

## Environment variables

All optional; defaults shown. See [`.env.example`](.env.example).

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Listen port. |
| `CORS_ORIGINS` | _(empty)_ | Comma-separated allowed origins. Empty reflects any origin (**dev only** — set this in production, e.g. `https://parharsaacportal.ca`). |
| `PLAYWRIGHT_HEADLESS` | `true` | Run Chromium headless. Set `false` only to watch OSCAR pages while debugging. |
| `BROWSER_CHANNEL` | `chromium` | `chromium` (bundled) or `chrome` (system Google Chrome). |
| `SESSION_IDLE_MINUTES` | `20` | Close an OSCAR session after this much inactivity. |
| `OSCAR_TIMEOUT_MS` | `30000` | Navigation/selector timeout for OSCAR pages. |

---

## API

| Method & path | Body / params | Returns |
|---|---|---|
| `GET /health` | — | `{ ok: true }` |
| `POST /api/oscar/login` | `{ oscarUrl, username, password }` | `{ status, sessionId, username }` · `401` on bad credentials |
| `POST /api/oscar/logout` | `X-Session-Id` header | `204` |
| `GET /api/oscar/session` | `?sessionId=` | `{ authenticated, username }` |
| `POST /api/intake` | `{ email }` + `X-Session-Id` | `{ jobId }` |
| `GET /api/intake/:jobId/events` | `?sessionId=` | `text/event-stream` of `JobEvent`s |

`JobEvent.kind`: `email_received → searching → (patient_found │ patient_not_found
│ multiple_matches │ error) → done`. The final `done` event carries the
`JobResult` (`outcome`, `demographicNo`, `patient`).

---

## Deployment requirements

- A host that can **run Chromium** — a normal Node VM/container (Render, Fly.io,
  a clinic server, or a local agent on the clinic PC). **Not** Cloudflare/Vercel
  edge.
- Run behind TLS and a reverse proxy. Under `parharsaacportal.ca`, route e.g.
  `/api/*` to this service and serve the frontend separately.
- Set `CORS_ORIGINS` to the real frontend origin.
- SSE needs proxy buffering **off** (`X-Accel-Buffering: no` is already sent;
  for nginx also set `proxy_buffering off;` on the events location).
- System deps for Chromium: on Debian/Ubuntu run
  `npx playwright install-deps chromium`.
- Memory: ~150–300 MB per concurrent OSCAR session (one Chromium context each).

See [`../docs/OSCAR_INTEGRATION.md`](../docs/OSCAR_INTEGRATION.md) for the
local-agent vs cloud-worker hosting trade-off (PHI / PIPEDA).

---

## Remaining work

- **Patient creation** — drive the OSCAR add-demographic form and read back the
  new demographic number. Needs a test OSCAR account to map the form selectors
  (the search/login selectors are already confirmed).
- **MFA/2FA** — current login handles username/password (+ optional PIN). If the
  OSCAR instance enforces SMS/TOTP, unattended login needs a different flow.
- **Session re-login on expiry** — currently an expired OSCAR session surfaces as
  an error on the next search; auto re-login or a `REAUTH_REQUIRED` event is TODO.
- **Persistence/scale** — job queue and session map are in-memory (single
  instance). For multiple instances, move to Redis/BullMQ.
- **Auth hardening** — `sessionId` is a bearer token passed in a header/query.
  For production behind the portal, prefer an httpOnly cookie + the portal's own
  auth in front.
