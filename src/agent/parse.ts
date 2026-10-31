// JD intake: structured requirements from the JD exactly as HR wrote it. Runs before the tool loop.
import { z } from "zod";
import { structured, LlmUnavailable, LlmParseError } from "../lib/llm";
import { emit } from "../lib/trace";
import type { AgentState } from "./state";

const Parsed = z.object({
  title: z.string(),
  seniority: z.enum(["junior", "mid", "senior", "unspecified"]),
  must_have: z.array(z.string()).min(1).max(8),
  nice_to_have: z.array(z.string()).max(8),
});

export async function parseJd(state: AgentState): Promise<void> {
  const runId = state.runId;
  emit(runId, "phase", { phase: "INTAKE", text: "Reading the JD" }, "parse_jd");
  const raw = state.jd.raw;
  const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l.length > 3);

  try {
    const r = await structured({
      purpose: "parse_jd",
      schemaName: "ParsedJD",
      schema: Parsed,
      runId,
      system: "Extract hiring requirements from a job description. Keep each requirement short (2–6 words), concrete and skill-based.",
      messages: [{ role: "user", content: raw }],
      maxTokens: 1500,
    });
    state.jd.title = r.data.title;
    state.jd.seniority = r.data.seniority;
    state.jd.requirements = [
      ...r.data.must_have.map((t, i) => ({ id: `m${i + 1}`, text: t, kind: "must" as const })),
      ...r.data.nice_to_have.map((t, i) => ({ id: `n${i + 1}`, text: t, kind: "nice" as const })),
    ];
  } catch (e) {
    if (!(e instanceof LlmUnavailable) && !(e instanceof LlmParseError)) throw e;
    // Fallback parser: our JDs carry "Must have:" / "Nice to have:" lines. Works with no LLM at all.
    const must = raw.match(/must have:\s*([^\n]+)/i)?.[1] ?? "";
    const nice = raw.match(/nice to have:\s*([^\n]+)/i)?.[1] ?? "";
    const split = (s: string) => s.split(/[,;]/).map((x) => x.replace(/\.$/, "").trim()).filter(Boolean);
    state.jd.title = lines[0]?.slice(0, 80) ?? "Role";
    state.jd.seniority = (raw.match(/seniority:\s*(\w+)/i)?.[1] ?? "unspecified").toLowerCase();
    state.jd.requirements = [...split(must).map((t, i) => ({ id: `m${i + 1}`, text: t, kind: "must" as const })), ...split(nice).map((t, i) => ({ id: `n${i + 1}`, text: t, kind: "nice" as const }))];
    if (!state.jd.requirements.length) state.jd.requirements = [{ id: "m1", text: lines.slice(1).join(" ").slice(0, 120), kind: "must" }];
    const why = e instanceof LlmUnavailable ? e.reason : "parse";
    state.degraded.push(why === "budget" ? "budget" : "llm");
    emit(runId, "note", { banner: why === "budget" ? "budget" : "llm", text: `LLM unavailable (${e instanceof Error ? e.message : e}). Parsed requirements with the rule-based fallback; the run continues in embedding-only mode.` }, "parse_jd");
  }
  emit(runId, "parsed", { title: state.jd.title, seniority: state.jd.seniority, requirements: state.jd.requirements }, "parse_jd");
}
