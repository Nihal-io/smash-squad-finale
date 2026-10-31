// Retrieval eval: 12 planted JDs, semantic (bge-small, in-memory over the same vectors) vs BM25 keyword baseline.
// No LLM calls. Metrics: precision@5, recall@10, nDCG@5.
import { readFileSync } from "node:fs";
import { embedQuery } from "../lib/embed";
import { memorySearch, loadMemory } from "../lib/db";
import { BM25 } from "../lib/bm25";

export interface RetrievalCase {
  jdId: string;
  title: string;
  relevant: string[];
  stuffers: string[];
  hiddenGems: string[];
  semantic: { top10: string[]; p5: number; r10: number; ndcg5: number; stuffersInTop5: number; gemsInTop5: number };
  bm25: { top10: string[]; p5: number; r10: number; ndcg5: number; stuffersInTop5: number; gemsInTop5: number };
}

function metrics(ranked: string[], relevant: Set<string>, stuffers: Set<string>, gems: Set<string>) {
  const top5 = ranked.slice(0, 5);
  const top10 = ranked.slice(0, 10);
  const p5 = top5.filter((id) => relevant.has(id)).length / 5;
  const r10 = top10.filter((id) => relevant.has(id)).length / Math.max(1, relevant.size);
  let dcg = 0;
  top5.forEach((id, i) => { if (relevant.has(id)) dcg += 1 / Math.log2(i + 2); });
  let idcg = 0;
  for (let i = 0; i < Math.min(5, relevant.size); i++) idcg += 1 / Math.log2(i + 2);
  return {
    top10,
    p5: +p5.toFixed(3),
    r10: +r10.toFixed(3),
    ndcg5: +(idcg ? dcg / idcg : 0).toFixed(3),
    stuffersInTop5: top5.filter((id) => stuffers.has(id)).length,
    gemsInTop5: top5.filter((id) => gems.has(id)).length,
  };
}

export async function runRetrievalEval(): Promise<{ cases: RetrievalCase[]; summary: Record<string, number> }> {
  const { jds } = JSON.parse(readFileSync("data/jds.json", "utf8"));
  const { labels } = JSON.parse(readFileSync("data/eval-labels.json", "utf8"));
  const { candidates } = loadMemory();
  const bm25 = new BM25(candidates.map((c) => ({ id: c.id, text: c.visible_text })));

  const cases: RetrievalCase[] = [];
  for (const jd of jds) {
    const lab = labels[jd.id];
    const rel = new Set<string>(lab.trueFits);
    const stuf = new Set<string>(lab.stuffers);
    const gems = new Set<string>(lab.hiddenGems);
    const qv = await embedQuery(jd.text);
    const sem = memorySearch(qv, "visible", 10).map((h) => h.id);
    const kw = bm25.search(jd.text, 10).map((h) => h.id);
    cases.push({
      jdId: jd.id,
      title: jd.title,
      relevant: lab.trueFits,
      stuffers: lab.stuffers,
      hiddenGems: lab.hiddenGems,
      semantic: metrics(sem, rel, stuf, gems),
      bm25: metrics(kw, rel, stuf, gems),
    });
  }
  const mean = (f: (c: RetrievalCase) => number) => +(cases.reduce((s, c) => s + f(c), 0) / cases.length).toFixed(3);
  const summary = {
    semantic_p5: mean((c) => c.semantic.p5),
    semantic_r10: mean((c) => c.semantic.r10),
    semantic_ndcg5: mean((c) => c.semantic.ndcg5),
    semantic_stuffers_top5: mean((c) => c.semantic.stuffersInTop5),
    semantic_gems_top5: mean((c) => c.semantic.gemsInTop5),
    bm25_p5: mean((c) => c.bm25.p5),
    bm25_r10: mean((c) => c.bm25.r10),
    bm25_ndcg5: mean((c) => c.bm25.ndcg5),
    bm25_stuffers_top5: mean((c) => c.bm25.stuffersInTop5),
    bm25_gems_top5: mean((c) => c.bm25.gemsInTop5),
  };
  return { cases, summary };
}
