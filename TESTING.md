# TESTING — ADHD Intake Dashboard (local validation)

A complete, runnable local build for validating **email extraction, batch
processing, dashboard population, OSCAR login, and OSCAR patient search**.

> Not Electron, not a single `.exe` (deferred by request). This is the full app —
> React frontend + Node/Playwright backend — runnable locally with one command.
> Patient creation is intentionally not included.

---

## 0. Requirements

- **Windows 10/11** (developed/tested here) — macOS/Linux also work via `dev.sh`.
- **Node.js 18+** (tested on Node 24): check with `node --version`.
- Internet access to **your OSCAR instance** (the only outbound connection).
- ~400 MB free disk (Playwright downloads Chromium on first run).

No database, no cloud account, no paid services.

---

## 1. Required files

Everything is in the `adhd-assist-main/` folder:

| Path | What it is |
|---|---|
| `src/` | React frontend (the dashboard UI + extraction engine) |
| `server/` | Node + Express + Playwright OSCAR automation backend |
| `dev.ps1` / `dev.sh` | One-command launcher (installs deps, starts both) |
| `samples/` | Ready-to-use test email + instructions |
| `.env.example` | Frontend config template (auto-copied to `.env` on first run) |
| `docs/` | Architecture, OSCAR + extraction validation reports |

---

## 2. Installation & startup (one command)

From inside `adhd-assist-main/`:

**Windows (PowerShell):**
```powershell
powershell -ExecutionPolicy Bypass -File .\dev.ps1
```
**Git Bash / macOS / Linux:**
```bash
bash dev.sh
```

