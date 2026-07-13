import { Router } from "express";
import { z } from "zod";
import { exec } from "node:child_process";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execAsync = promisify(exec);
export const emailRouter = Router();

// Clinic send accounts (overridable via env). Adult ADHD Centre vs the women's
// clinic each send from their own address.
const FROM_MAIN = (process.env.ACK_FROM_ACCOUNT ?? "ADHD@adultadhdcentre.com").trim();
const FROM_WOMEN = (process.env.ACK_FROM_ACCOUNT_WOMEN ?? "hers@adhdcentreforwomen.com").trim();

// Assessment tool PDFs. Looked for in the app folder first (bundled with the
// app), then the user's Desktop, then an explicit env override.
const PDF_MAIN = "Adult ADHD Assessment Tool- Blank.pdf";
const PDF_WOMEN = "ADHD Assessment Tool - ADHD Centre for Women- Blank.pdf";
const HERE = path.dirname(fileURLToPath(import.meta.url)); // server/src/routes
const APP_ROOT = path.resolve(HERE, "../../..");

function resolvePdf(womensClinic: boolean): string | null {
  const name = womensClinic ? PDF_WOMEN : PDF_MAIN;
  const envOverride = womensClinic ? process.env.ACK_PDF_PATH_WOMEN : process.env.ACK_PDF_PATH;
  const candidates = [
    envOverride,
    path.join(APP_ROOT, name),
    path.join(os.homedir(), "Desktop", name),
  ].filter(Boolean) as string[];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

function fromFor(womensClinic: boolean): string {
  return womensClinic ? FROM_WOMEN : FROM_MAIN;
}

function subjectFor(assessment: "private" | "therapist", womensClinic: boolean): string {
  // The women's clinic uses the same subject for both assessment types.
  if (womensClinic) return "Private ADHD Assessment Tool";
  return assessment === "therapist"
    ? "Therapist Supported ADHD Assessment Tool"
    : "Private ADHD Assessment Tool";
}

// ---------------------------------------------------------------- Adult ADHD Centre
function buildBodyMain(firstName: string, assessment: "private" | "therapist"): string {
  const shared = `
<p>Thank you for your interest in having a Private ADHD Assessment.</p>
<p>Your payment has been received.</p>
<p>If you have not already completed and returned the attached assessment tool to <a href="mailto:ADHD@adultadhdcentre.com">ADHD@adultadhdcentre.com</a>, please do so as soon as possible.</p>
<p>We will schedule you for a clinical interview appointment date within 7 days of receiving your completed assessment tool.</p>
<p>After you have completed your clinical interview, you will receive the clinical report within 2-3 weeks.</p>
<p>You may review the assessment process here:<br>
<a href="https://adultadhdcentre.com/assessment/private-adult-adhd-assessment/">https://adultadhdcentre.com/assessment/private-adult-adhd-assessment/</a></p>`;

  const privateExtra = `
<p><strong>IMPORTANT NOTE:</strong><br>
As you may have seen on our website, we also offer a Therapist-Supported ADHD Assessment for $399 which is likely covered by Extended Health Care Insurance Benefits.</p>
<p>If you are intending to claim this expense through your extended health care (insurance plan), we recommend that you contact your insurance company/provider to confirm if the services provided by a Registered Clinical Counsellor are covered.</p>
<ul>
<li>If these services are covered, please let us know via reply email if you would like to change your assessment to the "therapist-supported" assessment, and we will guide you through the process and inform you as to how you can make the payment for the remaining payment.</li>
<li>The difference between the therapist-supported assessment and the regular ADHD Assessment, other than the fee, is that the Registered Clinical Counsellor will review all the assessment forms, tools and notes from the clinical interview and provide their input as to the best management for ADHD. Currently, the Therapist-Supported ADHD Assessments are not yet available in Quebec, New Brunswick and Prince Edward Island, but we hope to expand this service across the country.</li>
</ul>`;

  const closing = `
<p>We look forward to receiving your completed assessment tool.</p>
<p>Please let us know if we can be of any further assistance at any time, or if you have any questions.</p>
<p>Best regards,<br>
Adult ADHD Centre Manager<br>
Adult ADHD Centre<br>
<a href="https://www.adultadhdcentre.com">www.adultadhdcentre.com</a><br>
Email: <a href="mailto:ADHD@adultadhdcentre.com">ADHD@adultadhdcentre.com</a></p>
<p><em>This email communication may be confidential and privileged. Any use of this email by an unintended recipient is prohibited. Confidentiality and privilege are not lost by this email having been sent inadvertently to an unintended recipient. If you are not the intended recipient, please notify us by telephone or return this email without disseminating it.</em></p>`;

  return `<p>Dear ${firstName},</p>${shared}${assessment === "private" ? privateExtra : ""}<p>&nbsp;</p>${closing}`;
}

// ---------------------------------------------------------- ADHD Centre for Women
function buildBodyWomen(firstName: string, assessment: "private" | "therapist"): string {
  const shared = `
<p>Thank you for your interest in having a Private ADHD Assessment. Your payment has been received.</p>
<p>If you have not already completed and returned the attached assessment tool to <a href="mailto:hers@adhdcentreforwomen.com">hers@adhdcentreforwomen.com</a>, please do so as soon as possible.</p>
<p>We will schedule you for a consultation appointment within one week of receiving your completed assessment tool.</p>
<p>After you have completed your clinical interview, you will receive the clinical report within 3-4 weeks. To review the process and timing visit: <a href="https://adhdcentreforwomen.com/assessment/#process">https://adhdcentreforwomen.com/assessment/#process</a></p>`;

  const privateExtra = `
<p><strong>IMPORTANT NOTE:</strong><br>
As you may have seen on our website, we also offer a Therapist-Supported ADHD Assessment for $399 which is likely covered by Extended Health Care Insurance Benefits.</p>
<p>If you are intending to claim this expense through your extended health care (insurance plan), we recommend that you contact your insurance company/provider to confirm if the services provided by a Registered Clinical Counsellor are covered.</p>
<ul>
<li>If these services are covered, please let us know via reply email if you would like to change your assessment to the "therapist-supported" assessment, and we will guide you through the process and inform you as to how you can make the payment for the remaining fee.</li>
<li>The difference between the therapist-supported assessment and the regular ADHD Assessment, other than the fee, is that the Registered Clinical Counsellor will review all the assessment forms, tools and notes from the clinical interview and provide their input as to the best management for ADHD. Currently, the Therapist-Supported ADHD Assessments are not yet available in Quebec, New Brunswick and Prince Edward Island, but we hope to expand this service across the country.</li>
</ul>`;

  const closing = `
<p>We look forward to receiving your completed assessment tool.</p>
<p>Please let us know if we can be of any further assistance at any time, or if you have any questions.</p>
<p>Best regards,<br>
ADHD Centre for Women Manager</p>
<p>ADHD Centre for Women<br>
<a href="https://www.adhdcentreforwomen.com">www.adhdcentreforwomen.com</a><br>
Email: <a href="mailto:hers@adhdcentreforwomen.com">hers@adhdcentreforwomen.com</a></p>
<p><em>This email communication may be confidential and privileged. Any use of this email by an unintended recipient is prohibited. Confidentiality and privilege are not lost by this email having been sent inadvertently to an unintended recipient. If you are not the intended recipient, please notify us by telephone or return this email without disseminating it.</em></p>`;

  return `<p>Dear ${firstName},</p>${shared}${assessment === "private" ? privateExtra : ""}<p>&nbsp;</p>${closing}`;
}

function buildBody(
  firstName: string,
  assessment: "private" | "therapist",
  womensClinic: boolean,
): string {
  return womensClinic ? buildBodyWomen(firstName, assessment) : buildBodyMain(firstName, assessment);
}

const recipientSchema = z.object({
  toEmail: z.string().email(),
  firstName: z.string().min(1),
  assessment: z.enum(["private", "therapist"]),
  womensClinic: z.boolean().optional(),
});
const batchSchema = z.object({ recipients: z.array(recipientSchema).min(1) });

type Item = { to: string; subject: string; body: string; fromAccount: string; pdf: string };

/** Build per-recipient mail items, resolving each clinic's From + PDF. */
function buildItems(recipients: z.infer<typeof recipientSchema>[]): {
  items?: Item[];
  missingPdf?: string;
} {
  const items: Item[] = [];
  for (const r of recipients) {
    const women = r.womensClinic ?? false;
    const pdf = resolvePdf(women);
    if (!pdf) return { missingPdf: women ? PDF_WOMEN : PDF_MAIN };
    items.push({
      to: r.toEmail,
      subject: subjectFor(r.assessment, women),
      body: buildBody(r.firstName, r.assessment, women),
      fromAccount: fromFor(women),
      pdf,
    });
  }
  return { items };
}

function runBatch(
  items: Item[],
  action: "save" | "send",
): Promise<{ ok: number; fail: string[]; clean: number; onBehalf: number }> {
  const stamp = Date.now();
  const tmpJson = path.join(os.tmpdir(), `ack-${action}-${stamp}.json`);
  const tmpPs = path.join(os.tmpdir(), `ack-${action}-${stamp}.ps1`);
  writeFileSync(tmpJson, JSON.stringify({ items }), "utf8");
  const escPS = (s: string) => s.replace(/'/g, "''");

  // "save" creates drafts (From set, review + Send by staff); "send" transmits.
  const finish = action === "send" ? "$m.Send()" : "$m.Save()";
  const openDrafts =
    action === "save"
      ? `
try {
  $drafts = $outlook.GetNamespace('MAPI').GetDefaultFolder(16)
  $exp = $drafts.GetExplorer(); $exp.Display(); Start-Sleep -Milliseconds 300; try { $exp.Activate() } catch {}
} catch {}`
      : "";

  const script = `
$ErrorActionPreference = 'Stop'
$data = Get-Content -Raw -LiteralPath '${escPS(tmpJson)}' | ConvertFrom-Json
$outlook = New-Object -ComObject Outlook.Application

# Cache resolved Outlook accounts (by SMTP address) so each recipient can use
# the clean "Send As" method when available, falling back to "Send on Behalf"
# (shows "X on behalf of Y" in the sent item) only if Send As isn't granted.
$acctCache = @{}
function Resolve-Account($smtp) {
  if ($acctCache.ContainsKey($smtp)) { return $acctCache[$smtp] }
  $found = $null
  foreach ($a in $outlook.Session.Accounts) { try { if ($a.SmtpAddress -ieq $smtp) { $found = $a; break } } catch {} }
  $acctCache[$smtp] = $found
  return $found
}

$ok = 0; $fail = @(); $clean = 0; $onBehalf = 0
foreach ($it in $data.items) {
  try {
    $m = $outlook.CreateItem(0)
    $m.To = $it.to
    $m.Subject = $it.subject
    $m.HTMLBody = $it.body
    $acct = Resolve-Account $it.fromAccount
    $usedCleanSend = $false
    if ($acct -ne $null) {
      $m.SendUsingAccount = $acct
      try { if ($m.SendUsingAccount -ne $null -and $m.SendUsingAccount.SmtpAddress -ieq $it.fromAccount) { $usedCleanSend = $true } } catch {}
    }
    if (-not $usedCleanSend) { $m.SentOnBehalfOfName = $it.fromAccount }
    # Force replies back to the clinic address, whatever account actually sends.
    try {
      while ($m.ReplyRecipients.Count -gt 0) { $m.ReplyRecipients.Remove(1) }
      $rr = $m.ReplyRecipients.Add($it.fromAccount)
      try { $rr.Resolve() | Out-Null } catch {}
    } catch {}
    $m.Attachments.Add($it.pdf) | Out-Null
    ${finish}
    $ok++
    if ($usedCleanSend) { $clean++ } else { $onBehalf++ }
  } catch { $fail += $it.to }
}${openDrafts}
[pscustomobject]@{ ok = $ok; fail = @($fail); clean = $clean; onBehalf = $onBehalf } | ConvertTo-Json -Compress
`.trim();
  writeFileSync(tmpPs, script, "utf8");

  const cleanup = () => {
    try { unlinkSync(tmpJson); } catch {}
    try { unlinkSync(tmpPs); } catch {}
  };

  return execAsync(
    `powershell -NoProfile -ExecutionPolicy Bypass -NonInteractive -File "${tmpPs}"`,
    { timeout: 180_000 },
  ).then(
    ({ stdout }) => {
      cleanup();
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? "{}";
      let res: { ok?: number; fail?: string[] | string | null; clean?: number; onBehalf?: number } = {};
      try { res = JSON.parse(line); } catch {}
      const fail = Array.isArray(res.fail) ? res.fail : res.fail ? [String(res.fail)] : [];
      return { ok: res.ok ?? 0, fail, clean: res.clean ?? 0, onBehalf: res.onBehalf ?? 0 };
    },
    (err) => {
      cleanup();
      throw new Error(err.stderr || err.message || "PowerShell failed");
    },
  );
}

// Create drafts (From set to the clinic address) for review + manual Send.
emailRouter.post("/draft-batch", async (req, res) => {
  const parsed = batchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  const built = buildItems(parsed.data.recipients);
  if (built.missingPdf) {
    res.status(500).json({ error: `Assessment tool PDF not found: "${built.missingPdf}".` });
    return;
  }
  try {
    const r = await runBatch(built.items!, "save");
    res.json({
      ok: true,
      created: r.ok,
      failed: r.fail,
      note:
        r.onBehalf > 0
          ? `${r.onBehalf} draft(s) will show as "sent on behalf of" the clinic address (this account has ` +
            `"Send on Behalf" but not "Send As" permission — ask IT to grant "Send As" to remove that text).`
          : undefined,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Draft creation failed." });
  }
});

// Send automatically (used only where the account has send-as permission).
emailRouter.post("/send", async (req, res) => {
  const parsed = batchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  const built = buildItems(parsed.data.recipients);
  if (built.missingPdf) {
    res.status(500).json({ error: `Assessment tool PDF not found: "${built.missingPdf}".` });
    return;
  }
  try {
    const r = await runBatch(built.items!, "send");
    res.json({
      ok: true,
      sent: r.ok,
      failed: r.fail,
      note:
        r.onBehalf > 0
          ? `${r.onBehalf} email(s) were sent showing "on behalf of" the clinic address (this account has ` +
            `"Send on Behalf" but not "Send As" permission — ask IT to grant "Send As" to remove that text).`
          : undefined,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Send failed." });
  }
});
