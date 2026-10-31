// The ONLY file that calls a generative LLM.
// Provider via env: LLM_PROVIDER = anthropic | openai-compatible | stub. LLM_BASE_URL, LLM_API_KEY, LLM_MODEL.
// Every call is cached by sha256(model + messages + tools/schema). Spend is tracked per call and capped by LLM_BUDGET_USD.
// Structured outputs are validated with Zod; one repair retry, then a visible failure.
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { ZodTypeAny, z } from "zod";
import { store } from "./store";
import { emit } from "./trace";

export type Role = "user" | "assistant";
export interface ChatMessage { role: Role; content: string | Anthropic.ContentBlockParam[] }
export interface ToolDef { name: string; description: string; input_schema: Record<string, any> }
export interface ToolUse { id: string; name: string; input: any }
export interface LlmResult { text: string; toolUses: ToolUse[]; stopReason: string; usage: Usage; costUsd: number; cached: boolean; model: string; raw?: any }
export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number }

export class LlmUnavailable extends Error { constructor(msg: string, public reason: "no_key" | "budget" | "outage" | "error") { super(msg); } }
export class LlmParseError extends Error {}

// $/M tokens. Haiku 5.5 is the default (cheapest capable). Override per deployment with LLM_PRICE_IN_PER_M / LLM_PRICE_OUT_PER_M.
const PRICES: Record<string, [number, number]> = {
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-sonnet-5-5": [2, 10],
  "claude-opus-5-5": [4, 20],
  "claude-haiku-4-5": [1, 5],
};

export function config() {
  const provider = (process.env.LLM_PROVIDER || (process.env.ANTHROPIC_API_KEY || process.env.LLM_API_KEY ? "anthropic" : "stub")) as "anthropic" | "openai-compatible" | "stub";
  const model = process.env.LLM_MODEL || "claude-haiku-5-5";
  const apiKey = process.env.LLM_API_KEY || process.env.ANTHROPIC_API_KEY || "";
  const baseURL = process.env.LLM_BASE_URL || undefined;
  const budget = Number(process.env.LLM_BUDGET_USD || 3);
  const p = PRICES[model] ?? [Number(process.env.LLM_PRICE_IN_PER_M || 1), Number(process.env.LLM_PRICE_OUT_PER_M || 5)];
  const priceIn = Number(process.env.LLM_PRICE_IN_PER_M || p[0]);
  const priceOut = Number(process.env.LLM_PRICE_OUT_PER_M || p[1]);
  return { provider, model, apiKey, baseURL, budget, priceIn, priceOut };
}

export function price(u: Usage, priceIn: number, priceOut: number) {
  return (u.input * priceIn + u.cacheWrite * priceIn * 1.25 + u.cacheRead * priceIn * 0.1 + u.output * priceOut) / 1e6;
}

export function spent(): number {
  return store.spend().reduce((s, r) => s + r.costUsd, 0);
}

export function spendSummary(runId?: string) {
  const rows = store.spend(runId);
  const calls = rows.length;
  const cached = rows.filter((r) => r.cached).length;
  const cost = rows.reduce((s, r) => s + r.costUsd, 0);
  const { budget } = config();
  return { calls, cached, cost: +cost.toFixed(5), budget, totalSpent: +spent().toFixed(5), remaining: +(budget - spent()).toFixed(5) };
}

function sha(parts: any) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

let client: Anthropic | null = null;
function anthropic() {
  const { apiKey, baseURL } = config();
  if (!client) client = new Anthropic({ apiKey, baseURL, maxRetries: 0, timeout: 60_000 });
  return client;
}

