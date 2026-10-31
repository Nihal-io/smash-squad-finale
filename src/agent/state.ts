import { z } from "zod";

export type Phase = "SOURCE" | "ASSESS" | "AUDIT" | "FINALIZE" | "DONE";

export const Requirement = z.object({ id: z.string(), text: z.string(), kind: z.enum(["must", "nice"]) });
export type Requirement = z.infer<typeof Requirement>;

export interface Evidence { requirementId: string; start: number; end: number; quote: string; strength: "strong" | "partial"; basis: "explicit" | "implied"; by: "local" | "jev" | "claude"; confidence: number }

export interface CandidateState {
  id: string;
  name: string;
  semantic: number; // best cosine seen in SOURCE (visible view)
  seen: number; // how many searches returned this candidate
  coverage: Record<string, number>; // requirementId → best cosine of any sentence (visible view)
  evidence: Evidence[];
  failedClaims: { requirementId: string; quote: string; reason: string }[];
  flags: string[]; // prompt_injection, grader_disagreement, ...
  dropped?: string; // reason
  assessment?: { id: string; questions: { id?: string; kind: "short" | "scenario" | "code"; prompt: string; rubric: string; tests?: { input: string; expected: string }[]; targets: string[] }[]; emailSubject: string; emailBody: string; unverified: string[] };
  assessV2?: { claims: any[]; plan: any; jdSkills: string[]; source: "generated" | "company"; verifiedByEvidence: string[]; matches?: any[] }; // persisted plan from the assessment module
  claimVerdicts?: { claimId: string; skill: string; claim: string; status: "verified" | "contradicted" | "not_tested"; score?: number; reason: string; questions: string[]; cause?: "code_timeout" }[];
  sent?: { channel: "resend" | "outbox"; at: number };
  responses?: { kind: "short" | "scenario" | "code"; answer: string; questionId?: string }[];
  grade?: { total: number; parts: { kind: string; score: number; confidence: number; testsPassed?: number; testsTotal?: number; note?: string }[]; regraded: boolean; flaggedForHr?: string };
  final?: number;
}

export interface FairnessAudit {
  ids: string[];
  weights: { semantic: number; assessment: number };
  rows: { id: string; name: string; gender: string; tier: number; visibleRank: number; hiddenRank: number; delta: number; visibleScore: number; hiddenScore: number }[];
  spearman: number;
  top5Overlap: number;
  split: { visible: { gender: Record<string, number>; tier: Record<string, number> }; hidden: { gender: Record<string, number>; tier: Record<string, number> } };
  findings: string[];
  recommendBlind: boolean;
}

export interface AgentState {
  runId: string;
  roleKey: string;
  chaos: Record<string, boolean>;
  jd: { raw: string; title: string; seniority: string; requirements: Requirement[] };
  phase: Phase;
  targetN: number;
  reformulations: number;
  toolCalls: { n: number; name: string; reason: string; ok: boolean; summary: string; phase: Phase }[];
  searches: { query: string; mode?: "semantic" | "keyword" | "hybrid"; view: "visible" | "redacted"; k: number; source: string; top: { id: string; score: number }[] }[];
  candidates: Record<string, CandidateState>;
  shortlist: string[]; // proposed to HR
  approval?: { approved: string[]; removed: string[] };
  audit?: FairnessAudit;
  memoryApplied: string[];
  degraded: string[]; // banners
  nudges: number;
  codeTimeoutProbe?: string; // candidate whose simulated code answer was replaced by a never-returning one (planted case)
  final?: { ranked: string[]; weights: { semantic: number; assessment: number }; summary: string; officialBlind: boolean };
  runSummary?: { toolCalls: number; reformulations: number; dropped: { id: string; name: string; reason: string }[]; llm: any; cascade: any };
}

export function newState(runId: string, roleKey: string, raw: string, chaos: Record<string, boolean> = {}): AgentState {
  return {
    runId, roleKey, chaos,
    jd: { raw, title: "", seniority: "", requirements: [] },
    phase: "SOURCE", targetN: 5, reformulations: 0, toolCalls: [], searches: [], candidates: {}, shortlist: [], memoryApplied: [], degraded: [], nudges: 0,
  };
}

export const WEIGHTS = { semantic: 0.6, assessment: 0.4 };

export function mustHaves(s: AgentState) { return s.jd.requirements.filter((r) => r.kind === "must"); }

export function hasFullEvidence(c: CandidateState, s: AgentState) {
  const musts = mustHaves(s);
  return musts.every((r) => c.evidence.some((e) => e.requirementId === r.id));
}

export function evidencedCandidates(s: AgentState) {
  return Object.values(s.candidates).filter((c) => !c.dropped && hasFullEvidence(c, s));
}
