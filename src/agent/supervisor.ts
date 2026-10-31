// Supervisor agent: a LangGraph loop where one node = one LLM decision + one tool call, inside code-enforced phase gates.
// Checkpointed to Postgres when DATABASE_URL is reachable (MemorySaver otherwise); the HR approval is a LangGraph interrupt.
import { StateGraph, Annotation, START, END, MemorySaver, interrupt, Command, type BaseCheckpointSaver } from "@langchain/langgraph";
import type Anthropic from "@anthropic-ai/sdk";
import { chat, LlmUnavailable, type ChatMessage } from "../lib/llm";
import { store } from "../lib/store";
import { emit } from "../lib/trace";
import { dbHealthy, getPool } from "../lib/db";
import { spendSummary } from "../lib/llm";
import { cascadeSummary, decide, sentences } from "../lib/decide";
import { embedTexts, QUERY_PREFIX } from "../lib/embed";
import { getCandidateLocal, dot } from "../lib/db";
import { newState, type AgentState, evidencedCandidates, mustHaves, hasFullEvidence } from "./state";
import { parseJd } from "./parse";
import { ALL_TOOLS, toolsForPhase, toolDefs, GateError, ApprovalInterrupt, type ToolSpec, exitCondition } from "./tools";
import { SUPERVISOR_SYSTEM, stateDigest } from "./prompts";

const MAX_TOOL_CALLS = 40;

const Graph = Annotation.Root({
  agent: Annotation<AgentState>({ reducer: (_a, b) => b, default: () => null as any }),
  messages: Annotation<ChatMessage[]>({ reducer: (_a, b) => b, default: () => [] }),
});
type G = typeof Graph.State;

export interface ApprovalResume { approved: string[]; removed: string[] }

// ---------- one tool execution, shared by the LLM loop and the degraded pipeline ----------
async function execTool(state: AgentState, tool: ToolSpec, rawInput: any, source: "llm" | "auto"): Promise<{ ok: boolean; result: any }> {
  const runId = state.runId;
  const parsed = tool.schema.safeParse(rawInput);
  if (!parsed.success) {
    const msg = `invalid input for ${tool.name}: ${parsed.error.issues.map((i: any) => `${i.path.join(".")}: ${i.message}`).join("; ")}. Required fields: ${Object.keys((tool.schema as any).shape ?? {}).join(", ")}`;
    emit(runId, "tool_result", { name: tool.name, ok: false, error: msg }, tool.name);
    return { ok: false, result: { error: msg } };
  }
  const input = parsed.data;
  const n = state.toolCalls.length + 1;
  emit(runId, "reason", { n, text: input.reason, source }, tool.name);
  const { reason: _r, ...shown } = input;
  emit(runId, "tool_call", { n, name: tool.name, input: shown, phase: state.phase }, tool.name);
  if (tool.name === "search_candidates" && state.searches.length >= state.jd.requirements.filter((r) => r.kind === "must").length + 1) state.reformulations = Math.min(2, state.reformulations + 1);
  try {
    const result = await tool.run(input, { state, runId });
    state.toolCalls.push({ n, name: tool.name, reason: input.reason, ok: true, summary: summarize(tool.name, result), phase: state.phase });
    emit(runId, "tool_result", { n, name: tool.name, ok: true, result }, tool.name);
    return { ok: true, result };
  } catch (e: any) {
    if (e instanceof ApprovalInterrupt) throw e;
    const gate = e instanceof GateError;
    const msg = e?.message ?? String(e);
    state.toolCalls.push({ n, name: tool.name, reason: input.reason, ok: false, summary: (gate ? "GATE: " : "error: ") + msg, phase: state.phase });
    emit(runId, gate ? "gate_blocked" : "tool_result", gate ? { n, gate: e.gate, name: tool.name, text: msg } : { n, name: tool.name, ok: false, error: msg }, tool.name);
    return { ok: false, result: { error: msg, gate: gate ? e.gate : undefined } };
  }
}

