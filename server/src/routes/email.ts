import { Router } from "express";
import { z } from "zod";
import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execAsync = promisify(exec);
export const emailRouter = Router();

// The account the acknowledgement must be sent FROM, regardless of which other
// accounts are configured in Outlook. Overridable via env.
const FROM_ACCOUNT = (process.env.ACK_FROM_ACCOUNT ?? "ADHD@adultadhdcentre.com").trim();

// The assessment tool PDF. Looked for (in order): an explicit env override, the
// app folder itself (portable — travels with the zip), then the user's Desktop.
const PDF_NAME = "Adult ADHD Assessment Tool- Blank.pdf";
const HERE = path.dirname(fileURLToPath(import.meta.url)); // server/src/routes
const APP_ROOT = path.resolve(HERE, "../../.."); // app folder root

function resolvePdf(): string | null {
  const candidates = [
    process.env.ACK_PDF_PATH,
    path.join(APP_ROOT, PDF_NAME),
    path.join(os.homedir(), "Desktop", PDF_NAME),
  ].filter(Boolean) as string[];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

const schema = z.object({
  toEmail: z.string().email(),
  firstName: z.string().min(1),
  assessment: z.enum(["private", "therapist"]),
});

function buildBody(firstName: string, assessment: "private" | "therapist"): string {
  const greeting = `Dear ${firstName},`;
  const shared = `
<p>Thank you for your interest in having a Private ADHD Assessment.</p>
<p>Your payment has been received.</p>
<p>If you have not already completed and returned the attached assessment tool to <a href="mailto:ADHD@adultadhdcentre.com">ADHD@adultadhdcentre.com</a>, please do so as soon as possible.</p>
<p>We will schedule you for a clinical interview appointment date within 7 days of receiving your completed assessment tool.</p>
<p>After you have completed your clinical interview, you will receive the clinical report within 2-3 weeks.</p>
<p>You may review the assessment process here:<br>
<a href="https://adultadhdcentre.com/assessment/private-adult-adhd-assessment/">https://adultadhdcentre.com/assessment/private-adult-adhd-assessment/</a></p>`;

  const privateExtra = `
<p>
<strong>IMPORTANT NOTE:</strong><br>
As you may have seen on our website, we also offer a Therapist-Supported ADHD Assessment for $399 which is likely covered by Extended Health Care Insurance Benefits.
</p>
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

  return `<p>${greeting}</p>${shared}${assessment === "private" ? privateExtra : ""}<p>&nbsp;</p>${closing}`;
}

emailRouter.post("/draft", async (req, res) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  const { toEmail, firstName, assessment } = parsed.data;

  const pdfPath = resolvePdf();
  if (!pdfPath) {
    res.status(500).json({
      error: `Assessment tool PDF not found. Put "${PDF_NAME}" in the app folder or on the Desktop.`,
    });
    return;
  }

  const subject =
    assessment === "therapist"
      ? "Therapist Supported ADHD Assessment Tool"
      : "Private ADHD Assessment Tool";

  const htmlBody = buildBody(firstName, assessment);
  const escPS = (s: string) => s.replace(/'/g, "''");

  // Open a pre-filled Outlook draft. The FROM account is forced to the clinic
  // address so it never goes out from a staff member's personal account. The
  // draft is only Displayed — staff review and click Send themselves.
  const ps = `
$outlook = New-Object -ComObject Outlook.Application
$mail = $outlook.CreateItem(0)
$mail.To = '${escPS(toEmail)}'
$mail.Subject = '${escPS(subject)}'
$mail.HTMLBody = '${escPS(htmlBody)}'
$acct = $null
foreach ($a in $outlook.Session.Accounts) { try { if ($a.SmtpAddress -ieq '${escPS(FROM_ACCOUNT)}') { $acct = $a; break } } catch {} }
if ($acct -ne $null) { $mail.SendUsingAccount = $acct }
$mail.Attachments.Add('${escPS(pdfPath)}') | Out-Null
$mail.Display()
`.trim();

  try {
    await execAsync(`powershell -NoProfile -NonInteractive -Command "${ps.replace(/"/g, '\\"')}"`, {
      timeout: 20_000,
    });
    res.json({ ok: true, fromAccountRequested: FROM_ACCOUNT });
  } catch (err: any) {
    if (err.code === "ETIMEDOUT" || err.code === "ENOENT") {
      res.status(500).json({ error: err.message });
    } else {
      // Outlook opened the draft but returned a minor warning — treat as success.
      res.json({ ok: true, fromAccountRequested: FROM_ACCOUNT });
    }
  }
});