First run will: install backend deps → download Chromium → install frontend deps
→ create `.env` → start the **backend** (http://localhost:8787) and the
**frontend**. Open the frontend URL it prints (typically **http://localhost:8080**).

**Verify it started:**
- Backend: `curl http://localhost:8787/health` → `{"ok":true}`
- Frontend: the page loads with a **Connect to OSCAR** panel on the left.

(If you prefer two terminals: `cd server && npm install && npm run install:browser
&& npm run dev` in one, and `npm install && npm run dev` at the root in another.)

---

## 3. Connect to OSCAR

In the **Connect to OSCAR** panel (top-left), enter:
- **OSCAR URL** — your login page, e.g. `https://welcome.kai-oscar.com/kaiemr/`
- **OSCAR username** and **password** (your own; used once, never stored)

Click **Connect**. On success the panel shows **● Connected as &lt;username&gt;**.

- Credentials are sent to the local backend over the loopback only and are used
  to drive the OSCAR login form; they are never written to disk or logs.
- If login fails, set `PLAYWRIGHT_HEADLESS=false` in `server/.env` and restart to
  watch the automation (e.g. to see an MFA prompt). MFA/2FA is a known blocker —
  see Limitations.

---

## 4. Test email extraction (no OSCAR needed)

You can validate the parser **without** OSCAR using the harness:

```bash
cd server
node --import tsx extract-check.mts ../samples/sample-intake-email.txt
# or point it at a folder of your own anonymized emails:
#   drop .txt/.eml files into samples/real/  (git-ignored), then:
node --import tsx extract-check.mts
```

It prints every extracted field per email. Use it to confirm parsing on your real
formats before running the full pipeline.

---

## 5. Test with sample emails (full pipeline)

1. Connect to OSCAR (Section 3).
2. Open `samples/sample-intake-email.txt`. Edit the **`Email:`** line to a **test
   patient that exists in your OSCAR**, save.
3. Drag the file onto **Drop Emails Here** (or click to browse).
4. Watch the **Batch Status** panel step through:
   `Email Imported → Patient Data Extracted → Searching OSCAR →
    Patient Found (#NNN)` (or Not Found / Manual Review).

Test all paths by editing the `Email:` line (see `samples/README.md`):
- a **real** test-patient email → **Found** with a demographic number,
- a clearly-absent email → **Not Found**,
- delete the `Email:` line → **Manual Review** (no email),
- set DOB to an unsupported format (e.g. `14/22/1990`) → **Manual Review**.

---

## 6. Test batch processing

1. Duplicate `sample-intake-email.txt` several times (e.g. `email1.txt … email12.txt`),
   giving each a different `Email:` line (mix of real, absent, and bad-DOB).
2. Select them all and drag them in together.
3. Confirm:
   - Rows appear in **both dashboards progressively** (you don't wait for all),
   - the **Batch Status** counters update live, e.g.
     `Total Emails: 12 · Processed: 8 · Successful: 7 · Manual Review: 1 · Failed: 0`,
   - a bad/garbled file becomes a Failed/Manual Review row and the **rest still
     complete** (one failure never stops the batch),
   - you connected **once** — the backend log shows a single login then repeated
     searches (no re-login per email), run **one at a time** (OSCAR not flooded).

---

## 7. Verify dashboard results

**ADHD Daily Sheet** — one row per processed email:
Email Date · Payment ID · Initials · **Demographic #** (from OSCAR on a match) ·
Therapist-Supported · Province (from the OSCAR chart) · **Status**.

**Scheduling Queue** — First Name · Email · Province (chart values on a match).

- **Status** is one of: `Found`, `Not Found`, `Manual Review Required`, `Error`.
- Manual-review / not-found / error rows are highlighted with a blank Demographic #.
- **Copy Row** / **Copy All Rows** copy tab-delimited values to paste into Sheets.

---

## 8. Final extraction readiness assessment

**Is the extraction engine ready for real-world testing? — Yes.**
All four identified defects are fixed and validated against the test suite:
- **B1** clinic-email contamination → fixed (clinic/no-reply/role addresses never
  used; blank → Manual Review instead of guessing).
- **B2** DOB → fixed to your exact policy: only `YYYY-MM-DD` and `MM/DD/YYYY`
  (month-first) are accepted; anything else → Manual Review (never guessed).
- **B3** address eating adjacent fields + province suppression → fixed (address
  stops at field boundaries; province resolves independently of address).
- **B5** subject-line name bleed → fixed (names from the subject no longer append
  trailing words like "Private"/"Subject").

It reliably extracts all 10 fields from labelled emails and **conservatively flags
rather than guesses** on anything uncertain. Validate on your real anonymized
emails (Section 4) to confirm against your exact formats.

### Known limitations that remain
- **Subject-only names** are capped at three Title-Case words; unusual name
  layouts in a subject may still need review.
- **Province in free text** could match a clinic-signature province if the
  patient's is absent/unlabelled (a labelled `Province:` or the address wins).
- **One patient per email** is assumed; a digest listing several patients yields
  only the first.
- **HTML-origin Outlook `.msg`** emails are converted to text; labels/spacing may
  shift — validate with real `.msg` exports.
- **Phone** handles North-American formats; extensions are dropped, international
  formats may not normalise. (Phone is not used for OSCAR search.)
- **Gender** is an advisory hint (incomplete name list); not a required field.

### What still triggers Manual Review (status `Manual Review Required`)
1. **No patient email** confidently identified (clinic-only or none) → not searched.
2. **DOB present but not** `YYYY-MM-DD` or `MM/DD/YYYY` → not searched.
3. **OSCAR returns more than one** patient for the email → not auto-picked.

(Separately, an email with no OSCAR match shows **Not Found**, and a
technical/OSCAR error shows **Error** — these are distinct from Manual Review.)

---

## 9. Known limitations of the test build
- **OSCAR connection required** to exercise the full pipeline (login/search drive
  the dashboards). Extraction alone is testable offline via Section 4.
- **MFA/2FA:** automated login supports username/password (+ a simple PIN). If
  your instance enforces SMS/TOTP, automated login will stop at the code prompt.
- **In-memory only:** sessions, the job queue, and results live in memory and
  reset on restart/refresh (single-user local tool — by design).
- **Not packaged as `.exe`:** runs from source via `dev.ps1`/`dev.sh` (Electron
  packaging deferred by request).
- **Patient creation is not implemented** — unmatched patients show Not Found.

---

## 10. Troubleshooting
- **Port in use (8787/8080):** stop other instances (`taskkill /F /IM node.exe`)
  and rerun, or change `PORT` in `server/.env`.
- **Login won't complete:** set `PLAYWRIGHT_HEADLESS=false` (and/or
  `BROWSER_CHANNEL=chrome`) in `server/.env`, restart, and watch the browser.
- **Frontend can't reach backend:** confirm the backend is up
  (`curl http://localhost:8787/health`) and that root `.env` has
  `VITE_OSCAR_SERVICE_URL=http://localhost:8787`.
- **Chromium missing:** `cd server && npm run install:browser`.
