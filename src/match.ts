/** Fuzzy matching of spoken names ("tide pool", "the orbit one") against known names. */

export function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const sub = (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      row.push(Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, sub));
    }
    prev = row;
  }
  return prev[b.length] ?? 0;
}

/**
 * How well `text` mentions `alias` (0..1). Whole-phrase hits score 1, a single
 * near-miss word (STT typo) scores 0.75, joined words ("tempo morph" for
 * "tidepool") score 0.9.
 */
export function mentionScore(text: string, alias: string): number {
  const t = words(text);
  const a = words(alias);
  if (!a.length || !t.length) return 0;
  const joined = t.join(" ");
  const aj = a.join(" ");
  if ((" " + joined + " ").includes(" " + aj + " ")) return 1;
  const squashed = aj.replace(/ /g, "");
  for (let n = 2; n <= 3; n++)
    for (let i = 0; i + n <= t.length; i++) if (t.slice(i, i + n).join("") === squashed) return 0.9;
  if (a.length === 1 && squashed.length >= 5) {
    const tol = squashed.length >= 8 ? 2 : 1;
    if (t.some((w) => Math.abs(w.length - squashed.length) <= tol && levenshtein(w, squashed) <= tol)) return 0.75;
  }
  // Long session names ("Lidar input and camera"): people say part of them.
  if (a.length >= 3) {
    const key = a.filter((w) => w.length >= 4 && !STOP.has(w));
    const hits = key.filter((w) => t.includes(w)).length;
    if (hits >= 2 || (hits === 1 && key.length <= 2)) return 0.8;
  }
  return 0;
}

const STOP = new Set([
  "with",
  "from",
  "into",
  "that",
  "this",
  "then",
  "when",
  "make",
  "work",
  "update",
  "check",
  "session",
  "about",
]);

export interface Ranked<T> {
  item: T;
  score: number;
}

/** Best matches for `text` among items, each with its own aliases. */
export function rank<T>(text: string, items: T[], aliases: (t: T) => string[], min = 0.7): Ranked<T>[] {
  return items
    .map((item) => ({ item, score: Math.max(0, ...aliases(item).map((a) => mentionScore(text, a))) }))
    .filter((r) => r.score >= min)
    .sort((x, y) => y.score - x.score);
}
