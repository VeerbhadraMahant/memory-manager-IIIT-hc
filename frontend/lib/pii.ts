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
  /** Extra check beyond the pattern. Luhn, mostly. */
  validate?: (m: string) => boolean;
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
    // Format checks only, per SYSTEM_DESIGN §3: US SSN and Indian Aadhaar/PAN.
    pattern:
      /\b(?:\d{3}-\d{2}-\d{4}|[2-9]\d{3}\s?\d{4}\s?\d{4}|[A-Z]{5}\d{4}[A-Z])\b/g,
    consequence: "Government ID numbers stay in this chat's history.",
    redaction: "[ID number removed]",
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
): PiiFinding[] {
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
      if (rule.validate && !rule.validate(m[0])) continue;
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
