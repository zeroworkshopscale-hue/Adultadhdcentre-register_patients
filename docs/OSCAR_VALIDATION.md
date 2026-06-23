# OSCAR Validation Guide

Goal: prove the current implementation (login + search by email) works against
the **real OSCAR environment**. No new features; patient creation is out of scope.

---

## 1. What I need from you

Provide these so the system can be configured and tested. **Use a test/training
OSCAR account if one exists** — validation only reads patient data (search +
view chart); it never writes.

### Required configuration values

| Value | Example | Notes |
|---|---|---|
| **OSCAR login URL** | `https://welcome.kai-oscar.com/kaiemr/` | The exact page where you normally log in (the Angular SPA entry). This is the "OSCAR URL" entered in the Connect panel. |
| **OSCAR server origin** | `https://welcome.kai-oscar.com` | Usually the scheme+host of the login URL. The classic `/oscar/...` pages must be reachable here after login. Confirm it matches. |
| **Username** | `jsmith` | Your own OSCAR username (entered at runtime, never stored). |
| **Password** | — | Entered at runtime in the Connect panel; never stored or logged. |
| **MFA / 2FA requirement** | "none" / "PIN" / "SMS code" / "TOTP app" | **Critical.** Username+password (+ a simple PIN field) is supported. SMS/TOTP is **not yet** supported and would block automated login — tell me if it's enforced. |
| **Test patient email** | `testpatient@example.com` | An email that exists on a chart in OSCAR, so search returns a known patient. Ideally a dummy/training patient. |
| **Expected demographic #** | `123456` | The demographic number you expect that email to resolve to, so we can confirm correctness. |
| **A second email that is NOT in OSCAR** | `nobody-xyz@example.com` | To validate the "Patient Not Found" path. |

### Questions to answer

1. Is MFA enforced on logins? If yes, which type?
2. After logging in normally, can you open this URL in the same browser and see a
   patient search/edit page (not a login redirect)?
   `https://<your-oscar-origin>/oscar/demographic/demographiccontrol.jsp?search_mode=search_email&keyword=test@example.com&dboperation=search_titlename&limit1=0&limit2=25&displaymode=Search&ptstatus=active`
   (This confirms the classic endpoints + email search mode are enabled on your instance.)
3. Is automated/scripted access permitted by your OSCAR host's terms?
4. What is the session idle-timeout length on your instance (minutes)?

---

## 2. How to run it (one command)

From `adhd-assist-main/`:

- **Windows (PowerShell):** `powershell -ExecutionPolicy Bypass -File .\dev.ps1`
- **Git Bash / macOS / Linux:** `bash dev.sh`

First run installs dependencies and downloads Chromium, then starts:
- Backend → http://localhost:8787 (health check: `curl http://localhost:8787/health`)
- Frontend → the URL printed by Vite (open it in your browser)

> **If login behaves differently than your normal browser**, match the proven
> Python setup: edit `server/.env` and set `PLAYWRIGHT_HEADLESS=false` (watch the
> automation) and/or `BROWSER_CHANNEL=chrome` (use system Google Chrome). The
> Python implementation runs headful with system Chrome; some EMR logins differ
> under headless Chromium.

---

## 3. Pre-flight checklist

- [ ] Node 18+ installed (`node --version`).
- [ ] `bash dev.sh` / `dev.ps1` completes install and both processes start.
- [ ] `curl http://localhost:8787/health` returns `{"ok":true}`.
- [ ] Frontend loads in the browser; the **Connect to OSCAR** panel is visible.
- [ ] You have: OSCAR login URL, username, password, a test patient email, the
      expected demographic number, and a known-absent email.
- [ ] MFA status confirmed (and is none/PIN, or we have a plan for it).
- [ ] You can reach the classic search URL (Question 2 above) in your own browser.

---

## 4. Step-by-step validation plan

Run these in order. For each, the **Expected** column is what success looks like;
note the **Where to look** for evidence.

**Coverage map (your confirm list → validation below):**

| You want to confirm | Proven by |
|---|---|
| OSCAR login works | Validation 1 |
| Existing patient search by email works | Validation 2 |
| Demographic number retrieval works | Validation 3 |
| ADHD Daily Dashboard populates correctly | Validation 3 + 4 |
| Scheduling Queue populates correctly | Validation 4 |
| Batch processing works with multiple emails | Validation 6 |

