// Pre-send PII detection. Client-side, always.
//
// CLAUDE.md hard rule: nothing goes to the LLM before the user has consented to
// send. Sending text to a hosted model to ask whether it is safe to send defeats
// the point, and it is checkable from the network tab — so this file has no
// network access of any kind and never will. Everything here is regex + Luhn.
//
// PHASES.md P7 asks for this to be *provably* local. It is: this module imports
// nothing, and the only way to falsify that claim is to add an import.
//
// Honest naming, per CLAUDE.md: this is a regex + checksum MVP. It is not a PII
// classifier. It will miss unstructured disclosures and it will fire on a
// sixteen-digit order number that happens to pass Luhn. Both are stated in the
// copy the user sees rather than papered over.

export type PiiTier = "irreversible" | "sensitive";

export type PiiCategory =
  | "card"
  | "credential"
  | "gov_id"
  | "aadhaar"
  | "pan"
  | "upi"
  | "ifsc"
  | "health"
  | "address"
  | "contact";

export interface PiiFinding {
  category: PiiCategory;
  /** §4.3 tiers the intervention. Friction is proportional to irreversibility,
   *  not to sensitivity (CLAUDE.md principle 3): a card number is a modal, a
   *  health disclosure is an inline strip you can ignore. */
  tier: PiiTier;
  /** The matched span, kept so the redaction is exact rather than a re-run. */
  match: string;
  start: number;
  end: number;
  /** What happens, not whether the user should feel bad (principle 5). */
  consequence: string;
  /** What "Redact & send" would substitute. */
  redaction: string;
}

interface Rule {
  category: PiiCategory;
  tier: PiiTier;
  pattern: RegExp;
  consequence: string;
  redaction: string;
  /** Extra check beyond the pattern. Luhn or Verhoeff. Skipped when a scan
   *  runs with `checksums: false` (the evaluation ablation only). */
  validate?: (m: string) => boolean;
}

export interface ScanOptions {
  /** Default true. False skips Luhn and Verhoeff so the evaluation can measure
   *  what the checksums buy. The product never sets it. */
  checksums?: boolean;
}

// ---------------------------------------------------------------- Luhn

/** Standard mod-10 checksum. Cuts the card-number false-positive rate hard
 *  enough to be worth the twelve lines; does not make the detector clever. */
export function luhn(digits: string): boolean {
  const d = digits.replace(/\D/g, "");
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

// ------------------------------------------------------------- Verhoeff

const V_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const V_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/** Verhoeff check: the last digit of an Aadhaar number is its check digit. */
export function verhoeff(digits: string): boolean {
  const d = digits.replace(/\D/g, "");
  if (!d.length) return false;
  let c = 0;
  for (let i = 0; i < d.length; i++) {
    c = V_D[c][V_P[i % 8][d.charCodeAt(d.length - 1 - i) - 48]];
  }
  return c === 0;
}

const validAadhaar = (m: string) => {
  const d = m.replace(/\D/g, "");
  return d.length === 12 && d[0] >= "2" && verhoeff(d);
};

// ---------------------------------------------------------------- rules
//
// Tier assignment is the design decision here, not the patterns.
//
// irreversible — the disclosure cannot be walked back once it is in a
//   transcript, and the cost of being wrong is unbounded. Hard interruption.
// sensitive — legitimately shared, often the whole point of the message.
//   Sends freely; handled at the storage layer with a session-only default.

const RULES: Rule[] = [
  {
    category: "card",
    tier: "irreversible",
    // 13–19 digits, optionally grouped. Luhn does the actual work.
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    validate: luhn,
    consequence: "Card numbers stay in this chat's history.",
    redaction: "[card number removed]",
  },
  {
    category: "credential",
    tier: "irreversible",
    // Live-secret shapes: API keys, bearer tokens, and "password: ..." forms.
    pattern:
      /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|(?:password|passwd|api[_ -]?key|secret|token)\s*[:=]\s*\S{6,})/gi,
    consequence: "Keys and passwords stay in this chat's history.",
    redaction: "[credential removed]",
  },
  {
    category: "gov_id",
    tier: "irreversible",
    // Format check only: US SSN. Indian IDs have their own rules below.
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    consequence: "Government ID numbers stay in this chat's history.",
    redaction: "[ID number removed]",
  },
  {
    category: "aadhaar",
    tier: "irreversible",
    // 12 digits, first 2-9, optionally grouped 4-4-4; Verhoeff does the rest.
    pattern: /(?<![\d-])[2-9]\d{3}([ -]?)\d{4}\1\d{4}(?![\d-])/g,
    validate: validAadhaar,
    consequence: "Aadhaar numbers stay in this chat's history.",
    redaction: "[Aadhaar number removed]",
  },
  {
    category: "pan",
    tier: "irreversible",
    pattern: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g,
    consequence: "PAN numbers stay in this chat's history.",
    redaction: "[PAN removed]",
  },
  {
    category: "upi",
    tier: "sensitive",
    // name@psp with no dot-TLD after the @ part, which is what makes it not an
    // email. Pattern only, so a bare "foo@bar" is flagged too.
    pattern: /\b[\w.-]{2,}@[a-z][a-z0-9]{1,20}\b(?!\.[a-z0-9])/gi,
    consequence:
      "UPI handles will be saved to memory unless you keep them to this session.",
    redaction: "[UPI handle removed]",
  },
  {
    category: "ifsc",
    tier: "sensitive",
    pattern: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g,
    consequence:
      "Bank branch codes will be saved to memory unless you keep them to this session.",
    redaction: "[IFSC removed]",
  },
  {
    category: "health",
    tier: "sensitive",
    // Dosage and diagnosis shapes. Broad on purpose: this tier costs a dismissible
    // strip, so a false positive costs a glance.
    pattern:
      /\b(?:\d+\s?(?:mg|mcg|ml|iu)\b|diagnos(?:ed|is)|prescrib(?:ed|ption)|therapy|antidepressant|dosage)\b/gi,
    consequence:
      "Health details will be saved to memory unless you keep them to this session.",
    redaction: "[health detail removed]",
  },
  {
    category: "address",
    tier: "sensitive",
    pattern:
      /\b\d{1,5}\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Drive|Dr|Boulevard|Blvd)\b/g,
    consequence: "Your address will be saved to memory unless you scope it.",
    redaction: "[address removed]",
  },
  {
    category: "contact",
    tier: "sensitive",
    pattern: /\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/g,
    consequence: "Email addresses will be saved to memory unless you scope them.",
    redaction: "[email removed]",
  },
];

