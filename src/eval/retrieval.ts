// Planted track: 12 JDs with planted true fits (worded differently), keyword-stuffers and tier-3 gems.
// Two query strategies: (a) raw JD text, (b) requirement-split (one query per must-have / nice-to-have, mean cosine),
// which is how the agent searches. Both vs BM25. Metrics: precision@5, recall@10, nDCG@5. No LLM calls.
import { readFileSync } from "node:fs";
import { embedTexts, QUERY_PREFIX } from "../lib/embed";
import { memorySearch, loadMemory, memVector, dot } from "../lib/db";
import { BM25 } from "../lib/bm25";

interface Scored { top10: string[]; p5: number; r10: number; ndcg5: number; stuffersInTop5: number; gemsInTop5: number }
export interface RetrievalCase {
  jdId: string;
  title: string;
  relevant: string[];
  stuffers: string[];
  hiddenGems: string[];
  semantic: Scored;
  semanticSplit: Scored;
  bm25: Scored;
  judged: { semantic: Scored; semanticSplit: Scored; bm25: Scored }; // ranking restricted to the 180 judged (planted) candidates
}

function metrics(ranked: string[], relevant: Set<string>, stuffers: Set<string>, gems: Set<string>): Scored {
  const top5 = ranked.slice(0, 5);
  const top10 = ranked.slice(0, 10);
  const p5 = top5.filter((id) => relevant.has(id)).length / 5;
  const r10 = top10.filter((id) => relevant.has(id)).length / Math.max(1, relevant.size);
  let dcg = 0;
  top5.forEach((id, i) => { if (relevant.has(id)) dcg += 1 / Math.log2(i + 2); });
  let idcg = 0;
  for (let i = 0; i < Math.min(5, relevant.size); i++) idcg += 1 / Math.log2(i + 2);
  return { top10, p5: +p5.toFixed(3), r10: +r10.toFixed(3), ndcg5: +(idcg ? dcg / idcg : 0).toFixed(3), stuffersInTop5: top5.filter((id) => stuffers.has(id)).length, gemsInTop5: top5.filter((id) => gems.has(id)).length };
}

// Requirement-split scoring: embed each requirement as its own query, score every candidate by the mean cosine
// across requirements (coverage), with must-haves weighted double.
export function requirementSplitRank(reqVecs: { vec: ArrayLike<number>; weight: number }[], mode: "visible" | "redacted", k: number, filter?: (id: string) => boolean): { id: string; score: number }[] {
  const { candidates } = loadMemory();
  const W = reqVecs.reduce((s, r) => s + r.weight, 0);
  const out: { id: string; score: number }[] = [];
  for (const c of candidates) {
    if (filter && !filter(c.id)) continue;
    const v = memVector(c.id, mode)!;
    let s = 0;
    for (const r of reqVecs) s += r.weight * dot(r.vec, v);
    out.push({ id: c.id, score: s / W });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, k);
}

export async function runRetrievalEval(): Promise<{ cases: RetrievalCase[]; summary: Record<string, number> }> {
  const { jds } = JSON.parse(readFileSync("data/jds.json", "utf8"));
  const { labels } = JSON.parse(readFileSync("data/eval-labels.json", "utf8"));
  const { candidates } = loadMemory();
  const judged = new Set(candidates.filter((c) => c.source === "planted").map((c) => c.id));
  const bm25 = new BM25(candidates.map((c) => ({ id: c.id, text: c.visible_text })));
  const bm25Judged = new BM25(candidates.filter((c) => judged.has(c.id)).map((c) => ({ id: c.id, text: c.visible_text })));

  const cases: RetrievalCase[] = [];
  for (const jd of jds) {
    const lab = labels[jd.id];
    const rel = new Set<string>(lab.trueFits);
    const stuf = new Set<string>(lab.stuffers);
    const gems = new Set<string>(lab.hiddenGems);
    const reqs = [...jd.mustHave.map((r: string) => ({ text: `${jd.title}: experience with ${r}`, weight: 2 })), ...jd.niceToHave.map((r: string) => ({ text: `${jd.title}: experience with ${r}`, weight: 1 }))];
    const vecs = await embedTexts([QUERY_PREFIX + jd.text, ...reqs.map((r) => QUERY_PREFIX + r.text)]);
    const reqVecs = reqs.map((r, i) => ({ vec: vecs[i + 1], weight: r.weight }));
    const sem = memorySearch(vecs[0], "visible", 10).map((h) => h.id);
    const split = requirementSplitRank(reqVecs, "visible", 10).map((h) => h.id);
    const kw = bm25.search(jd.text, 10).map((h) => h.id);
    const semJ = memorySearch(vecs[0], "visible", 10, (c) => judged.has(c.id)).map((h) => h.id);
    const splitJ = requirementSplitRank(reqVecs, "visible", 10, (id) => judged.has(id)).map((h) => h.id);
    const kwJ = bm25Judged.search(jd.text, 10).map((h) => h.id);
    cases.push({
      jdId: jd.id, title: jd.title, relevant: lab.trueFits, stuffers: lab.stuffers, hiddenGems: lab.hiddenGems,
      semantic: metrics(sem, rel, stuf, gems), semanticSplit: metrics(split, rel, stuf, gems), bm25: metrics(kw, rel, stuf, gems),
      judged: { semantic: metrics(semJ, rel, stuf, gems), semanticSplit: metrics(splitJ, rel, stuf, gems), bm25: metrics(kwJ, rel, stuf, gems) },
    });
  }
  const mean = (f: (c: RetrievalCase) => number) => +(cases.reduce((s, c) => s + f(c), 0) / cases.length).toFixed(3);
  const summary: Record<string, number> = {};
  for (const k of ["semantic", "semanticSplit", "bm25"] as const) {
    summary[`${k}_p5`] = mean((c) => c[k].p5);
    summary[`${k}_r10`] = mean((c) => c[k].r10);
    summary[`${k}_ndcg5`] = mean((c) => c[k].ndcg5);
    summary[`${k}_stuffers_top5`] = mean((c) => c[k].stuffersInTop5);
    summary[`${k}_gems_top5`] = mean((c) => c[k].gemsInTop5);
  }
  for (const k of ["semantic", "semanticSplit", "bm25"] as const) {
    summary[`judged_${k}_p5`] = mean((c) => c.judged[k].p5);
    summary[`judged_${k}_r10`] = mean((c) => c.judged[k].r10);
    summary[`judged_${k}_ndcg5`] = mean((c) => c.judged[k].ndcg5);
    summary[`judged_${k}_stuffers_top5`] = mean((c) => c.judged[k].stuffersInTop5);
    summary[`judged_${k}_gems_top5`] = mean((c) => c.judged[k].gemsInTop5);
  }
  summary.poolSize = candidates.length;
  summary.judgedSize = judged.size;
  return { cases, summary };
}