export function chaos(flag: string): boolean {
  return process.env[`CHAOS_${flag}`] === "1";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface CallOpts {
  purpose: string;
  system: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  maxTokens?: number;
  runId?: string;
  effort?: "low" | "medium" | "high";
}

// One generative call. Cache → budget → provider with retry/backoff. Throws LlmUnavailable when it cannot serve.
export async function chat(opts: CallOpts): Promise<LlmResult> {
  const cfg = config();
  const key = sha({ model: cfg.model, system: opts.system, messages: opts.messages, tools: opts.tools ?? null });
  const hit = store.cacheGet(key);
  if (hit) {
    const u: Usage = hit.response.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    store.addSpend({ runId: opts.runId, model: cfg.model, purpose: opts.purpose, inputTokens: u.input, outputTokens: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, costUsd: 0, cached: true, ts: Date.now() });
    if (opts.runId) emit(opts.runId, "llm", { purpose: opts.purpose, cached: true, costUsd: 0, wouldCost: hit.costUsd, model: cfg.model }, "llm");
    return { ...hit.response, cached: true, costUsd: 0 };
  }

  if (cfg.provider === "stub") throw new LlmUnavailable("No LLM key configured (LLM_API_KEY / ANTHROPIC_API_KEY)", "no_key");

  const used = spent();
  if (used >= cfg.budget || chaos("BUDGET_ZERO")) {
    if (opts.runId) emit(opts.runId, "refusal", { reason: `LLM budget reached ($${used.toFixed(3)} of $${cfg.budget}); call refused`, purpose: opts.purpose }, "llm");
    throw new LlmUnavailable(`Budget cap reached: $${used.toFixed(3)} ≥ $${cfg.budget}`, "budget");
  }

  let lastErr: any;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (chaos("LLM_OUTAGE")) throw new Error("simulated LLM outage (chaos)");
      const t0 = Date.now();
      const r = cfg.provider === "anthropic" ? await callAnthropic(opts, cfg.model) : await callOpenAICompatible(opts, cfg);
      const costUsd = price(r.usage, cfg.priceIn, cfg.priceOut);
      const result: LlmResult = { ...r, costUsd, cached: false, model: cfg.model };
      store.cachePut(key, { response: { text: r.text, toolUses: r.toolUses, stopReason: r.stopReason, usage: r.usage, model: cfg.model }, costUsd, model: cfg.model });
      store.addSpend({ runId: opts.runId, model: cfg.model, purpose: opts.purpose, inputTokens: r.usage.input, outputTokens: r.usage.output, cacheRead: r.usage.cacheRead, cacheWrite: r.usage.cacheWrite, costUsd, cached: false, ts: Date.now() });
      if (opts.runId) emit(opts.runId, "llm", { purpose: opts.purpose, cached: false, costUsd: +costUsd.toFixed(5), model: cfg.model, ms: Date.now() - t0, usage: r.usage }, "llm");
      return result;
    } catch (e: any) {
      lastErr = e;
      const status = e?.status as number | undefined;
      const retryable = !status || status === 429 || status >= 500 || /outage|timeout|ECONN|fetch failed/i.test(String(e?.message));
      if (!retryable) break;
      if (opts.runId) emit(opts.runId, "note", { text: `LLM call failed (${e?.message?.slice(0, 80)}); retry ${attempt + 1}/2 with backoff`, purpose: opts.purpose }, "llm");
      await sleep(chaos("LLM_OUTAGE") ? 50 : 500 * 2 ** attempt);
    }
  }
  throw new LlmUnavailable(`LLM unavailable after retries: ${lastErr?.message ?? lastErr}`, "outage");
}

async function callAnthropic(opts: CallOpts, model: string): Promise<Omit<LlmResult, "costUsd" | "cached" | "model">> {
  const res = await anthropic().messages.create({
    model,
    max_tokens: opts.maxTokens ?? 2048,
    system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
    messages: opts.messages.map((m) => ({ role: m.role, content: m.content })) as Anthropic.MessageParam[],
    tools: opts.tools?.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema as Anthropic.Tool.InputSchema })),
    tool_choice: opts.tools ? { type: "auto" } : undefined,
    output_config: { effort: opts.effort ?? "low" },
  });
  const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n");
  const toolUses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, input: b.input }));
  const usage: Usage = { input: res.usage.input_tokens, output: res.usage.output_tokens, cacheRead: res.usage.cache_read_input_tokens ?? 0, cacheWrite: res.usage.cache_creation_input_tokens ?? 0 };
  return { text, toolUses, stopReason: res.stop_reason ?? "end_turn", usage };
}