export const CATEGORY_LABEL: Record<PiiCategory, string> = {
  card: "card number",
  credential: "credential",
  gov_id: "ID number",
  aadhaar: "Aadhaar number",
  pan: "PAN number",
  upi: "UPI handle",
  ifsc: "bank branch (IFSC) code",
  health: "health detail",
  address: "address",
  contact: "email address",
};

/**
 * Scan text for structured PII. Pure, synchronous, no I/O.
 *
 * `dismissedCategories` implements CLAUDE.md principle 4 and §4.3's last bullet:
 * a category the user has already waved through stays silent for the rest of the
 * session. Habituation kills warning systems, so the system stops warning rather
 * than training the user to stop reading.
 */
export function scanForPii(
  text: string,
  dismissedCategories: ReadonlySet<PiiCategory> = new Set(),
  options: ScanOptions = {},
): PiiFinding[] {
  const checksums = options.checksums !== false;
  const findings: PiiFinding[] = [];

  for (const rule of RULES) {
    if (dismissedCategories.has(rule.category)) continue;
    // Fresh regex per scan: the source rules carry /g, and a shared lastIndex
    // across calls silently skips matches on every other keystroke.
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      if (checksums && rule.validate && !rule.validate(m[0])) continue;
      findings.push({
        category: rule.category,
        tier: rule.tier,
        match: m[0],
        start: m.index,
        end: m.index + m[0].length,
        consequence: rule.consequence,
        redaction: rule.redaction,
      });
    }
  }

  // Overlaps resolve toward the more restrictive tier — a token that also parses
  // as an email is a credential first (asymmetric error costs, principle 1).
  findings.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: PiiFinding[] = [];
  for (const f of findings) {
    const clash = kept.find((k) => f.start < k.end && k.start < f.end);
    if (!clash) {
      kept.push(f);
    } else if (clash.tier === "sensitive" && f.tier === "irreversible") {
      kept[kept.indexOf(clash)] = f;
    }
  }
  return kept;
}

/** Apply every finding's redaction. Right-to-left so earlier offsets stay valid. */
export function redact(text: string, findings: PiiFinding[]): string {
  return [...findings]
    .sort((a, b) => b.start - a.start)
    .reduce(
      (acc, f) => acc.slice(0, f.start) + f.redaction + acc.slice(f.end),
      text,
    );
}

export const worstTier = (findings: PiiFinding[]): PiiTier | null =>
  findings.some((f) => f.tier === "irreversible")
    ? "irreversible"
    : findings.length
      ? "sensitive"
      : null;