function summarize(name: string, r: any): string {
  try {
    if (name === "search_candidates") return `${r.results?.length} hits, top ${r.spread?.top}`;
    if (name === "cite_evidence") return r.accepted ? `accepted (${r.strength}, ${r.decidedBy})` : `rejected: ${r.reason}`;
    if (name === "fairness_audit") return `rho ${r.spearman}, overlap ${r.top5Overlap}`;
    return JSON.stringify(r).slice(0, 100);
  } catch { return ""; }
}

// ---------- the graph ----------
async function intakeNode(s: G): Promise<Partial<G>> {
  const state = s.agent;
  if (!state.jd.requirements.length) await parseJd(state);
  emit(state.runId, "phase", { phase: "SOURCE", text: `Entering SOURCE. Exit: ${exitCondition("SOURCE")}` }, "phase");
  const first: ChatMessage = { role: "user", content: `Job description (lawful parts):\n<<<JD\n${state.jd.raw.split("\n").filter((l) => !state.jd.refused.some((r) => r.line === l.trim())).join("\n")}\nJD>>>\n\n${stateDigest(state)}\n\nStart with recall_memory for role "${state.roleKey}", then search.` };
  store.patchRun(state.runId, { state });
  return { agent: state, messages: [first] };
}

function approvalPayload(state: AgentState, ids: string[], rationale: string) {
  return { candidateIds: ids, rationale, candidates: ids.map((id) => ({ id, name: state.candidates[id].name, semantic: state.candidates[id].semantic, evidence: state.candidates[id].evidence, flags: state.candidates[id].flags })) };
}

async function stepNode(s: G): Promise<Partial<G>> {
  const runId = s.agent.runId;
  const resuming = store.getRun(runId)?.status === "waiting_approval";
  // On resume LangGraph re-runs this node from its checkpoint; the store holds the state as it was at the interrupt.
  const state: AgentState = resuming && store.getRun(runId)?.state ? store.getRun(runId)!.state : s.agent;
  const messages = [...s.messages];
  if (resuming && state.degraded.length && state.shortlist.length && !state.approval) {
    const payload = approvalPayload(state, state.shortlist, "Embedding-only shortlist with locally verified evidence (LLM unavailable).");
    const resume = interrupt<typeof payload, ApprovalResume>(payload);
    applyApproval(state, resume);
    await degradedTail(state);
    return { agent: state, messages };
  }

  if (state.toolCalls.length >= MAX_TOOL_CALLS && state.phase !== "DONE") {
    emit(runId, "note", { banner: "limit", text: `Automatic fallback: the tool-call limit (${MAX_TOOL_CALLS}) was reached. Finishing deterministically with the work done so far.` }, "supervisor");
    if (state.phase === "SOURCE") await degradedPipeline(state); else await degradedTail(state);
    return { agent: state, messages };
  }

  const tools = toolsForPhase(state.phase);
  let r;
  try {
    r = await chat({ purpose: `supervisor:${state.phase}`, system: SUPERVISOR_SYSTEM, messages, tools: toolDefs(tools), maxTokens: 2000, runId, effort: "low" });
  } catch (e) {
    if (e instanceof LlmUnavailable) {
      const kind = e.reason === "budget" ? "budget" : "llm";
      if (!state.degraded.includes(kind)) state.degraded.push(kind);
      emit(runId, "note", { banner: kind, text: kind === "budget" ? `Automatic fallback: the LLM budget cap was reached. Stopping model steps and keeping the work already done.` : `Automatic fallback: the LLM is unavailable (${e.message}). Degrading to embedding-only ranking with local evidence checks.` }, "supervisor");
      await degradedPipeline(state);
      return { agent: state, messages };
    }
    throw e;
  }

  const use = r.toolUses[0];
  if (!use) {
    state.nudges++;
    if (r.text) emit(runId, "note", { text: r.text.slice(0, 300) }, "supervisor");
    if (state.nudges > 2) {
      emit(runId, "note", { banner: "limit", text: "Automatic fallback: the supervisor answered with text instead of a tool call three times. Running the automatic evidence pass." }, "supervisor");
      if (state.phase === "SOURCE") await degradedPipeline(state); else await degradedTail(state);
      return { agent: state, messages };
    }
    messages.push({ role: "assistant", content: r.text || "(no tool call)" }, { role: "user", content: `You must call exactly one tool now. ${stateDigest(state)}` });
    return { agent: state, messages };
  }
  const tool = ALL_TOOLS.find((t) => t.name === use.name);
  const assistant: Anthropic.ContentBlockParam[] = [];
  if (r.text) assistant.push({ type: "text", text: r.text });
  assistant.push({ type: "tool_use", id: use.id, name: use.name, input: use.input });
  messages.push({ role: "assistant", content: assistant });

  let resultText: string;
  if (!tool || !tools.includes(tool)) {
    resultText = JSON.stringify({ error: `tool ${use.name} is not available in phase ${state.phase}. Available: ${tools.map((t) => t.name).join(", ")}` });
  } else {
    try {
      if (resuming && tool.name === "request_hr_approval") {
        // Re-executing after the interrupt: do not duplicate the trace; go straight to the resume value.
        const resume = interrupt<ReturnType<typeof approvalPayload>, ApprovalResume>(approvalPayload(state, use.input.candidate_ids, use.input.rationale));
        resultText = applyApproval(state, resume);
      } else {
        const out = await execTool(state, tool, use.input, "llm");
        resultText = JSON.stringify(out.result);
      }
    } catch (e) {
      if (e instanceof ApprovalInterrupt) {
        store.patchRun(runId, { status: "waiting_approval", state });
        emit(runId, "interrupt", { kind: "hr_approval", ...approvalPayload(state, e.payload.candidateIds, e.payload.rationale) }, "request_hr_approval");
        const resume = interrupt<ReturnType<typeof approvalPayload>, ApprovalResume>(approvalPayload(state, e.payload.candidateIds, e.payload.rationale));
        resultText = applyApproval(state, resume);
      } else throw e;
    }
  }
  const phaseNote = state.phase !== (s.agent.phase) ? "" : "";
  messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: resultText.slice(0, 6000) }, { type: "text", text: `${phaseNote}${stateDigest(state)}` }] });
  store.patchRun(runId, { state, status: state.phase === "DONE" ? "done" : "running" });
  if (state.phase === "DONE") finish(state);
  return { agent: state, messages };
}