// Minimal OpenAI-compatible chat completions client (raw fetch; no SDK). Tools map to function calling.
async function callOpenAICompatible(opts: CallOpts, cfg: ReturnType<typeof config>): Promise<Omit<LlmResult, "costUsd" | "cached" | "model">> {
  const body: any = {
    model: cfg.model,
    temperature: 0,
    max_tokens: opts.maxTokens ?? 2048,
    messages: [{ role: "system", content: opts.system }, ...opts.messages.map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }))],
  };
  if (opts.tools) body.tools = opts.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  const res = await fetch(`${(cfg.baseURL || "https://api.openai.com/v1").replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) { const e: any = new Error(`openai-compatible ${res.status}: ${(await res.text()).slice(0, 200)}`); e.status = res.status; throw e; }
  const j: any = await res.json();
  const m = j.choices?.[0]?.message ?? {};
  const toolUses: ToolUse[] = (m.tool_calls ?? []).map((c: any) => ({ id: c.id, name: c.function.name, input: safeJson(c.function.arguments) }));
  return { text: m.content ?? "", toolUses, stopReason: j.choices?.[0]?.finish_reason ?? "stop", usage: { input: j.usage?.prompt_tokens ?? 0, output: j.usage?.completion_tokens ?? 0, cacheRead: 0, cacheWrite: 0 } };
}

function safeJson(s: string) { try { return JSON.parse(s); } catch { return { _raw: s }; } }

export function extractJson(text: string): any {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end < 0) throw new LlmParseError("no JSON object in response");
  const raw = body.slice(start, end + 1);
  try {
    return JSON.parse(raw);
  } catch (e) {
    // Common model slips: trailing commas, or literal newlines inside strings.
    const cleaned = raw.replace(/,\s*([}\]])/g, "$1").replace(/"((?:[^"\\]|\\.)*)"/gs, (m) => m.replace(/\n/g, "\\n").replace(/\t/g, "\\t"));
    return JSON.parse(cleaned);
  }
}

// Structured call: JSON validated against a Zod schema. One repair retry, then a visible failure.
export async function structured<S extends ZodTypeAny>(opts: Omit<CallOpts, "tools"> & { schema: S; schemaName: string }): Promise<{ data: z.infer<S>; costUsd: number; cached: boolean; repaired: boolean }> {
  const instruction = `\n\nRespond with ONLY a JSON object (no prose, no markdown) matching this schema:\n${JSON.stringify(zodShape(opts.schema))}`;
  const system = opts.system + instruction;
  let r = await chat({ ...opts, system, maxTokens: opts.maxTokens ?? 1500 });
  let totalCost = r.costUsd;
  try {
    return { data: opts.schema.parse(extractJson(r.text)), costUsd: totalCost, cached: r.cached, repaired: false };
  } catch (e: any) {
    if (opts.runId) emit(opts.runId, "note", { text: `Structured output for ${opts.schemaName} failed validation (${String(e?.message).slice(0, 120)}); retrying once with a repair prompt`, purpose: opts.purpose }, "llm");
    const repair: ChatMessage[] = [...opts.messages, { role: "assistant", content: r.text || "(empty)" }, { role: "user", content: `That did not validate: ${String(e?.message).slice(0, 300)}. Return ONLY the corrected JSON object.` }];
    r = await chat({ ...opts, system, messages: repair, maxTokens: opts.maxTokens ?? 1500, purpose: opts.purpose + ":repair" });
    totalCost += r.costUsd;
    try {
      return { data: opts.schema.parse(extractJson(r.text)), costUsd: totalCost, cached: r.cached, repaired: true };
    } catch (e2: any) {
      if (opts.runId) emit(opts.runId, "error", { text: `Structured output for ${opts.schemaName} failed twice; giving up on this call`, detail: String(e2?.message).slice(0, 200) }, "llm");
      throw new LlmParseError(`Invalid structured output for ${opts.schemaName}: ${e2?.message}`);
    }
  }
}

// A compact, human-readable description of a Zod schema for the prompt (good enough for small schemas).
function zodShape(s: any): any {
  const d = s?._def;
  if (!d) return "any";
  switch (d.typeName) {
    case "ZodObject": { const o: any = {}; for (const [k, v] of Object.entries(d.shape())) o[k] = zodShape(v); return o; }
    case "ZodArray": return [zodShape(d.type)];
    case "ZodString": return "string";
    case "ZodNumber": return "number";
    case "ZodBoolean": return "boolean";
    case "ZodEnum": return d.values.join(" | ");
    case "ZodOptional": return zodShape(d.innerType);
    case "ZodNullable": return zodShape(d.innerType);
    case "ZodDefault": return zodShape(d.innerType);
    case "ZodLiteral": return JSON.stringify(d.value);
    case "ZodUnion": return d.options.map(zodShape).join(" | ");
    default: return "any";
  }
}
