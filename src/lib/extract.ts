// Email extraction + classification utilities for the ADHD Centre app.

const PROVINCES: Record<string, string> = {
  bc: "British Columbia",
  "british columbia": "British Columbia",
  ab: "Alberta",
  alberta: "Alberta",
  on: "Ontario",
  ontario: "Ontario",
  qc: "Quebec",
  quebec: "Quebec",
  ns: "Nova Scotia",
  "nova scotia": "Nova Scotia",
  nb: "New Brunswick",
  "new brunswick": "New Brunswick",
  mb: "Manitoba",
  manitoba: "Manitoba",
  sk: "Saskatchewan",
  saskatchewan: "Saskatchewan",
  pe: "Prince Edward Island",
  pei: "Prince Edward Island",
  "prince edward island": "Prince Edward Island",
  nl: "Newfoundland and Labrador",
  "newfoundland and labrador": "Newfoundland and Labrador",
  newfoundland: "Newfoundland and Labrador",
  yt: "Yukon",
  yukon: "Yukon",
  nt: "Northwest Territories",
  "northwest territories": "Northwest Territories",
  nu: "Nunavut",
  nunavut: "Nunavut",
};

// Province keys split so 2-letter abbreviations can be matched more strictly in
// free text (where "on" / "pe" would otherwise false-match common words).
const PROVINCE_ABBREVS = Object.keys(PROVINCES).filter((k) => k.length <= 3);
const PROVINCE_NAMES = Object.keys(PROVINCES).filter((k) => k.length > 3);

// Addresses that must NEVER be used as the patient's email. Extend this list if
// the clinic uses other domains. The clinic domain marker plus generic
// no-reply/role mailboxes are treated as non-patient.
const NON_PATIENT_EMAIL_MARKER =
  /(?:adultadhd|adultadhdcentre|no-?reply|do-?not-?reply|mailer|postmaster|daemon)/i;
const NON_PATIENT_LOCALPART =
  /^(?:support|info|intake|admin|administrator|referrals?|reception|front[.\-_]?desk|office|billing|accounts?|noreply)@/i;

function isNonPatientEmail(e: string): boolean {
  const v = (e || "").trim();
  return !v || NON_PATIENT_EMAIL_MARKER.test(v) || NON_PATIENT_LOCALPART.test(v);
}

