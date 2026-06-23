# Email Extraction — Validation Report

Validates the parser in `src/lib/extract.ts` (the same engine the dashboards use)
**before** OSCAR testing. All outputs below are **real** — produced by running the
engine via `server/extract-check.mts`, not hand-written.

> No code was changed. This is a findings report. Fixes are recommended, not yet
> applied.

> **Update:** B1, B2, and B3 (plus B6) have since been **fixed** — see
> [EXTRACTION_FIXES.md](EXTRACTION_FIXES.md) for the before/after and remaining
> known issues.

---

## 1. How extraction works (per field)

`extractFromEmail(raw)` normalises line endings, then runs independent
regex/heuristic passes:

| Field | How it's found | Post-processing |
|---|---|---|
| **Subject** | `Subject:` header line | trimmed |
| **Email Date** | first of `Date:` / `Sent:` / `Received:` headers | parsed → `YYYY-MM-DD` |
| **Email (patient)** | labelled `Email/Patient Email/…:` first; else first email in the body that is **not** clinic/no-reply/mailer | trimmed |
| **Phone** | labelled `Phone/Tel/Mobile/Cell:`; else first NA-style number pattern | normalised to `NNN-NNN-NNNN` (drops leading 1) |
| **DOB** | labelled `Date of Birth/DOB/Born:` | normalised → `YYYY-MM-DD` (ISO, M/D/Y, or "Mon D, YYYY") |
| **Payment ID** | labelled `Transaction/Payment/Order/Invoice/Reference ID:` | trimmed |
| **First / Last name** | `First/Last Name:` labels; else `Patient/Full Name:`; else a capitalised name after "assessment request for" in the subject | split into first / last |
| **Address** | labelled `Address/Mailing/Street Address:` + up to 3 following lines | joined with commas |
| **Province** | dictionary match (full names + abbreviations) over the **address if present, else the whole text** | canonical province name |
| **Assessment Type** | subject keywords: "therapist supported" → therapist; "assessment request" → private | — |
| **Gender** | first-name lookup against built-in name lists (advisory; staff override) | M / F / U |

---

## 2. Mandatory vs optional

The parser flags a field in `missing[]` when absent. Those it treats as
**mandatory**:

- **Mandatory (flagged if missing):** First Name, Last Name, **Email**, Phone,
  Date of Birth, Email Date, Assessment Type
- **Optional (never flagged):** Address, Province, Payment ID, Gender, Subject

**Functionally, only Email is a hard gate** in the current app: no email → the row
is sent to Manual Review and OSCAR is not searched. The other "mandatory" fields
are advisory today (they populate the dashboard / aid matching but do not block).
For OSCAR matching quality, **Email, then Last Name + DOB**, matter most.

---

## 3. Sample extraction output

Input: `samples/sample-intake-email.txt`. Real output:

```
firstName    Jane
lastName     Doe
email        jane.doe@example.com
phone        604-555-0142
address      123 Main St, Vancouver, British Columbia, Payment ID   ← see B4
province     British Columbia
dob          1990-05-14
paymentId    PAY-20260622-0042
emailDate    2026-06-22
assessment   therapist
missing      (none)
```

9 of 10 fields are correct. The only defect on the clean sample is **Address**,
which has `, Payment ID` appended (bug **B4** below).

---

## 4. Confirmation of the 10 required fields

Verdict from the sample + 5 realistic variants (see §5 for the failing cases):

| Field | Works on well-labelled email? | Caveats / where it breaks |
|---|---|---|
| First Name | ✅ | Bleeds when taken from the **subject** only (B5) |
| Last Name | ✅ | Bleeds when taken from the **subject** only (B5) |
| Email Address | ✅ | **Picks up the clinic address when no patient email exists (B1)** |
| Phone Number | ✅ | Extensions dropped (usually fine); non-NA formats may miss |
| Address | ⚠️ | **Often polluted or wrong (B3, B4)** |
| Province | ✅ / ⚠️ | Correct from labels/abbreviations, but **suppressed when Address is wrong (B3)** |
| Date of Birth | ⚠️ | **DD/MM dates → invalid (B2); day-first spelled dates not normalised (B6)** |
| Payment ID | ✅ | Reliable with any of the supported labels |
| Email Date | ✅ | Reliable across header + date formats |
| Assessment Type | ✅ | Driven by subject keywords; non-standard subjects → blank |

Reliable today: **Email Date, Payment ID, Assessment Type, Phone**, and **First/
Last/Email/Province** *when the email is clearly labelled*. The shaky ones are
**Address, DOB, and anything inferred from the subject**.

---

