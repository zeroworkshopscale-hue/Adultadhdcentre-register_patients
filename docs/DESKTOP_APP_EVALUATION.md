# Desktop App Evaluation — Local Windows Packaging

**Question:** Should this become a local Windows desktop application so patient
emails, OSCAR credentials, and PHI never leave the staff computer?

**Verdict:** **Yes — and the privacy goals are already architecturally met when
the app runs locally.** The work is *packaging*, not re-architecting: wrap the
existing React frontend + Node/Playwright backend into one double-clickable
Windows app so staff don't run two terminals. **Recommended framework: Electron.**

---

## 1. Privacy reality check (where data actually goes today)

I audited the network surface:

- The frontend makes **no external calls** — the only `fetch`/`EventSource` is to
  the configurable local backend (`VITE_OSCAR_SERVICE_URL`, default
  `http://localhost:8787`). No analytics, telemetry, Sentry, or third-party URLs.
- The Lovable error-reporting hook (`src/lib/lovable-error-reporting.ts`) calls a
  `window.__lovableEvents` global that **only exists inside the Lovable editor/
  preview** — it is a no-op in a self-hosted/desktop build. (We will strip it
  anyway for cleanliness — see plan.)
- Email parsing and extraction already run **client-side** (`extract.ts`,
  `@kenjiuno/msgreader`). No upload.
- OSCAR automation runs in the **backend Node process** via Playwright.

So when both processes run on the staff PC:

| Goal | Status when run locally |
|---|---|
| 1. Runs on a staff computer | ✅ |
| 2. Outlook emails processed locally | ✅ (client-side .msg parsing) |
| 3. Email extraction local | ✅ |
| 4. OSCAR automation local | ✅ (Playwright/Chromium on the machine) |
| 5. PHI never leaves the machine | ✅ **except the one legitimate destination — OSCAR itself** (see note) |
| 6. No cloud database | ✅ (there is no database; state is in-memory) |
| 7. No external API calls | ✅ (only localhost + OSCAR) |
| 8. No paid hosting | ✅ |
| 9. Zero ongoing cost | ✅ |

> **The one unavoidable connection:** the app must talk to **OSCAR** over the
> network, because OSCAR/KAI is hosted (e.g. `welcome.kai-oscar.com`). That is
> not a third-party leak — it is the clinic's own EMR and the authorized system
> of record for this data. Everything else is `localhost`. There is **no cloud
> DB, no telemetry, no third-party server** in the data path. Packaging as a
> desktop app makes this guarantee explicit and removes the cloud-hosting option
> entirely.

**Conclusion:** converting to desktop does not *add* privacy we don't already
have locally — it *enforces* it (no cloud deploy possible) and removes operational
friction. It is the right call.

---

## 2. Framework comparison

The decisive factor is the backend: **Node + Playwright + Chromium**. The chosen
shell must run that with the least friction.

