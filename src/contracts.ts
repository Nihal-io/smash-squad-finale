// Shared contracts between the agent, the API routes and the UI. Nobody else defines these shapes.
// The UI (public/index.html) is built against API.md, which mirrors these types.
import type { CandidateRow } from "./lib/db";
import type { RunRecord, TraceEvent } from "./lib/store";
import type { AgentState, CandidateState, Evidence, FairnessAudit, Phase, Requirement } from "./agent/state";

export type Candidate = CandidateRow;
export type Run = RunRecord;
export type Step = TraceEvent; // one trace event: kind ∈ start | phase | reason | tool_call | tool_result | gate_blocked | refusal | decision | llm | note | parsed | interrupt | approval | audit | done | error
export type { AgentState, CandidateState, Evidence, FairnessAudit, Phase, Requirement };

export interface ShortlistItem {
  id: string;
  name: string;
  rank: number;
  semantic: number; // best cosine seen (0..1)
  assessment: number | null; // graded 0..1, null when not assessed
  final: number; // 0.6*semantic + 0.4*assessment, or semantic alone
  evidence: Evidence[]; // verbatim spans into Candidate.visible_text; each carries basis: "explicit" | "implied"
  unverified: string[]; // requirement ids without evidence
  flags: string[]; // prompt_injection | grader_disagreement
  dropped?: string;
  gradeFlag?: string;
  simulatedResponses: boolean;
}

export type FairnessRow = FairnessAudit["rows"][number];

export interface ChaosFlags { LLM_OUTAGE: boolean; DB_DOWN: boolean; BUDGET_ZERO: boolean }

export interface SpendSummary { calls: number; cached: number; cost: number; budget: number; totalSpent: number; remaining: number }
export interface CascadeSummary { decisions: number; byTier: Record<string, number>; resolvedBeforeClaude: number; resolvedByJev: number; escalationRate: number; actualUsd: number; allClaudeUsd: number }

export interface Preset { id: string; title: string; text: string; unlawful: boolean; archetype: string }

export function toShortlist(state: AgentState): ShortlistItem[] {
  const ids = state.final?.ranked ?? state.approval?.approved ?? state.shortlist;
  const musts = state.jd.requirements.filter((r) => r.kind === "must").map((r) => r.id);
  return ids.map((id, i) => {
    const c = state.candidates[id];
    const assessment = c.grade ? c.grade.total : null;
    return {
      id, name: c.name, rank: i + 1, semantic: +c.semantic.toFixed(3), assessment,
      final: +(assessment === null ? c.semantic : 0.6 * c.semantic + 0.4 * assessment).toFixed(3),
      evidence: c.evidence, unverified: musts.filter((m) => !c.evidence.some((e) => e.requirementId === m)),
      flags: c.flags, dropped: c.dropped, gradeFlag: c.grade?.flaggedForHr, simulatedResponses: !!c.responses,
    };
  });
}
