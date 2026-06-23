# Sample test emails

These let you exercise the pipeline immediately. Drag a file onto the drop zone
in the app (or click to browse).

## Files
- `sample-intake-email.txt` — a well-formed intake email. As written, it extracts
  cleanly and searches OSCAR for `jane.doe@example.com`.

## How to test the three paths

The **email address line** drives the OSCAR search. Edit it to test each case:

1. **Found (real patient):** change the `Email:` line to the address of a known
   **test patient that exists in OSCAR**, then drop the file. Expect a demographic
   number and a green row.
2. **Not found:** leave a clearly-absent address (e.g. `jane.doe@example.com`).
   Expect "Patient Not Found in OSCAR" and a flagged row.
3. **No email (manual review):** delete the `Email:` line entirely. Expect
   "No email address found — cannot search OSCAR".

## Batch test
Duplicate the file a few times (e.g. `email1.txt … email12.txt`), give each a
different `Email:` line, select them all, and drag them in together. Watch the
Batch Status counters and both dashboards fill progressively.

## Real Outlook emails
You can also drag real `.msg` / `.eml` files exported from Outlook — the app
parses them the same way. Use a **test/dummy patient** where possible; validation
only reads from OSCAR (search + view chart), it never writes.