## 5. Weaknesses found (ranked by impact)

Each is a real, reproduced result. Run `node --import tsx extract-check.mts <file>`
to see them.

### HIGH — can corrupt OSCAR search or chart data
- **B1 — Clinic email used as the patient email.** When the body has no patient
  address, the "ignore clinic/no-reply" filter is defeated by a final
  `?? firstEmail` fallback, so the **clinic's own address is returned**.
  _Case 4:_ only `someone@adultadhdcentre.com` present → that was returned as the
  patient email. → OSCAR would be searched with the wrong address.
- **B2 — DOB day/month ambiguity.** Dates are assumed **MM/DD/YYYY**. A Canadian
  **DD/MM** date produces an invalid month.
  _Case 6:_ `22/07/82` → `1982-22-07` (month "22"). → invalid/incorrect DOB.
- **B3 — "Email Address:" hijacks the Address field, and that suppresses
  Province.** The address regex matches the substring "Address" inside "Email
  Address:", capturing the email as the address; province is then searched only
  within that bad address and **misses**.
  _Case 5:_ real address `88 Queen St W, Toronto, Ontario` → Address became
  `aisha.khan@example.ca, Phone`, **Province blank** (Ontario missed).

### MEDIUM
- **B4 — Address bleeds into the next field's label.** Trailing-line capture grabs
  the following field's label.
  _Case 1:_ Address ends with `…British Columbia, Payment ID`.
- **B5 — Subject-derived names bleed.** A name pulled from the subject greedily
  appends the next word.
  _Case 2:_ subject "…Request for John Smith" → Last Name `Smith Subject`.
- **B6 — Day-first spelled dates not normalised.** `14 May 1990` is left as-is
  (only "May 14, 1990" form is recognised). _Case 3._

### LOW
- **B7 — Gender name list is incomplete** (e.g. "Jane" → U). Advisory only; staff
  can override. Not one of the 10 required fields.

### Cross-cutting observations
- The parser is **label-driven**. It does well on structured emails and degrades
  on free-form prose, forwarded chains, or HTML-to-text conversions where labels
  are missing or reflowed.
- It assumes **one patient per email**. A digest listing several patients would
  extract only one.
- `.msg`/`.eml` from Outlook are parsed in the app; subject/date/from are
  reconstructed, but **HTML bodies become text** and spacing/labels may shift —
  worth testing with real exports.

---

## 6. How to provide real anonymized emails for validation

**Goal:** test the parser on the formats your staff actually send, without moving
PHI anywhere.

### Anonymize (keep structure, change values)
Replace only the *values*, keep every **label, line break, and format** intact so
we test the real parsing:
- Names → fake names (keep "Last, First" vs "First Last" style)
- Email → `someone@example.com` (keep whether it's labelled or only in a signature)
- Phone / DOB / Payment ID → fake but **same format** (this is exactly what we're
  testing — keep `22/07/82` vs `1982-07-22` etc.)
- Address → fake street, **real province** (province logic matters)
- **Do not "tidy" the layout** — quirks are the point.

### Provide them (two easy options, both fully local)
1. **Drag into the running app** (best visual check): export the anonymized emails
   from Outlook as `.msg` (or `.eml`/`.txt`), run `dev.ps1`, and drag them onto the
   drop zone. Verify the Daily Sheet and Scheduling Queue columns look right.
2. **Batch CLI check** (best for many at once): drop the anonymized `.txt`/`.eml`
   files into `samples/real/` (already git-ignored), then:
   ```
   cd server
   node --import tsx extract-check.mts        # prints extracted fields per file
   ```
   Share that printed output (it's non-PHI after anonymization) and I'll pinpoint
   exactly which formats break and what to fix.

### How many / what mix
Aim for **8–15** covering the real spread:
- Different referral sources / staff senders
- A therapist-supported and a private request
- At least one **forwarded** chain and one **HTML-origin** email
- Any where the patient email is only in a signature, or absent
- Any non-`YYYY-MM-DD` date styles your sources use

---

## 7. Recommendation before OSCAR testing

The engine is solid on well-labelled emails but has **three HIGH-impact bugs
(B1 email, B2 DOB, B3 address/province)** that would directly hurt OSCAR search and
chart accuracy. Suggested order:

1. You send 8–15 anonymized real emails (or their `extract-check` output).
2. I confirm which of B1–B6 actually occur in your real formats (and find any new
   ones) — **measure before fixing.**
3. We fix the confirmed bugs (small, contained changes to `extract.ts`; no new
   features), re-run `extract-check`, and only then start OSCAR testing.

This keeps extraction accuracy proven before it feeds real OSCAR searches.
