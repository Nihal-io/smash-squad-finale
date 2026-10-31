// Fairness track: for each of the 12 planted JDs, rerank a pool of 8 labelled candidates on identity-redacted vectors
// and compare with the visible ranking. Deterministic, no LLM involved.
process.env.DB_PATH = "./data/eval-app.db";

import { readFileSync } from "node:fs";

export interface FairnessCase { jdId: string; title: string; ids: string[]; spearman: number; top5Overlap: number; recommendBlind: boolean; moves: number; maxMove: number }

export async function runFairnessEval(): Promise<{ summary: { meanSpearman: number; meanTop5Overlap: number; jds: number; blindRecommended: number; poolPerJd: number }; cases: FairnessCase[] }> {
  const { newState } = await import("../agent/state");
  const { fairnessAudit } = await import("../agent/fairness");
  const { getCandidateLocal } = await import("../lib/db");

  const { jds } = JSON.parse(readFileSync("data/jds.json", "utf8"));
  const { labels } = JSON.parse(readFileSync("data/eval-labels.json", "utf8"));
  const cases: FairnessCase[] = [];

  for (const jd of jds) {
    const lab = labels[jd.id];
    if (!lab) continue;
    const ids: string[] = [...new Set<string>([...lab.trueFits, ...lab.stuffers])].filter((id) => !!getCandidateLocal(id)).slice(0, 8);
    const state = newState(`eval_fair_${jd.id}`, jd.archetype ?? jd.id, jd.text);
    state.jd.title = jd.title;
    state.jd.seniority = jd.seniority;
    state.jd.requirements = [
      ...jd.mustHave.map((t: string, i: number) => ({ id: `m${i + 1}`, text: t, kind: "must" as const })),
      ...jd.niceToHave.map((t: string, i: number) => ({ id: `n${i + 1}`, text: t, kind: "nice" as const })),
    ];
    for (const id of ids) {
      const c = getCandidateLocal(id)!;
      state.candidates[id] = { id, name: c.name, semantic: 0, seen: 0, coverage: {}, evidence: [], failedClaims: [], flags: [] };
    }
    const a = await fairnessAudit(state, ids);
    const moves = a.rows.filter((r) => Math.abs(r.delta) >= 3).length;
    const maxMove = Math.max(0, ...a.rows.map((r) => Math.abs(r.delta)));
    cases.push({ jdId: jd.id, title: jd.title, ids, spearman: a.spearman, top5Overlap: a.top5Overlap, recommendBlind: a.recommendBlind, moves, maxMove });
    console.log(`  ${jd.id}: rho ${a.spearman} top5 overlap ${a.top5Overlap} moves>=3 ${moves} max move ${maxMove}${a.recommendBlind ? " (recommend blind)" : ""}`);
  }

  const mean = (xs: number[]) => (xs.length ? +(xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(3) : 0);
  return {
    summary: {
      meanSpearman: mean(cases.map((c) => c.spearman)),
      meanTop5Overlap: mean(cases.map((c) => c.top5Overlap)),
      jds: cases.length,
      blindRecommended: cases.filter((c) => c.recommendBlind).length,
      poolPerJd: cases.length ? Math.round(cases.reduce((s, c) => s + c.ids.length, 0) / cases.length) : 0,
    },
    cases,
  };
}
