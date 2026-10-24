// Evaluation for lib/pii.ts (regex + checksum pattern match; not a classifier).
//
//   node --experimental-strip-types frontend/scripts/pii_eval.ts
//   node --experimental-strip-types frontend/scripts/pii_eval.ts --ai4privacy path.jsonl
//
// Erasable TypeScript only. No network, nothing downloaded. The corpus is
// invented values (scripts/pii_synthetic_in.json).
import { readFileSync } from "node:fs";
// @ts-expect-error node's strip-types needs the explicit .ts extension; tsc does not allow it here
import { scanForPii } from "../lib/pii.ts";

interface Span {
  category: string;
  start: number;
  end: number;
}
interface Entry {
  text: string;
  spans: Span[];
}

const key = (s: Span) => `${s.category}:${s.start}:${s.end}`;
const run = (text: string, checksums: boolean): Span[] =>
  scanForPii(text, new Set(), { checksums }).map((f: Span) => ({
    category: f.category,
    start: f.start,
    end: f.end,
  }));

function score(entries: Entry[], checksums: boolean, only?: Set<string>) {
  const cats: Record<string, { tp: number; fp: number; fn: number }> = {};
  const c = (n: string) => (cats[n] ??= { tp: 0, fp: 0, fn: 0 });
  for (const e of entries) {
    const got = run(e.text, checksums).filter((s) => !only || only.has(s.category));
    const want = e.spans.filter((s) => !only || only.has(s.category));
    const gotKeys = new Set(got.map(key));
    const wantKeys = new Set(want.map(key));
    for (const s of got) {
      if (wantKeys.has(key(s))) c(s.category).tp++;
      else c(s.category).fp++;
    }
    for (const s of want) if (!gotKeys.has(key(s))) c(s.category).fn++;
  }
  return cats;
}

const pct = (x: number) => (x * 100).toFixed(1).padStart(5);
function table(entries: Entry[], checksums: boolean, only?: Set<string>) {
  const cats = score(entries, checksums, only);
  console.log("category   |    P |    R |   F1 |  TP |  FP |  FN");
  for (const n of Object.keys(cats).sort()) {
    const { tp, fp, fn } = cats[n];
    const p = tp + fp ? tp / (tp + fp) : 1;
    const r = tp + fn ? tp / (tp + fn) : 1;
    const f = p + r ? (2 * p * r) / (p + r) : 0;
    console.log(
      `${n.padEnd(10)} | ${pct(p)} | ${pct(r)} | ${pct(f)} | ${String(tp).padStart(3)} | ${String(fp).padStart(3)} | ${String(fn).padStart(3)}`,
    );
  }
}

const argIdx = process.argv.indexOf("--ai4privacy");
if (argIdx > 0) {
  // ai4privacy: one JSON object per line, privacy_mask [{label,start,end}] or
  // span_labels [[start,end,label]]. Labels outside this map are ignored.
  const MAP: Record<string, string> = {
    CREDITCARDNUMBER: "card",
    EMAIL: "contact",
    SSN: "gov_id",
    PASSWORD: "credential",
  };
  const entries: Entry[] = readFileSync(process.argv[argIdx + 1], "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const o = JSON.parse(line);
      const raw: { label: string; start: number; end: number }[] =
        o.privacy_mask ??
        (o.span_labels ?? []).map((a: [number, number, string]) => ({ start: a[0], end: a[1], label: a[2] }));
      return {
        text: o.source_text ?? o.text,
        spans: raw
          .filter((s) => MAP[s.label])
          .map((s) => ({ category: MAP[s.label], start: s.start, end: s.end })),
      };
    });
  console.log(`ai4privacy: ${entries.length} rows (mapped labels only: ${Object.keys(MAP).join(", ")})`);
  table(entries, true, new Set(Object.values(MAP)));
} else {
  const entries: Entry[] = JSON.parse(
    readFileSync(new URL("./pii_synthetic_in.json", import.meta.url), "utf8"),
  );
  const negatives = entries.filter((e) => e.spans.length === 0);
  console.log(`Synthetic corpus: ${entries.length} entries, ${negatives.length} hard negatives\n`);
  console.log("Per-category, checksums ON (exact span match):");
  table(entries, true);
  console.log("\nPer-category, checksums OFF:");
  table(entries, false);

  const fpRate = (checksums: boolean) =>
    negatives.filter((e) => run(e.text, checksums).length > 0).length / negatives.length;
  console.log("\nAblation: hard negatives with at least one finding");
  console.log("checksums | FP rate");
  console.log(`on        | ${pct(fpRate(true))}%`);
  console.log(`off       | ${pct(fpRate(false))}%`);

  console.log("\nScan latency (median of 50 runs, checksums on):");
  const unit = entries.map((e) => e.text).join(" ");
  for (const n of [1000, 5000, 10000]) {
    const text = unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
    const t: number[] = [];
    for (let i = 0; i < 50; i++) {
      const s = performance.now();
      scanForPii(text);
      t.push(performance.now() - s);
    }
    t.sort((a, b) => a - b);
    console.log(`${String(n).padStart(6)} chars | ${t[25].toFixed(2)} ms`);
  }
}
