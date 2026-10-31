// Small BM25 keyword baseline. Used only by the eval to show what keyword matching misses.

const STOP = new Set("a an the and or of to in on for with at by from is are was be as that this it we you our your will have has".split(" "));

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9+#.\s-]/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((t) => t.length > 1 && !STOP.has(t));
}

export class BM25 {
  private df = new Map<string, number>();
  private docs: { id: string; tf: Map<string, number>; len: number }[] = [];
  private avgLen = 0;
  constructor(docs: { id: string; text: string }[], private k1 = 1.2, private b = 0.75) {
    for (const d of docs) {
      const toks = tokenize(d.text);
      const tf = new Map<string, number>();
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.docs.push({ id: d.id, tf, len: toks.length });
    }
    this.avgLen = this.docs.reduce((s, d) => s + d.len, 0) / Math.max(1, this.docs.length);
  }
  search(query: string, k = 10): { id: string; score: number }[] {
    const q = tokenize(query);
    const N = this.docs.length;
    const out = this.docs.map((d) => {
      let s = 0;
      for (const t of q) {
        const f = d.tf.get(t);
        if (!f) continue;
        const n = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        s += idf * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * d.len) / this.avgLen)));
      }
      return { id: d.id, score: s };
    });
    return out.sort((a, b) => b.score - a.score).slice(0, k);
  }
}
