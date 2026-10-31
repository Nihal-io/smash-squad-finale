// CLI runner: bun run agent [presetIndex|jdId] [--auto-approve] [--chaos=LLM_OUTAGE,DB_DOWN,BUDGET_ZERO]
import { readFileSync } from "node:fs";
import { startRun, resumeRun } from "../src/agent/supervisor";
import { subscribe } from "../src/lib/trace";
import { store } from "../src/lib/store";

const args = process.argv.slice(2);
const which = args.find((a) => !a.startsWith("--")) ?? "0";
const textArg = args.find((a) => a.startsWith("--text="))?.slice(7);
const intakeOnly = args.includes("--intake-only");
const chaosArg = args.find((a) => a.startsWith("--chaos="))?.slice(8) ?? "";
for (const f of chaosArg.split(",").filter(Boolean)) process.env[`CHAOS_${f}`] = "1";
const { jds, presets } = JSON.parse(readFileSync("data/jds.json", "utf8"));
const jd = textArg ? { id: "custom", archetype: "custom", title: "custom", text: textArg.replace(/\\n/g, "\n") } : /^\d+$/.test(which) ? presets[Number(which)] : jds.find((j: any) => j.id === which);
if (!jd) throw new Error(`unknown JD ${which}`);
const runId = `run_${Date.now().toString(36)}`;

subscribe(runId, (ev) => {
  const p = ev.payload;
  const line =
    ev.kind === "reason" ? `  #${p.n} why: ${p.text}` :
    ev.kind === "tool_call" ? `  #${p.n} call ${p.name}(${JSON.stringify(p.input).slice(0, 110)})` :
    ev.kind === "tool_result" ? `  #${p.n ?? ""} ${p.ok ? "ok" : "ERR"} ${JSON.stringify(p.ok ? p.result : p.error).slice(0, 160)}` :
    ev.kind === "gate_blocked" ? `  GATE ${p.gate}: ${p.text}` :
    ev.kind === "refusal" ? `  REFUSAL ${p.kind ?? ""}: ${p.reason ?? p.text}` :
    ev.kind === "decision" ? `    decide ${p.task} → ${p.label} by ${p.by} (${p.confidence})` :
    ev.kind === "llm" ? `    llm ${p.purpose} ${p.cached ? "cached" : "$" + p.costUsd}` :
    ev.kind === "phase" ? `== ${p.phase}: ${p.text}` :
    ev.kind === "interrupt" ? `?? waiting for HR approval: ${p.candidateIds.join(", ")}` :
    ev.kind === "done" ? `DONE ranked=${p.final?.ranked?.join(",")} summary=${JSON.stringify(p.summary).slice(0, 300)}` :
    `  ${ev.kind}: ${JSON.stringify(p).slice(0, 160)}`;
  console.log(line);
});

const t0 = Date.now();
if (intakeOnly) {
  const { newState } = await import("../src/agent/state");
  const { parseJd } = await import("../src/agent/parse");
  const { store: st } = await import("../src/lib/store");
  st.putRun({ id: runId, roleKey: jd.archetype ?? jd.id, jdText: jd.text, status: "running", chaos: {}, createdAt: Date.now(), updatedAt: Date.now() });
  const s = newState(runId, jd.archetype ?? jd.id, jd.text);
  await parseJd(s);
  console.log(`\nrefused lines: ${s.jd.refused.length}`);
  for (const r of s.jd.refused) console.log(`  - "${r.line}" → ${r.reason}`);
  console.log(`kept requirements: ${s.jd.requirements.map((r) => `${r.id}:${r.text}`).join(", ")}`);
  st.flush();
  process.exit(0);
}
let state = await startRun({ runId, jdText: jd.text, roleKey: jd.archetype ?? jd.id, presetId: jd.id });
if (store.getRun(runId)?.status === "waiting_approval") {
  const ids: string[] = state.shortlist;
  const removed = args.includes("--auto-approve") || true ? (ids.length > 5 ? [ids[ids.length - 1]] : []) : [];
  console.log(`\n>> HR approves ${ids.filter((i) => !removed.includes(i)).join(", ")}${removed.length ? `, removes ${removed.join(", ")}` : ""}\n`);
  state = await resumeRun(runId, { approved: ids.filter((i) => !removed.includes(i)), removed });
}
store.flush();
console.log(`\nfinished in ${((Date.now() - t0) / 1000).toFixed(1)}s; status=${store.getRun(runId)?.status}; phase=${state.phase}; tool calls=${state.toolCalls.length}`);
const { spendSummary } = await import("../src/lib/llm");
const sp = spendSummary(runId);
console.log(`llm calls=${sp.calls} cached=${sp.cached} cost=$${sp.cost}`);
console.log("sequence:", state.toolCalls.map((t) => t.name).join(" → "));
if (state.audit) console.log(`fairness: rho=${state.audit.spearman} overlap=${state.audit.top5Overlap}\n  ${state.audit.findings.join("\n  ")}`);
process.exit(0);
