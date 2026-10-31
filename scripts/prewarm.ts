// Runs the three preset JDs once so every LLM call is cached before the demo. Auto-approves the proposed shortlist.
import { readFileSync } from "node:fs";
import { startRun, resumeRun } from "../src/agent/supervisor";
import { store } from "../src/lib/store";
import { spendSummary } from "../src/lib/llm";

const { presets } = JSON.parse(readFileSync("data/jds.json", "utf8"));
for (const [i, jd] of presets.entries()) {
  const runId = `prewarm_${i}_${Date.now().toString(36)}`;
  const t0 = Date.now();
  let state = await startRun({ runId, jdText: jd.text, roleKey: jd.archetype ?? jd.id, presetId: jd.id });
  if (store.getRun(runId)?.status === "waiting_approval") state = await resumeRun(runId, { approved: state.shortlist, removed: [] });
  const s = spendSummary(runId);
  console.log(`${jd.id} ${jd.title}: ${store.getRun(runId)?.status} in ${((Date.now() - t0) / 1000).toFixed(0)}s, ${state.toolCalls.length} tool calls, $${s.cost} (${s.cached}/${s.calls} cached)`);
  console.log("  " + state.toolCalls.map((t) => t.name).join(" → "));
}
store.flush();
console.log("total spent:", spendSummary().totalSpent);
process.exit(0);