function applyApproval(state: AgentState, resume: ApprovalResume): string {
  state.approval = { approved: resume.approved, removed: resume.removed };
  for (const id of resume.removed) { const c = state.candidates[id]; if (c) c.dropped = "removed by HR at approval"; }
  store.approve(state.runId, resume.approved, resume.removed);
  state.phase = "ASSESS";
  emit(state.runId, "approval", { approved: resume.approved, removed: resume.removed }, "request_hr_approval");
  emit(state.runId, "phase", { phase: "ASSESS", text: `HR approved ${resume.approved.length} candidate(s). Entering ASSESS. Exit: ${exitCondition("ASSESS")}` }, "phase");
  store.patchRun(state.runId, { status: "running", state });
  return JSON.stringify({ approved: resume.approved, removed: resume.removed, phase: "ASSESS", note: "Assessments may now be created and sent to approved candidates only." });
}

function finish(state: AgentState) {
  const dropped = Object.values(state.candidates).filter((c) => c.dropped).map((c) => ({ id: c.id, name: c.name, reason: c.dropped! }));
  state.runSummary = { toolCalls: state.toolCalls.length, reformulations: state.reformulations, dropped, llm: spendSummary(state.runId), cascade: cascadeSummary(state.runId) };
  for (const id of state.final?.ranked ?? []) {
    const c = state.candidates[id];
    c.final = +((c.grade ? 0.6 * c.semantic + 0.4 * c.grade.total : c.semantic)).toFixed(4);
  }
  emit(state.runId, "done", { final: state.final, summary: state.runSummary, degraded: state.degraded }, "finalize_shortlist");
  store.patchRun(state.runId, { status: "done", state, summary: state.runSummary });
}

