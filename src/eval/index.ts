// `bun run eval [track]` → eval/results.json. Tracks: public, planted, guardrails, fairness, agent, cascade.
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";

const only = process.argv[2];
const want = (t: string) => !only || only === t;
mkdirSync("eval", { recursive: true });
const prev = existsSync("eval/results.json") ? JSON.parse(readFileSync("eval/results.json", "utf8")) : {};
const results: any = { ...prev, generatedAt: new Date().toISOString() };

async function optional(track: string, mod: string, fn: string, after: (r: any) => void) {
  if (!want(track)) return;
  try {
    const m = await import(mod);
    const t0 = Date.now();
    results[track] = await m[fn]();
    results[track].elapsedMs = Date.now() - t0;
    after(results[track]);
  } catch (e: any) {
    if (/Cannot find module|not found|Could not resolve/i.test(String(e?.message))) console.log(`${track}: not implemented yet`);
    else throw e;
  }
}

await optional("public", "./public", "runPublicEval", (r) => {
  const s = r.summary;
  console.log(`public (${s.jobs} jobs, pool ${s.poolSize}): semantic R@10=${s.semantic_recall10} nDCG@10=${s.semantic_ndcg10} | bm25 R@10=${s.bm25_recall10} nDCG@10=${s.bm25_ndcg10} | hybrid R@10=${s.hybrid_recall10} nDCG@10=${s.hybrid_ndcg10}`);
  console.log(`  labels cover ${s.meanLabelledInPool} of ${s.meanQualifyingInPool} qualifying resumes per job; dataset-rule@10: semantic ${s.semantic_rule60at10} bm25 ${s.bm25_rule60at10} hybrid ${s.hybrid_rule60at10}`);
});
await optional("planted", "./retrieval", "runRetrievalEval", (r) => {
  const s = r.summary;
  console.log(`planted (12 JDs, pool ${s.poolSize}): raw-JD semantic nDCG@5=${s.semantic_ndcg5} P@5=${s.semantic_p5} R@10=${s.semantic_r10} | requirement-split nDCG@5=${s.semanticSplit_ndcg5} P@5=${s.semanticSplit_p5} R@10=${s.semanticSplit_r10} | bm25 nDCG@5=${s.bm25_ndcg5} P@5=${s.bm25_p5} R@10=${s.bm25_r10}`);
  console.log(`  stuffers in top5: raw ${s.semantic_stuffers_top5} split ${s.semanticSplit_stuffers_top5} bm25 ${s.bm25_stuffers_top5} | tier-3 gems in top5: raw ${s.semantic_gems_top5} split ${s.semanticSplit_gems_top5} bm25 ${s.bm25_gems_top5}`);
  console.log(`  full pool hybrid: nDCG@5=${s.hybrid_ndcg5} P@5=${s.hybrid_p5} R@10=${s.hybrid_r10}`);
  console.log(`  judged-only (${s.judgedSize}): semantic nDCG@5=${s.judged_semantic_ndcg5} P@5=${s.judged_semantic_p5} R@10=${s.judged_semantic_r10} | keyword nDCG@5=${s.judged_bm25_ndcg5} P@5=${s.judged_bm25_p5} R@10=${s.judged_bm25_r10} | hybrid nDCG@5=${s.judged_hybrid_ndcg5} P@5=${s.judged_hybrid_p5} R@10=${s.judged_hybrid_r10} | gems top5 sem ${s.judged_semantic_gems_top5} kw ${s.judged_bm25_gems_top5} hy ${s.judged_hybrid_gems_top5}`);
});
await optional("guardrails", "./guardrails", "runGuardrailEval", (r) => console.log(`guardrails: ${r.cases.filter((c: any) => c.pass).length}/${r.cases.length} pass`));
await optional("fairness", "./fairness", "runFairnessEval", (r) => console.log(`fairness: mean spearman=${r.summary.meanSpearman} mean top5 overlap=${r.summary.meanTop5Overlap}`));
await optional("agent", "./agent", "runAgentEval", (r) => console.log(`agent: success ${r.summary.successRate} violations ${r.summary.guardrailViolations} P@5 ${r.summary.precision5} mean tool calls ${r.summary.meanToolCalls}`));
await optional("cascade", "./cascade", "runCascadeEval", (r) => console.log(`cascade: jev acc ${r.summary.jevAccuracy} claude acc ${r.summary.claudeAccuracy} agreement ${r.summary.agreement} escalation ${r.summary.escalationRate}`));

const p = results.planted?.summary;
const parts = [
  p ? `Planted nDCG@5: semantic ${p.judged_semantic_ndcg5} · hybrid ${p.judged_hybrid_ndcg5} · keyword ${p.judged_bm25_ndcg5}` : "",
  results.guardrails ? `${results.guardrails.cases.filter((c: any) => c.pass).length}/${results.guardrails.cases.length} guardrails pass` : "",
  results.agent ? `agent success ${results.agent.summary.successRate}` : "",
  results.fairness ? `blind-ranking rho ${results.fairness.summary.meanSpearman}` : "",
].filter(Boolean);
results.headline = parts.join(" · ");
writeFileSync("eval/results.json", JSON.stringify(results, null, 1));
console.log("HEADLINE: " + results.headline);
process.exit(0);