| Option | Runs our Node+Playwright backend? | Bundle size | Toolchain | Maintenance | Fit |
|---|---|---|---|---|---|
| **Electron** ✅ recommended | **Yes, natively** — main process *is* Node; the existing Express/Playwright code runs unchanged | Large (~120 MB Electron + ~150 MB Playwright Chromium) | Node only (already have it) | Low — huge ecosystem, `electron-builder` makes a Windows installer | **Best** |
| **Tauri v2** | Not natively — Rust core. Would need Node shipped as a **sidecar** + Playwright Chromium anyway | Small *core* (~5 MB) but **+Node +Chromium sidecar erases the advantage** | **Adds Rust + cargo + WebView2** | Higher — second toolchain, sidecar packaging, Rust glue | Poor for this stack |
| Serve + system browser (no shell) | Yes — just run the server, open the default browser to localhost | Smallest (no Electron) | Node only | Lowest, but **least "app-like"** (stray browser tab, depends on user's browser) | Viable fallback |
| NW.js | Yes (like Electron) | Large | Node | Declining ecosystem vs Electron | Worse Electron |
| Wails (Go) / Neutralino | No (Go/none) — same rewrite/sidecar problem as Tauri | Small | Adds Go/none | Higher | Poor for this stack |

### Why **not** Tauri here (despite its reputation for being lighter)
Tauri is excellent when the backend is Rust or there's no heavy Node backend. Our
backend is a proven Node Playwright port. With Tauri we'd either **rewrite the
OSCAR automation in Rust** (throwing away the validated port) or **ship Node as a
sidecar** — at which point we're bundling Node *and* Chromium anyway, so Tauri's
small-binary benefit is gone, and we've *added* a Rust toolchain + WebView2
runtime dependency. That is **more** maintenance, not less.

### Why **Electron** wins on simplicity for *this* project
- The Electron main process is Node, so the **entire existing `server/`
  (Express + Playwright + session/job/SSE) runs as-is** — zero rewrite.
- The **React frontend loads in the renderer** with essentially no change.
- One `electron-builder` config produces a single Windows `.exe` installer.
- Fully offline, no cloud, **zero ongoing cost** (see §5).

The honest tradeoff is **disk size** (~250–400 MB installed). For a single
internal clinic tool, that is a non-issue versus the simplicity gained.

---

## 3. Target architecture (desktop mode)

```
┌─────────────────────────── Electron app (one .exe) ───────────────────────────┐
│                                                                                │
│  Main process (Node)                         Renderer (Chromium window)        │
│  ├─ starts the OSCAR server in-process        └─ the existing React UI,        │
│  │   (Express + Playwright + SSE)                loaded from http://127.0.0.1  │
│  ├─ owns Playwright → drives a SECOND,                                          │
│  │   bundled Chromium for OSCAR automation                                     │
│  └─ serves the built frontend as static files                                  │
│                                                                                │
└────────────────────────────────────────────────────────────────────────────────┘
                                   │ (only outbound connection)
                                   ▼
                               OSCAR / KAI  (the clinic EMR)
```

- **Same-origin:** the Express server also serves the built UI, so the window
  loads `http://127.0.0.1:<port>` and UI+API share an origin → **CORS disappears**.
- **Two Chromiums, by design:** Electron's render Chromium shows the UI;
  Playwright's bundled Chromium does OSCAR automation (headless). This is normal
  and expected.
- **No HTTP leaves the machine** except the Playwright→OSCAR session.

---

## 4. Implementation plan (phased)

> Scope guard: **no patient creation** in this work. Local execution + packaging
> only. Login + search are unchanged.

### Phase 0 — Decisions to confirm (small)
- Keep the **localhost HTTP/SSE** layer (lowest change) vs. collapse to Electron
  IPC (more native, more rewrite). **Recommend: keep HTTP on `127.0.0.1`** — it
  never leaves the machine and needs no frontend rewrite.
- Frontend build: the app is effectively a **single client-rendered route**, so
  build it as a **static SPA** and let Express serve it. (Alternative: keep
  TanStack Start SSR via Nitro's `node-server` preset. SPA is simpler.)

### Phase 1 — Make the backend embeddable
- Refactor `server/src/index.ts` to export `startServer({ port })` instead of
  auto-listening on import, so Electron can start it and pick a free port.
- Add `express.static(<built-frontend-dir>)` + an SPA fallback route.
- Default to `127.0.0.1` binding (not `0.0.0.0`), headless, bundled Chromium.
- Drop CORS (same-origin now). Session-id stays in memory as today.

### Phase 2 — Frontend for local serving
- Switch the production build target from Cloudflare to **static/SPA** output
  (Vite build; adjust the Nitro/Lovable preset accordingly).
- Set the API base to a relative path (same-origin) for the desktop build.
- **Privacy hardening:** strip the Lovable error-reporting hook and the dev-only
  `componentTagger` from the production bundle; add a strict CSP allowing only
  `self` + the OSCAR origin.

### Phase 3 — Electron shell
- Add an `electron/` folder: `main.ts` (start server → create `BrowserWindow` →
  load `http://127.0.0.1:<port>`), minimal `preload.ts`, app icon.
- Harden: `contextIsolation: true`, `nodeIntegration: false`, block new-window /
  external navigation except the OSCAR origin.
- Dev script: run Vite + server + Electron together; prod: load the built UI.

### Phase 4 — Bundle Playwright's Chromium (the one real packaging task)
- Include Playwright's Chromium via `electron-builder` `extraResources`, and set
  `PLAYWRIGHT_BROWSERS_PATH` to the packaged location at runtime so automation
  works on a machine **without** a separate `playwright install`.
- Fallback option: `BROWSER_CHANNEL=chrome` to use the staff PC's existing Google
  Chrome and skip bundling Chromium (smaller app, but assumes Chrome is present).

### Phase 5 — Package the installer
- `electron-builder` → **NSIS `.exe`** (per-user install, no admin needed).
- **Unsigned** to keep **zero ongoing cost** (a code-signing cert is a yearly
  paid item). Windows SmartScreen shows a one-time "unknown publisher" prompt on
  first launch; for internal use, IT can allow-list it. (Signing can be added
  later if desired — it does not change the architecture.)

### Phase 6 — Validate
- Re-run the existing OSCAR validations (login, search, batch) inside the desktop
  app. Confirm: no terminals needed, works offline except the OSCAR connection,
  emails/PHI stay local.

**Rough effort:** ~1–2 focused days. Phase 4 (Chromium bundling) is the only part
with real fiddliness; everything else is config + a thin Electron shell.

---

## 5. Zero-cost confirmation
- All tools are free/OSS: Electron, electron-builder, Node, Playwright, Chromium.
- No hosting, no cloud DB, no SaaS, no per-seat fees.
- The **only** optional paid item is a code-signing certificate — which we are
  **skipping** to honor the zero-ongoing-cost goal.

## 6. Risks & open items
- **Chromium bundling** (Phase 4) — the main packaging risk; mitigated by the
  system-Chrome fallback.
- **App size** (~250–400 MB) — acceptable for an internal tool.
- **SmartScreen warning** on unsigned first run — one-time, IT-allowlistable.
- **OSCAR MFA** — unchanged concern from validation; if enforced, automated login
  needs design work regardless of desktop vs web.
- **Auto-update** — not included (zero-cost, internal). Updates = reinstall the
  `.exe`. A free GitHub-releases updater can be added later if wanted.

## 7. What stays the same
- The OSCAR client, session manager, job queue, SSE, and batch logic are
  **reused unchanged**. The React UI is reused unchanged.
- This is additive packaging — it does not redesign the app or touch patient
  creation.