// ---------- degraded pipeline (no LLM): deterministic tool sequence with local evidence ----------
async function degradedPipeline(state: AgentState) {
  const auto = (reason: string) => `automatic (${state.degraded.includes("budget") ? "budget cap" : state.degraded.includes("llm") ? "LLM unavailable" : "supervisor stalled"}): ${reason}`;
  const T = Object.fromEntries(ALL_TOOLS.map((t) => [t.name, t]));
  if (state.phase === "SOURCE") {
    if (evidencedCandidates(state).length >= 2) {
      emit(state.runId, "note", { text: `Proposing the ${evidencedCandidates(state).length} candidates that already have full evidence.` }, "supervisor");
    } else {
    if (!state.memoryApplied.length) await execTool(state, T.recall_memory, { reason: auto("load HR notes for this role"), role: state.roleKey }, "auto");
    for (const r of state.jd.requirements) await execTool(state, T.search_candidates, { reason: auto(`one search per requirement: "${r.text}"`), query: `${state.jd.title}: ${r.text}`, k: 20, view: "visible" }, "auto");
    // Local-only evidence: best sentence per must-have, accepted only when the local tier is confident.
    const musts = mustHaves(state);
    const rv = await embedTexts(musts.map((m) => QUERY_PREFIX + m.text));
    const pool = Object.values(state.candidates).filter((c) => !c.dropped).sort((a, b) => b.seen - a.seen || b.semantic - a.semantic).slice(0, 16);
    for (const c of pool) {
      if (evidencedCandidates(state).length >= state.targetN) break;
      const row = getCandidateLocal(c.id)!;
      const inj = await decide("injection_check", { text: row.visible_text }, state.runId);
      if (inj.label === "yes") { c.flags.push("prompt_injection"); emit(state.runId, "refusal", { kind: "prompt_injection", candidateId: c.id, name: c.name, text: "Profile contains instruction-like text; treated as data, ignored, flagged." }, "get_profile"); }
      const sents = sentences(row.visible_text);
      const sv = await embedTexts(sents.map((x) => x.text));
      const citations: { requirement_id: string; quote: string }[] = [];
      const why: string[] = [];
      for (let i = 0; i < musts.length; i++) {
        let best = -1, bi = 0;
        sv.forEach((v, j) => { const d = dot(rv[i], v); if (d > best) { best = d; bi = j; } });
        c.coverage[musts[i].id] = best;
        if (sents[bi]) { citations.push({ requirement_id: musts[i].id, quote: sents[bi].text }); why.push(`${musts[i].text} ${best.toFixed(2)}`); }
      }
      if (citations.length) await execTool(state, T.cite_evidence, { reason: auto(`best sentence per must-have by cosine: ${why.join(", ")}`), candidate_id: c.id, citations }, "auto");
      if (!hasFullEvidence(c, state)) await execTool(state, T.drop_candidate, { reason: auto("not every must-have could be evidenced from the profile"), candidate_id: c.id, why: "no verbatim evidence for every must-have (automatic check)" }, "auto");
    }
    }
    const ev = evidencedCandidates(state).sort((a, b) => b.semantic - a.semantic).slice(0, state.targetN);
    if (ev.length >= 2) {
      state.shortlist = ev.map((c) => c.id);
      store.patchRun(state.runId, { status: "waiting_approval", state });
      const payload = approvalPayload(state, state.shortlist, "Embedding-only shortlist with locally verified evidence (LLM unavailable).");
      emit(state.runId, "interrupt", { kind: "hr_approval", ...payload }, "request_hr_approval");
      const resume = interrupt<typeof payload, ApprovalResume>(payload);
      applyApproval(state, resume);
    } else {
      emit(state.runId, "error", { text: "No candidate could be evidenced without the LLM; nothing to shortlist." }, "supervisor");
      state.phase = "DONE";
      store.patchRun(state.runId, { status: "failed", state });
      return;
    }
  }
  await degradedTail(state);
}