function isoDate(y: string | number, mo: string | number, d: string | number): string {
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// Compact gender hints — staff can override in UI.
const MALE = new Set(
  "john michael david james robert william richard thomas mark paul daniel matthew anthony donald steven andrew kenneth joshua kevin brian george edward ronald timothy jason jeffrey ryan jacob gary nicholas eric jonathan stephen larry justin scott brandon benjamin samuel gregory frank alexander patrick raymond jack dennis jerry tyler aaron henry adam douglas peter nathan zachary kyle walter ethan jeremy harold christian sean austin noah jordan ali ahmed mohammed muhammad omar hassan ibrahim liam oliver elijah lucas mason logan aiden jackson levi sebastian mateo jayden leo theodore owen hudson grayson carter wyatt julian luke gabriel isaac lincoln asher caleb hunter eli connor santiago jeremiah cameron ezra colton cooper josiah xavier jose ian dylan axel miles jaxon nolan declan cole carson nathaniel jonah evan max micah greyson maxwell kai brody wesley emmett bennett calvin felix victor marcus harrison theo luke george blake wade dale kobe wayne dwayne clyde pierre andre jesse lance dave steve pete jude zane nate gabe tate cade tony rory cody bobby ricky tommy jimmy danny johnny terry barry corey rudy troy roy ray jay clay hugo diego pablo pedro marco enzo bruno nico rene andres luca cosmo".split(/\s+/),
);
const FEMALE = new Set(
  "mary patricia jennifer linda elizabeth barbara susan jessica sarah karen lisa nancy betty helen sandra donna carol ruth sharon michelle laura sarah kimberly deborah dorothy amy angela ashley brenda emma olivia cynthia marie janet catherine frances christine samantha debra rachel carolyn janet virginia maria heather diane julie joyce victoria kelly christina joan evelyn lauren judith megan cheryl andrea hannah jacqueline martha gloria teresa sara janice julia kathryn grace rose amber denise danielle marilyn beverly charlotte natalie diana brittany theresa kayla alexis lori tiffany jasmine titania chloe sophia ava mia isabella amelia ainslie harper abigail emily ella scarlett penelope layla lillian nora zoey mila aurora lily addison eleanor luna savannah brooklyn leah zoe stella hazel ellie paisley audrey skylar violet claire bella aaliyah gabriella anna allison gianna serenity aria kennedy ivy aubrey maya josephine ariana naomi vivian sadie willow isla nova emilia everly delilah autumn quinn ruby clara genevieve elise margaret rosalie eliza juliana fiona daphne sienna elsie georgia eloise maeve cora iris adeline kehlani".split(/\s+/),
);

export type Assessment = "private" | "therapist" | null;

export interface Extracted {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  address: string;
  province: string;
  dob: string;
  paymentId: string;
  emailDate: string;
  subject: string;
  assessment: Assessment;
  gender: "M" | "F" | "U";
  /** True for ADHD Centre for Women orders (their booking alert gets " - Women"). */
  womensClinic: boolean;
  /** True when a DOB was present but not in an accepted format → Manual Review. */
  dobAmbiguous: boolean;
  missing: string[];
}

const grab = (re: RegExp, text: string, group = 1): string => {
  const m = text.match(re);
  return m ? (m[group] ?? "").trim() : "";
};

/**
 * Pull a patient name from a subject line such as
 *   "New Assessment Request for John Smith"  -> "John Smith".
 * Matches against the SUBJECT ONLY (never the body, so it cannot bleed into the
 * next line) and captures up to three Title-Case words, so trailing words after
 * the name (e.g. "Private", "ADHD") are not appended.
 */
function nameFromSubject(subject: string): string {
  const after = subject.match(/(?:assessment\s*request\s*for|request\s*for)\s+(.*)$/i);
  if (!after) return "";
  const nm = after[1].match(/^([A-Z][A-Za-z'\-]+(?:\s+[A-Z][A-Za-z'\-]+){0,2})/);
  return nm ? nm[1].trim() : "";
}

/**
 * Extract a mailing address without consuming adjacent fields. Matches an
 * address label only at the START of a line (so "Email Address:" never triggers
 * it), then collects continuation lines until a blank line, the next
 * "Label:" field, or an email line.
 */
function extractAddress(text: string): string {
  const lines = text.split("\n");
  // Address label, either inline ("Address: 1 Main St") or on its own line
  // ("Street Address" with the value on the following lines).
  const labelRe =
    /^[ \t]*(?:patient\s*address|street\s*address|mailing\s*address|home\s*address|address)\b[ \t]*[:\-]?[ \t]*(.*)$/i;
  const colonField = /^[ \t]*[A-Za-z][A-Za-z0-9 .'/\-]{0,40}:\s/;
  // Other intake fields that appear as a bare label on their own line — stop
  // collecting the address when one of these starts the next line.
  const ownLineLabel =
    /^[ \t]*(?:date\s*of\s*birth|dob|d\.?o\.?b\.?|e-?mail|phone|tel|telephone|mobile|cell|payment|transaction|order|invoice|reference|gender|sex|pronoun|title|first\s*name|last\s*name|full\s*name|name|province|postal|paying\s*with)\b[ \t]*:?[ \t]*$/i;
  const postal = /[A-Za-z]\d[A-Za-z]\s?\d[A-Za-z]\d/; // Canadian postal code
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(labelRe);
    if (!m) continue;
    const parts: string[] = [];
    if (m[1].trim()) parts.push(m[1].trim());
    for (let j = i + 1; j < lines.length && parts.length < 4; j++) {
      const ln = lines[j].trim();
      if (!ln) break; // blank line ends the address block
      if (/@/.test(ln)) break; // an email line
      if (colonField.test(lines[j])) break; // a new "Label: value" field
      if (ownLineLabel.test(lines[j])) break; // a new bare-label field
      parts.push(ln);
      if (postal.test(ln)) break; // a postal code closes the address
    }
    if (parts.length) return parts.join(", ");
  }
  return "";
}

