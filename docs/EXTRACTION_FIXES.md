# Extraction Fixes B1–B3 — Before / After

Fixes applied to `src/lib/extract.ts` for the three HIGH-impact defects found in
[EXTRACTION_VALIDATION.md](EXTRACTION_VALIDATION.md). **No new features; dashboards
and OSCAR integration untouched.** All outputs below are real, from
`server/extract-check.mts`. Frontend `tsc --noEmit` passes.

---

## B1 — Clinic email never used as the patient email
**Change:** clinic / no-reply / role addresses (`adultadhd*`, `noreply`,
`intake@`, `referrals@`, `front.desk@`, …) are rejected for both the labelled and
the body-scan paths, and the old `?? firstEmail` guess was removed. If nothing
qualifies, **email stays blank → Manual Review** (per "do not guess").

| Case | Before | After |
|---|---|---|
| 4 — only `someone@adultadhdcentre.com` present | email = `someone@adultadhdcentre.com` ❌ | email = `` (blank); `missing` adds **Email** ✅ |
| 3 — clinic in `From:`, patient in signature | (was correct) | `maria.garcialopez@outlook.com` ✅ (clinic ignored) |

## B2 — DOB: two accepted formats only, everything else → Manual Review
**Policy (per Adult ADHD Centre):** intake emails use ONLY `YYYY-MM-DD` and
`MM/DD/YYYY`. `parseDob` accepts exactly those two and **never guesses**:
- `YYYY-MM-DD` (dash, year first) → year-month-day
- `MM/DD/YYYY` (slash, year last) → **month-first**
- anything else (DD/MM, 2-digit year, spelled month, slash-ISO, dash-MM/DD, …)
  → blank dob + `Date of Birth (ambiguous)` → **Manual Review**

| Input | Result | Note |
|---|---|---|
| `1990-05-14` | `1990-05-14` ✅ | YYYY-MM-DD |
| `05/14/1990` | `1990-05-14` ✅ | MM/DD/YYYY (month-first) |
| `05/07/1990` | `1990-05-07` ✅ | month-first (May 7), **not** flagged |
| `14/05/1990` | blank, ambiguous ✅ | month 14 invalid → not guessed as DD/MM |
| `14 May 1990` | blank, ambiguous ✅ | spelled month is not an accepted format |
| `1990/05/14` / `05-14-1990` | blank, ambiguous ✅ | wrong separators → Manual Review |

**Frontend flow:** a row whose DOB is ambiguous is added to **both dashboards with
status `Manual Review Required`** and is **not** searched in OSCAR; the batch
continues uninterrupted (per your instruction).

## B3 — Address no longer eats adjacent fields; Province is independent
**Change:** address is matched only when an address label starts a line (so
`Email Address:` can't trigger it) and collects continuation lines until a blank
line / next `Label:` / email line. Province now resolves from a labelled
`Province:` → parsed address → whole email, and abbreviations are trusted in free
text **only when uppercase** (so the word "on" never becomes Ontario).

| Case | Before | After |
|---|---|---|
| 1 — sample | address `…British Columbia, Payment ID` ❌ | `123 Main St, Vancouver, British Columbia` ✅ |
| 5 — `Email Address:` + multi-line street | address `aisha.khan@example.ca, Phone`; province **blank** ❌ | address `88 Queen St W, Toronto, Ontario M5H 2N2`; province **Ontario** ✅ |
| 2 — "located in BC" | BC ✅ | BC ✅ (uppercase abbrev preserved) |
| 6 — `Province: Quebec` | Quebec ✅ | Quebec ✅ |

## B5 — Subject-line names no longer append trailing words
**Change:** when a name is taken from the subject (no `Name:` label), it is matched
against the **subject line only** (never the body, so it can't bleed into the next
line) and captures up to three Title-Case words.

| Subject | Before | After |
|---|---|---|
| `New Assessment Request for John Smith` | `John` / `Smith Subject` ❌ | `John` / `Smith` ✅ |
| `…Assessment Request for Jane Doe - Private` | would append `Private` | `Jane` / `Doe` ✅ |

---

## Updated accuracy snapshot (10 required fields)

| Field | Before | After |
|---|---|---|
| First Name | ✅ (subject path bleeds) | ✅ |
| Last Name | ⚠️ subject bleed | ✅ (B5 fixed) |
| **Email** | ❌ clinic leak / guess | ✅ clinic-safe, blank-if-unknown |
| Phone | ✅ | ✅ |
| **Address** | ❌ polluted / wrong | ✅ clean, no field bleed |
| **Province** | ⚠️ failed when address bad | ✅ independent of address |
| **Date of Birth** | ❌ invalid on DD/MM | ✅ `YYYY-MM-DD` + `MM/DD/YYYY` only; else Manual Review |
| Payment ID | ✅ | ✅ |
| Email Date | ✅ | ✅ |
| Assessment Type | ✅ | ✅ |

All four identified defects (B1, B2, B3, B5) are resolved. B6 (spelled-month
dates) is now covered by the strict DOB policy (→ Manual Review).

---

## Remaining known issues

| ID | Issue | Severity | Notes |
|---|---|---|---|
| — | Province in free text could match a **clinic-signature** province when the patient's is absent/unlabelled. | Low | Labelled `Province:` and the address take priority, so this is an edge case. |
| **B7** | Gender name list is incomplete (e.g. "Jane" → U). | Low | Advisory only, staff-overridable; not one of the 10 required fields. |
| — | **One patient per email** assumed; multi-patient digests extract only the first. | Low | Real-format dependent — confirm with your samples. |
| — | **HTML-origin emails** depend on Outlook `.msg` → text conversion; labels/spacing may shift. | Unknown | Validate with real `.msg` exports. |

---

## Recommended next step
Send 8–15 anonymized real emails (or their `extract-check` output). With B1–B3
fixed, that run will confirm accuracy on your actual formats and tell us whether
B5 / the DOB ambiguity policy need attention **before** OSCAR testing begins.