**Expected dashboard contents on a successful match:**

- **ADHD Daily Sheet** row: Email Date · Payment ID · Initials · **Demographic #**
  (from OSCAR) · Therapist-Supported (if the subject says so) · Province (from the
  OSCAR chart) · Status = `Found`.
- **Scheduling Queue** row: First Name · Email Address · Province — name/email/
  province reflect the **OSCAR chart** values on a match.
- Not-found / multiple / no-email rows appear in both tables, highlighted, with a
  blank Demographic # and a Status of `Not Found` / `Manual Review Required`.

### Validation 1 — Successful OSCAR login
1. In the Connect panel enter the OSCAR URL, username, password → **Connect**.
2. **Expected:** panel switches to "● Connected as &lt;username&gt;".
3. **Where to look:** backend window logs `OSCAR login successful — current URL: …`.
4. **If it fails:** "OSCAR login failed" → check URL/credentials; or "Could not
   reach or drive OSCAR" → URL wrong/unreachable. Set `PLAYWRIGHT_HEADLESS=false`
   to watch where it stops. If it stops at an MFA prompt, that's the MFA blocker.

### Validation 2 — Search by email
1. Create a plain-text file containing at minimum a line with the test patient's
   email (e.g. `Email: testpatient@example.com`), or a real intake `.msg`/`.eml`.
2. Drop it on the drop zone (or click to browse).
3. **Expected:** Processing Status shows `Email Imported → Patient Data Extracted
   → Searching OSCAR → Patient Found (#NNN)`.
4. **Where to look:** backend logs `OSCAR search complete { mode: 'search_email',
   candidates: 1 }`.

### Validation 3 — Retrieve demographic number
1. After Validation 2, look at the **ADHD Daily Sheet** table.
2. **Expected:** the **Demographic #** column shows `NNN`, matching the expected
   number you provided.
3. **Pass criteria:** number is present and correct (not blank, not random).

### Validation 4 — Retrieve patient details
1. Inspect the row's other columns and the Scheduling Queue row.
2. **Expected:** First Name, Email Address, and Province reflect the **OSCAR
   chart** values (OSCAR is treated as the source of truth on a match).
3. **Where to look:** backend reads the chart via
   `demographiccontrol.jsp?...displaymode=edit&dboperation=search_detail`.
4. **Note:** name/email/province/sex/DOB use confirmed OSCAR field names; the
   `phone` field name is unverified (see §5) — verify it displays correctly, and
   if blank/wrong we'll correct the field name.

### Validation 5 — Return results to dashboard
1. Confirm the row persists in both tables and **Copy Row** / **Copy All** copy
   tab-delimited values.
2. Drop the known-absent email → **Expected:** `Patient Not Found in OSCAR`, row
   flagged, Demographic # blank.
3. Drop a second valid email → **Expected:** a second correct row; both retained
   for the session.
4. **Pass criteria:** found/not-found are driven entirely by real OSCAR results
   (no random outcomes, no fake demographic numbers).

### Validation 6 — Batch processing
1. Select **multiple** intake emails (try 5, then 10–20) and drag them in at once.
2. **Expected:** a queue forms; rows appear in **both dashboards progressively**
   as each finishes — you do not wait for the whole batch.
3. **Batch Status panel** shows live counters, e.g.
   `Total Emails: 12 · Processed: 8 · Successful: 7 · Manual Review: 1 · Failed: 0`.
4. **One login only:** you connected once; the backend window should show a single
   login and then repeated searches (no re-login per email).
5. **Resilience:** include one bad/garbled file — **Expected:** it becomes a
   Failed/Manual Review row and the rest of the batch still completes.
6. **Where to look:** backend logs show searches running **one at a time** for the
   session (serialised), confirming OSCAR is not hit concurrently.

### Sign-off
- [ ] V1 login · [ ] V2 search · [ ] V3 demographic # · [ ] V4 details · [ ] V5 dashboard
- [ ] V6 batch (progressive rows, live counters, one login, continue-on-failure)
- [ ] "Not found" path correct · [ ] No fake/random data anywhere

