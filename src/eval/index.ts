// `bun run eval` → eval/results.json. Sections are added as they land: retrieval, guardrails, fairness.
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { runRetrievalEval } from "./retrieval";

const only = process.argv[2]; // "retrieval" | "guardrails" | "fairness" | undefined (all)
mkdirSync("eval", { recursive: true });
const prev = existsSync("eval/results.json") ? JSON.parse(readFileSync("eval/results.json", "utf8")) : {};
const results: any = { ...prev, generatedAt: new Date().toISOString() };

if (!only || only === "retrieval") {
  const t0 = Date.now();
  results.retrieval = await runRetrievalEval();
  results.retrieval.elapsedMs = Date.now() - t0;
  const s = results.retrieval.summary;
  console.log(`retrieval: semantic nDCG@5=${s.semantic_ndcg5} P@5=${s.semantic_p5} R@10=${s.semantic_r10} | bm25 nDCG@5=${s.bm25_ndcg5} P@5=${s.bm25_p5} R@10=${s.bm25_r10}`);
  console.log(`keyword-stuffers in top5 (mean): semantic ${s.semantic_stuffers_top5} vs bm25 ${s.bm25_stuffers_top5}; tier-3 gems in top5: semantic ${s.semantic_gems_top5} vs bm25 ${s.bm25_gems_top5}`);
}

if (!only || only === "guardrails") {
  try {
    const { runGuardrailEval } = await import("./guardrails");
    results.guardrails = await runGuardrailEval();
    const pass = results.guardrails.cases.filter((c: any) => c.pass).length;
    console.log(`guardrails: ${pass}/${results.guardrails.cases.length} pass`);
  } catch (e: any) {
    if (!/Cannot find module|not found/i.test(String(e?.message))) throw e;
  }
}

if (!only || only === "fairness") {
  try {
    const { runFairnessEval } = await import("./fairness");
    results.fairness = await runFairnessEval();
    console.log(`fairness: mean spearman=${results.fairness.summary.meanSpearman} mean top5 overlap=${results.fairness.summary.meanTop5Overlap}`);
  } catch (e: any) {
    if (!/Cannot find module|not found/i.test(String(e?.message))) throw e;
  }
}

// One line for the stage.
const r = results.retrieval?.summary;
const g = results.guardrails ? `${results.guardrails.cases.filter((c: any) => c.pass).length}/${results.guardrails.cases.length} guardrails pass` : "";
const f = results.fairness ? `blind-ranking rho ${results.fairness.summary.meanSpearman}` : "";
results.headline = [r ? `Semantic nDCG@5 ${r.semantic_ndcg5} vs keyword ${r.bm25_ndcg5} across 12 JDs` : "", g, f].filter(Boolean).join(" · ");
writeFileSync("eval/results.json", JSON.stringify(results, null, 1));
console.log("HEADLINE: " + results.headline);
