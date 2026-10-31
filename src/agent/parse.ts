// JD intake: structured requirements plus the discriminatory-criteria guardrail. Runs before the tool loop.
import { z } from "zod";
import { structured, LlmUnavailable, LlmParseError } from "../lib/llm";
import { decide } from "../lib/decide";
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
  emit(runId, "phase", { phase: "INTAKE", text: "Reading the JD, checking each line for unlawful criteria" }, "parse_jd");

  // Guardrail first: every line is checked locally, escalating only when unsure.
  const lines = state.jd.raw.split(/\n+|(?<=\.)\s+(?=[A-Z])/).map((l) => l.trim()).filter((l) => l.length > 3);
  const keep: string[] = [];
  for (const line of lines) {
    const d = await decide("discriminatory_clause", { line }, runId);
    if (d.label === "yes") {
      state.jd.refused.push({ line, reason: d.rationale ?? "discriminatory or unlawful criterion" });
      emit(runId, "refusal", { kind: "unlawful_criteria", line, reason: `Stripped: ${d.rationale ?? "unlawful criterion"} (decided by ${d.by}, ${d.confidence.toFixed(2)}). Continuing on the lawful requirements.` }, "parse_jd");
    } else keep.push(line);
  }
  const lawful = keep.join("\n");

  try {
    const r = await structured({
      purpose: "parse_jd",
      schemaName: "ParsedJD",
      schema: Parsed,
      runId,
      system: "Extract hiring requirements from a job description. Keep each requirement short (2–6 words), concrete and skill-based. Do not include anything about gender, age, religion, caste, marital status, disability, nationality or specific college names.",
      messages: [{ role: "user", content: lawful }],
      maxTokens: 600,
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
    const must = lawful.match(/must have:\s*([^\n]+)/i)?.[1] ?? "";
    const nice = lawful.match(/nice to have:\s*([^\n]+)/i)?.[1] ?? "";
    const split = (s: string) => s.split(/[,;]/).map((x) => x.replace(/\.$/, "").trim()).filter(Boolean);
    state.jd.title = lines[0]?.slice(0, 80) ?? "Role";
    state.jd.seniority = (lawful.match(/seniority:\s*(\w+)/i)?.[1] ?? "unspecified").toLowerCase();
    state.jd.requirements = [...split(must).map((t, i) => ({ id: `m${i + 1}`, text: t, kind: "must" as const })), ...split(nice).map((t, i) => ({ id: `n${i + 1}`, text: t, kind: "nice" as const }))];
    if (!state.jd.requirements.length) state.jd.requirements = [{ id: "m1", text: lines.slice(1).join(" ").slice(0, 120), kind: "must" }];
    const why = e instanceof LlmUnavailable ? e.reason : "parse";
    state.degraded.push(why === "budget" ? "budget" : "llm");
    emit(runId, "note", { banner: why === "budget" ? "budget" : "llm", text: `LLM unavailable (${e instanceof Error ? e.message : e}). Parsed requirements with the rule-based fallback; the run continues in embedding-only mode.` }, "parse_jd");
  }
  emit(runId, "parsed", { title: state.jd.title, seniority: state.jd.seniority, requirements: state.jd.requirements, refused: state.jd.refused }, "parse_jd");
}