export function formatPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  if (digits.length !== 10) return raw.trim();
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
}

export interface DobResult {
  /** Normalised YYYY-MM-DD, or "" if not confidently parsed. */
  dob: string;
  /** True when a date was present but could not be resolved unambiguously. */
  ambiguous: boolean;
}

/**
 * Parse a date of birth. Per Adult ADHD Centre policy, intake emails use ONLY:
 *   - YYYY-MM-DD   (e.g. 1990-05-14)  — interpreted as year-month-day
 *   - MM/DD/YYYY   (e.g. 05/14/1990)  — interpreted as month-day-year
 * Any other format (DD/MM, 2-digit years, spelled months, other separators) is
 * NOT guessed — it is flagged ambiguous so the row goes to Manual Review.
 */
export function parseDob(raw: string): DobResult {
  const s = (raw || "").trim();
  if (!s) return { dob: "", ambiguous: false };

  // YYYY-MM-DD (dash-separated, year first)
  let m = s.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (m) {
    const mo = +m[2], d = +m[3];
    return mo >= 1 && mo <= 12 && d >= 1 && d <= 31
      ? { dob: isoDate(m[1], mo, d), ambiguous: false }
      : { dob: "", ambiguous: true };
  }

  // MM/DD/YYYY (slash-separated, year last) — always month-first.
  m = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (m) {
    const mo = +m[1], d = +m[2];
    return mo >= 1 && mo <= 12 && d >= 1 && d <= 31
      ? { dob: isoDate(m[3], mo, d), ambiguous: false }
      : { dob: "", ambiguous: true };
  }

  // Not one of the two accepted formats → flag for manual review, never guess.
  return { dob: "", ambiguous: true };
}

export function formatDob(raw: string): string {
  return parseDob(raw).dob;
}

export function formatEmailDate(raw: string): string {
  if (!raw) return "";
  const d = new Date(raw);
  if (!isNaN(d.getTime())) {
    return d.toISOString().slice(0, 10);
  }
  return formatDob(raw);
}

export function detectProvince(
  text: string,
  opts: { abbrev?: "any" | "upperOnly" | "none" } = {},
): string {
  const abbrevMode = opts.abbrev ?? "upperOnly";
  // Pass 1 — full province names (case-insensitive, longest first).
  const lower = ` ${text.toLowerCase()} `;
  for (const key of [...PROVINCE_NAMES].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`[\\s,]${key.replace(/ /g, "\\s+")}[\\s,.]`, "i");
    if (re.test(lower)) return PROVINCES[key];
  }
  // Pass 2 — 2-letter abbreviations. In free text these are only trusted when
  // UPPERCASE, so the common word "on" never resolves to Ontario.
  if (abbrevMode !== "none") {
    const upperOnly = abbrevMode === "upperOnly";
    const hay = upperOnly ? ` ${text} ` : ` ${text.toLowerCase()} `;
    for (const ab of PROVINCE_ABBREVS) {
      const token = upperOnly ? ab.toUpperCase() : ab;
      const re = new RegExp(`[\\s,(]${token}[\\s,.)]`, upperOnly ? "" : "i");
      if (re.test(hay)) return PROVINCES[ab];
    }
  }
  return "";
}

export function guessGender(first: string): "M" | "F" | "U" {
  // First token, letters only (e.g. "Mary-Anne" -> "mary").
  const n = first.toLowerCase().match(/[a-z]+/)?.[0] ?? "";
  if (!n) return "U"; // truly no name -> the record goes to manual review anyway
  if (FEMALE.has(n)) return "F";
  if (MALE.has(n)) return "M";
  // Names not in the lists: make a best guess from the ending and never leave
  // it "Undefined" (the email never states gender, so the app must decide).
  // Female-leaning endings.
  if (
    /(?:a|ah|ia|ya|ie|ee|elle|ette|lyn|lynn|ynn|ina|ena|ella|anna|enna|issa|essa|een|ique|rine|leen)$/.test(n)
  ) {
    return "F";
  }
  // Male-leaning endings.
  if (/(?:o|us|os|as|um|son|ton|don|win|ius|rew|aan|eed)$/.test(n)) return "M";
  // Final tie-break: a vowel ending leans female, a consonant leans male.
  return /[eiy]$/.test(n) ? "F" : "M";
}

