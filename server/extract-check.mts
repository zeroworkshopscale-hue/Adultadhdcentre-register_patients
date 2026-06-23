/**
 * Extraction validation harness (dev tool — not part of the app bundle).
 *
 * Runs the SAME extraction engine the dashboard uses (src/lib/extract.ts) over
 * one file or a folder of emails, and prints what it extracted. Use it to see
 * exactly what the parser pulls from real Adult ADHD Centre emails — especially
 * the email address it would search OSCAR with.
 *
 *   cd server
 *   node --import tsx extract-check.mts                 # defaults to ../samples/real
 *   node --import tsx extract-check.mts ../samples      # a folder
 *   node --import tsx extract-check.mts "path/to/email.msg"
 *
 * Supports .msg (Outlook), .eml, and .txt. Everything runs locally in Node.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { extractFromEmail } from "../src/lib/extract.ts";

const require = createRequire(import.meta.url);
const MsgReader =
  require("@kenjiuno/msgreader").default ?? require("@kenjiuno/msgreader");

const FIELDS = [
  "firstName",
  "lastName",
  "email",
  "phone",
  "address",
  "province",
  "dob",
  "paymentId",
  "emailDate",
  "assessment",
  "subject",
] as const;

function readEmail(file: string): string {
  if (extname(file).toLowerCase() === ".msg") {
    const buf = readFileSync(file);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const info = new MsgReader(ab).getFileData() as Record<string, string>;
    if (!info || (info as { error?: string }).error) {
      throw new Error((info as { error?: string })?.error || "unreadable .msg");
    }
    return [
      `Subject: ${info.subject ?? ""}`,
      `Date: ${info.messageDeliveryTime ?? info.clientSubmitTime ?? ""}`,
      `From: ${info.senderEmail ?? ""}`,
      "",
      info.body ?? "",
    ].join("\n");
  }
  return readFileSync(file, "utf8");
}

function collect(target: string): string[] {
  const st = statSync(target);
  if (st.isFile()) return [target];
  return readdirSync(target)
    .filter((f) => [".msg", ".eml", ".txt"].includes(extname(f).toLowerCase()))
    .map((f) => join(target, f))
    .sort();
}

const argPath = process.argv[2];
const target = argPath ?? fileURLToPath(new URL("../samples/real", import.meta.url));

let files: string[];
try {
  files = collect(target);
} catch {
  console.error(`Path not found: ${target}`);
  console.error("Create ./samples/real and drop emails there, or pass a path.");
  process.exit(1);
}
if (files.length === 0) {
  console.error(`No .msg/.eml/.txt files found in ${target}`);
  process.exit(1);
}

console.log(`Checking ${files.length} file(s) from ${target}\n`);
for (const file of files) {
  console.log("================ " + file.split(/[\\/]/).pop() + " ================");
  let e;
  try {
    e = extractFromEmail(readEmail(file));
  } catch (err) {
    console.log(`  ERROR reading file: ${(err as Error).message}\n`);
    continue;
  }
  for (const f of FIELDS) {
    const v = (e as Record<string, unknown>)[f];
    console.log(`  ${f.padEnd(12)} ${v === "" || v == null ? "(blank)" : String(v)}`);
  }
  console.log(
    `  ${"missing".padEnd(12)} ${e.missing.length ? e.missing.join(", ") : "(none)"}\n`,
  );
}
