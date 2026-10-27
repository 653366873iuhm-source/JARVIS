/**
 * Near-duplicate detection for promotion posts (anti copy-paste / coordinated spam).
 * normalise -> character 3-gram shingles -> Jaccard similarity. Cheap, language-agnostic (works for Chinese text,
 * where word tokenisation would need a segmenter).
 */
export function normalizePostText(text: string, strip: string[] = []): string {
  let t = text.toLowerCase();
  for (const s of strip) if (s) t = t.split(s.toLowerCase()).join(" ");
  t = t
    .replace(/https?:\/\/\S+/g, " ") // urls
    .replace(/[@#$][\p{L}\p{N}_]+/gu, " ") // mentions, hashtags, cashtags
    .replace(/[^\p{L}\p{N}]+/gu, " ") // punctuation / emoji
    .replace(/\s+/g, " ")
    .trim();
  return t;
}

export function shingles(t: string, k = 3): Set<string> {
  const s = new Set<string>();
  const compact = t.replace(/\s+/g, " ");
  if (compact.length <= k) {
    if (compact) s.add(compact);
    return s;
  }
  for (let i = 0; i + k <= compact.length; i++) s.add(compact.slice(i, i + k));
  return s;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export function similarity(a: string, b: string): number {
  return jaccard(shingles(a), shingles(b));
}