export function initials(first: string, last: string): string {
  return `${(first[0] ?? "").toUpperCase()}${(last[0] ?? "").toUpperCase()}`;
}

export function classify(subject: string): Assessment {
  const s = subject.toLowerCase();
  // Therapist-supported (both clinics). Checked first so "assessment" in the
  // private patterns below can't capture a therapist-supported subject.
  //   Adult ADHD Centre:        "... Therapist-Supported ADHD Assessment"
  //   ADHD Centre for Women:    "New submission from Therapist Supported ADHD Assessment"
  if (s.includes("therapist-supported") || s.includes("therapist supported")) return "therapist";
  // Regular / private (both clinics).
  //   Adult ADHD Centre:        "New Assessment Request ..."
  //   ADHD Centre for Women:    "New submission from Private ADHD Assessment"
  if (
    s.includes("new assessment request") ||
    s.includes("assessment request") ||
    s.includes("private adhd assessment") ||
    s.includes("new submission from private")
  ) {
    return "private";
  }
  return null;
}

export function extractFromEmail(raw: string): Extracted {
  const text = raw.replace(/\r\n/g, "\n");

  const subject =
    grab(/^Subject:\s*(.+)$/im, text) ||
    grab(/\n\s*Subject:\s*(.+)/i, text);

  const emailDateRaw =
    grab(/^Date:\s*(.+)$/im, text) ||
    grab(/^Sent:\s*(.+)$/im, text) ||
    grab(/^Received:\s*(.+)$/im, text);

  // Patient email — prefer a labelled address, else the first non-clinic email
  // in the body. Clinic / no-reply / role addresses are never used, and we never
  // fall back to a guess: if nothing qualifies, email stays blank (→ Manual
  // Review) rather than risk searching OSCAR with the wrong address.
  const labelledEmail = grab(
    /(?:patient\s*email|client\s*email|email\s*address|email)\s*[:\-]\s*([^\s,<>]+@[^\s,<>]+)/i,
    text,
  );
  let email = "";
  if (labelledEmail && !isNonPatientEmail(labelledEmail)) {
    email = labelledEmail;
  } else {
    const all = text.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) ?? [];
    email = all.find((e) => !isNonPatientEmail(e)) ?? "";
  }

  const phoneRaw =
    grab(/(?:phone|tel|telephone|mobile|cell)\s*(?:number)?\s*[:\-]\s*([+\d().\s-]{7,})/i, text) ||
    grab(/(\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/i, text);

  // The value must start with a digit (real DOBs do) so a "born" / "dob"
  // substring inside an address word (e.g. "Osborne") can't capture address text.
  const dobRaw =
    grab(/(?:date\s*of\s*birth|d\.?o\.?b\.?|birth\s*date|\bborn\b)\s*[:\-]?\s*(\d[\d/.\- ]{5,13})/i, text);

  const paymentId =
    grab(/(?:transaction\s*id|payment\s*id|payment\s*reference|order\s*(?:id|number|no\.?)|invoice\s*(?:id|number)|reference\s*(?:id|number)?)\s*[:#\-]\s*([A-Za-z0-9_\-]{4,})/i, text) ||
    // PayPal-style: the label sits on its own line, the ID on the next line.
    // Require a digit in the value so a following word can't be captured.
    grab(
      /(?:payment\s*id|transaction\s*id|payment\s*reference|reference\s*(?:id|number)?)\s*\n\s*((?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{6,})/i,
      text,
    );

  // Name — try "Name:" labels, fall back to subject.
  let first = grab(/(?:first\s*name|given\s*name)\s*[:\-]\s*([A-Za-z' \-]+)/i, text);
  let last = grab(/(?:last\s*name|surname|family\s*name)\s*[:\-]\s*([A-Za-z' \-]+)/i, text);
  if (!first || !last) {
    const full =
      // Inline "Name: value". Horizontal-space-only inside the label so it can't
      // span lines (e.g. "...same as Patient" + "Name" two lines down).
      grab(/(?:patient[ \t]*name|client[ \t]*name|full[ \t]*name|\bname)[ \t]*[:\-][ \t]*([A-Za-z'\- ]{3,60})/i, text) ||
      // Label on its own line, value on the next line. The FIRST match wins,
      // which is the Patient Information section (always before any Billing /
      // Payer section), so a payer's name is never used as the patient's.
      grab(
        /(?:patient[ \t]*legal[ \t]*name|legal[ \t]*name|patient[ \t]*name|full[ \t]*name|\bname)[ \t]*[:\-]?[ \t]*\r?\n[ \t]*([A-Za-z][A-Za-z'.\- ]{2,60})/i,
        text,
      ) ||
      nameFromSubject(subject);
    if (full) {
      const parts = full.trim().split(/\s+/);
      if (!first) first = parts[0] ?? "";
      if (!last) last = parts.slice(1).join(" ");
    }
  }

  const address = extractAddress(text);

  // Province is resolved independently of address formatting: a labelled
  // "Province:" wins, then the parsed address, then the whole email (full names
  // anywhere; abbreviations only when UPPERCASE to avoid matching the word "on").
  const provinceLabelled = grab(/(?:province|prov)\s*[:\-]\s*([A-Za-z][A-Za-z .]+)/i, text);
  let province = provinceLabelled ? detectProvince(provinceLabelled, { abbrev: "any" }) : "";
  if (!province && address) province = detectProvince(address, { abbrev: "any" });
  if (!province) province = detectProvince(text, { abbrev: "upperOnly" });

  const assessment = classify(subject);
  // ADHD Centre for Women orders: identified by their distinct subject
  // ("New submission from ...") or the sending clinic.
  const womensClinic =
    /new\s*submission\s*from/i.test(subject) ||
    /adhd\s*centre\s*for\s*women|support\s*for\s*adhd\s*women|adhdcentreforwomen/i.test(text);
  const phone = formatPhone(phoneRaw);
  const { dob, ambiguous: dobAmbiguous } = parseDob(dobRaw);
  const emailDate = formatEmailDate(emailDateRaw);
  const gender = guessGender(first);

  const missing: string[] = [];
  if (!first) missing.push("First Name");
  if (!last) missing.push("Last Name");
  if (!email) missing.push("Email");
  if (!phone) missing.push("Phone");
  if (!dob) missing.push(dobRaw && dobAmbiguous ? "Date of Birth (ambiguous)" : "Date of Birth");
  if (!emailDate) missing.push("Email Date");
  if (!assessment) missing.push("Assessment Type");

  return {
    firstName: first.trim(),
    lastName: last.trim(),
    email: email.trim(),
    phone,
    address: address.trim(),
    province,
    dob,
    paymentId: paymentId.trim(),
    emailDate,
    subject: subject.trim(),
    assessment,
    gender,
    womensClinic,
    dobAmbiguous: Boolean(dobRaw && dobAmbiguous),
    missing,
  };
}

export function buildSheetRow(e: Extracted, demographicNo: string): string[] {
  const row = new Array(17).fill(""); // A..Q
  row[4] = e.emailDate; // E
  row[5] = e.paymentId; // F
  row[6] = initials(e.firstName, e.lastName); // G
  row[7] = demographicNo; // H
  row[9] = e.assessment === "therapist" ? "Requested" : ""; // J
  row[10] = e.emailDate; // K
  row[11] = e.emailDate; // L
  row[16] = e.province; // Q
  return row;
}

export function bookingAlert(a: Assessment): string {
  if (a === "private") return "Private ADHD";
  if (a === "therapist") return "Therapist-Supported ADHD Assessment";
  return "";
}