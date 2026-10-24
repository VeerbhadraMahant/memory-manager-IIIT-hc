# D: PII (F5)

Pattern match plus checksum, client side only. It can be wrong in both directions and is not a classifier. `lib/pii.ts` still imports nothing and makes no network calls.

## What changed

- `frontend/lib/pii.ts`: new categories `aadhaar`, `pan`, `upi`, `ifsc`; `verhoeff()` next to `luhn()`; `scanForPii(text, dismissed, { checksums: false })` skips Luhn and Verhoeff for the ablation (default unchanged). The `gov_id` rule is now US SSN only, since Aadhaar and PAN moved to their own categories.
- Tiers (principle 3): Aadhaar and PAN irreversible (government IDs, like `gov_id`). UPI handle and IFSC sensitive (routing data, not a secret on its own; a dismissible strip, stored session-only by default).
- Labels (`CATEGORY_LABEL`): "Aadhaar number", "PAN number", "UPI handle", "bank branch (IFSC) code". Consequence copy follows the existing "stays in this chat's history" form.
- UPI vs email: UPI is `name@psp` with no dot-TLD after the `@` part; the email rule needs a dot, so they do not overlap.
- Only `Record<PiiCategory, string>` is `CATEGORY_LABEL`, inside `pii.ts`; callers index it and type-check unchanged.
- `frontend/scripts/pii_synthetic_in.json`: 123 invented entries (65 positives, 58 hard negatives). Aadhaar numbers were generated with a separate Verhoeff implementation, not the code under test. Cards use Luhn-valid numbers built on published test prefixes.
- `frontend/scripts/pii_eval.ts`: `node --experimental-strip-types frontend/scripts/pii_eval.ts` (Node 22.18). `--ai4privacy path.jsonl` evaluates an ai4privacy-format file on the labels that map to existing categories (card, email, SSN, password). Nothing is downloaded. Node prints a harmless `MODULE_TYPELESS_PACKAGE_JSON` warning; adding `"type": "module"` to `package.json` would silence it but is outside this file set. The import of `../lib/pii.ts` carries a `@ts-expect-error` because tsc does not allow the `.ts` extension under the current tsconfig.

## Results (synthetic corpus, exact span match)

```
Per-category, checksums ON:
category   |    P |    R |   F1 |  TP |  FP |  FN
aadhaar    |  92.9 | 100.0 |  96.3 |  13 |   1 |   0
card       | 100.0 | 100.0 | 100.0 |  13 |   0 |   0
contact    | 100.0 | 100.0 | 100.0 |  10 |   0 |   0
ifsc       | 100.0 | 100.0 | 100.0 |  11 |   0 |   0
pan        | 100.0 | 100.0 | 100.0 |  11 |   0 |   0
upi        | 100.0 | 100.0 | 100.0 |  12 |   0 |   0

Per-category, checksums OFF:
aadhaar    |  43.3 | 100.0 |  60.5 |  13 |  17 |   0
card       |  48.1 | 100.0 |  65.0 |  13 |  14 |   0
(contact, ifsc, pan, upi unchanged: 100 / 100 / 100)

Ablation: hard negatives with at least one finding (58 negatives)
checksums | FP rate
on        |   1.7%
off       |  53.4%

Scan latency (median of 50 runs, checksums on):
  1000 chars | 0.04 ms
  5000 chars | 0.14 ms
 10000 chars | 0.19 ms
```

The one remaining false positive is a random 12-digit order number that happens to pass Verhoeff (about 1 in 10 of such numbers do). A checksum cannot rule that out.

## Limits to state plainly

- The corpus is small, synthetic and written by the same author as the rules, so 100% recall and precision on most rows says the rules do what we wrote, not how they fare on real messages. The ai4privacy run is the outside check and needs the user to download the dataset.
- PAN and IFSC have no checksum; any 5 capitals + 4 digits + 1 capital string fires. Lowercase PANs and IFSCs are missed. UPI is pattern only, so a bare `word@word` fires, and a handle written with a trailing dot-word after the PSP is treated as an email.
- No hits does not mean no PII.

## Contract requests

None required. Optional: add `"type": "module"` to `frontend/package.json` to silence the Node warning.