---

## 5. Python ↔ Node parity verification (Task 5)

The Node client (`server/src/oscar/client.ts`, `selectors.ts`) was ported from
the **proven** Python client
(`../../adhd-intake-automation/adhd_intake/oscar/client.py`). For the
validation-relevant paths (login, email search, demographic detail) the
selectors, URLs, and workflow are an **exact match**:

| Item | Python | Node | Match |
|---|---|---|---|
| Server origin | `scheme://host` of base_url | `new URL(oscarUrl).origin` | ✅ |
| Classic prefix | `/oscar` | `/oscar` | ✅ |
| Login: username selector | `input[name='username'], input[name='userName'], input[type='text']:not(...), input[placeholder*='sername' i], input[placeholder*='user' i]` | identical | ✅ |
| Login: password selector | `input[type='password']` | identical | ✅ |
| Login: PIN selector | `input[name='pin'], input[placeholder*='pin' i], …` | identical | ✅ |
| Login: submit selector | `button[type='submit'], input[type='submit'], button:has-text('Sign'/'Log'/'Login'/'Enter')` | identical | ✅ |
| Login: success marker | `nav, [class*='nav-'], …, text=Schedule, text=Patient Search, text=Inbox` | identical | ✅ |
| Login: flow | goto → networkidle → fill user → fill pass → optional PIN → click submit → networkidle → wait success marker (15s) | identical | ✅ |
| Search URL | `…/demographic/demographiccontrol.jsp?search_mode=<mode>&keyword=<kw>&dboperation=search_titlename&limit1=0&limit2=25&displaymode=Search&ptstatus=active` | identical | ✅ |
| Email search mode | `search_email` | `search_email` | ✅ |
| Result link selector | `a[onclick*='demographic_no']` | identical | ✅ |
| Demographic-no parse | `demographic_?no=(\d+)` (i) | identical | ✅ |
| Chart detail URL | `…/demographic/demographiccontrol.jsp?demographic_no=X&displaymode=edit&dboperation=search_detail` | identical | ✅ |
| Detail wait selector | `input[name='last_name']` (attached) | identical | ✅ |
| Detail field names | `last_name, first_name, year/month/date_of_birth, full_birth_date, email, province, sex` | identical subset | ✅ |
| Default timeout | 30000 ms; success marker 15000 ms | identical | ✅ |

### Intentional differences (by design, not defects)
- **Email-only search.** Python escalates through name → partial → DOB → email
  tiers; the Node service performs **email search only**, as required for this
  workflow. The email tier itself is identical.
- **Ambiguity handling.** When an email matches **>1** chart, Node returns
  `multiple` → Manual Review (it never auto-picks). Python's email tier tries a
  name/DOB confidence check. The safer Node behavior is deliberate.
- **Chart fields read.** Node reads a subset (the fields the dashboard needs).
  All read field names match Python's confirmed set **except `phone`**, which
  Python never read — so the `phone` field name is **unverified** and is the one
  thing to confirm in Validation 4.
- **Browser defaults.** Node defaults to headless + bundled Chromium; the proven
  Python run was headful + system Chrome. If login differs, set
  `PLAYWRIGHT_HEADLESS=false` / `BROWSER_CHANNEL=chrome` to match exactly.
- **Downloads.** Node context uses `acceptDownloads:false` (search needs no
  downloads); Python enabled it for document upload, which is out of scope here.

**Conclusion:** the login and email-search paths are faithful ports of the
confirmed Python implementation. The only field to re-confirm against live OSCAR
is the `phone` field name; everything else is already validated selectors.

---

## 6. Known blockers to watch for
- **MFA/2FA** enforced → automated login stops at the code prompt. Needs design
  work; tell me before testing.
- **Headless detection** → rare, but if the login page behaves oddly, switch to
  `BROWSER_CHANNEL=chrome` + `PLAYWRIGHT_HEADLESS=false`.
- **Classic endpoints disabled** → if Question 2's URL redirects to login even
  while logged in, this instance may not expose `/oscar/*.jsp` and we'll need to
  capture the actual search request from your browser's DevTools.