async function degradedTail(state: AgentState) {
  const T = Object.fromEntries(ALL_TOOLS.map((t) => [t.name, t]));
  const live = (state.approval?.approved ?? state.shortlist).filter((id) => state.candidates[id] && !state.candidates[id].dropped);
  if (live.length < 2) { emit(state.runId, "error", { text: "Fewer than two live candidates; cannot audit or finalize." }, "supervisor"); state.phase = "DONE"; store.patchRun(state.runId, { status: "failed", state }); return; }
  if (state.phase === "ASSESS") { emit(state.runId, "phase", { phase: "AUDIT", text: "Skipping the remaining assessments (budget, call limit or no model). Entering AUDIT." }, "phase"); state.phase = "AUDIT"; }
  if (state.phase === "AUDIT") {
    await execTool(state, T.fairness_audit, { reason: "automatic: audit the live shortlist on redacted vectors", shortlist_ids: live }, "auto");
    state.phase = "FINALIZE";
  }
  if (state.phase === "FINALIZE") {
    const ranked = [...live].sort((a, b) => (state.candidates[b].grade ? 0.6 * state.candidates[b].semantic + 0.4 * state.candidates[b].grade!.total : state.candidates[b].semantic) - (state.candidates[a].grade ? 0.6 * state.candidates[a].semantic + 0.4 * state.candidates[a].grade!.total : state.candidates[a].semantic));
    const dropped = Object.values(state.candidates).filter((c) => c.dropped);
    await execTool(state, T.finalize_shortlist, { reason: "automatic: finalize with the audited shortlist", ranked_ids: ranked, weights: { semantic: live.some((id) => state.candidates[id].grade) ? 0.6 : 1, assessment: live.some((id) => state.candidates[id].grade) ? 0.4 : 0 }, summary: `Deterministic finish. ${state.toolCalls.length} tool calls, ${state.reformulations} reformulations, ${dropped.length} dropped (${dropped.map((d) => `${d.name}: ${d.dropped}`).join("; ") || "none"}). Fairness: rho ${state.audit?.spearman}, top-5 overlap ${state.audit?.top5Overlap}.`, official_blind: !!state.audit?.recommendBlind }, "auto");
  }
  if (state.phase === "DONE") finish(state);
}

// ---------- wiring ----------
let checkpointer: BaseCheckpointSaver | null = null;
async function getCheckpointer(): Promise<BaseCheckpointSaver> {
  if (checkpointer) return checkpointer;
  if (process.env.DATABASE_URL && (await dbHealthy())) {
    try {
      const { PostgresSaver } = await import("@langchain/langgraph-checkpoint-postgres");
      // Share the app's small pool so one process never holds more than a few pooler connections.
      const saver = new PostgresSaver(getPool()!, undefined, { schema: "langgraph" } as any);
      await saver.setup();
      checkpointer = saver;
      return saver;
    } catch (e: any) {
      console.warn("PostgresSaver unavailable, using MemorySaver:", e?.message);
    }
  }
  checkpointer = new MemorySaver();
  return checkpointer;
}

let compiled: any = null;
async function graph() {
  if (compiled) return compiled;
  const g = new StateGraph(Graph)
    .addNode("intake", intakeNode)
    .addNode("step", stepNode)
    .addEdge(START, "intake")
    .addEdge("intake", "step")
    .addConditionalEdges("step", (s: G) => (s.agent.phase === "DONE" ? END : "step"), { step: "step", [END]: END });
  compiled = g.compile({ checkpointer: await getCheckpointer() });
  return compiled;
}

export interface RunOptions { runId: string; jdText: string; roleKey: string; presetId?: string; chaos?: Record<string, boolean> }

export async function startRun(o: RunOptions): Promise<AgentState> {
  const state = newState(o.runId, o.roleKey, o.jdText, o.chaos ?? {});
  store.putRun({ id: o.runId, roleKey: o.roleKey, jdText: o.jdText, presetId: o.presetId, status: "running", chaos: o.chaos ?? {}, createdAt: Date.now(), updatedAt: Date.now(), state });
  emit(o.runId, "start", { roleKey: o.roleKey, presetId: o.presetId, chaos: o.chaos ?? {}, cascade: process.env.CASCADE !== "off" }, "run");
  const g = await graph();
  const out = await g.invoke({ agent: state, messages: [] }, { configurable: { thread_id: o.runId }, recursionLimit: 120 });
  return out.agent;
}

export async function resumeRun(runId: string, resume: ApprovalResume): Promise<AgentState> {
  const g = await graph();
  const out = await g.invoke(new Command({ resume }), { configurable: { thread_id: runId }, recursionLimit: 120 });
  return out.agent;
}

export async function runState(runId: string): Promise<AgentState | undefined> {
  return store.getRun(runId)?.state;
}
