// Deterministic fairness audit: rerank the shortlist on REDACTED vectors and text, compare with the visible ranking.
import { embedTexts, QUERY_PREFIX } from "../lib/embed";
import { memVector, dot, getCandidateLocal } from "../lib/db";
import { sentences } from "../lib/decide";
import type { AgentState, FairnessAudit } from "./state";
import { WEIGHTS } from "./state";

export function spearman(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 2) return 1;
  let d2 = 0;
  for (let i = 0; i < n; i++) d2 += (a[i] - b[i]) ** 2;
  return +(1 - (6 * d2) / (n * (n * n - 1))).toFixed(3);
}

async function requirementVecs(s: AgentState) {
  const reqs = s.jd.requirements;
  const vecs = await embedTexts(reqs.map((r) => QUERY_PREFIX + `${s.jd.title}: experience with ${r.text}`));
  return reqs.map((r, i) => ({ id: r.id, text: r.text, weight: r.kind === "must" ? 2 : 1, vec: vecs[i] }));
}

function coverageScore(id: string, view: "visible" | "redacted", reqs: { weight: number; vec: number[] }[]) {
  const v = memVector(id, view);
  if (!v) return 0;
  const W = reqs.reduce((s, r) => s + r.weight, 0);
  return reqs.reduce((s, r) => s + r.weight * dot(r.vec, v), 0) / W;
}

export async function fairnessAudit(s: AgentState, ids: string[]): Promise<FairnessAudit> {
  const reqs = await requirementVecs(s);
  const rows = ids.map((id) => {
    const c = getCandidateLocal(id)!;
    const st = s.candidates[id];
    const assess = st?.grade ? st.grade.total : null;
    const semV = coverageScore(id, "visible", reqs);
    const semH = coverageScore(id, "redacted", reqs);
    const wA = assess === null ? 0 : WEIGHTS.assessment;
    const wS = 1 - wA;
    return { id, name: c.name, gender: c.gender, tier: c.tier, visibleScore: wS * semV + wA * (assess ?? 0), hiddenScore: wS * semH + wA * (assess ?? 0), semV, semH };
  });
  const vis = [...rows].sort((a, b) => b.visibleScore - a.visibleScore).map((r) => r.id);
  const hid = [...rows].sort((a, b) => b.hiddenScore - a.hiddenScore).map((r) => r.id);
  const out = rows.map((r) => {
    const visibleRank = vis.indexOf(r.id) + 1;
    const hiddenRank = hid.indexOf(r.id) + 1;
    return { id: r.id, name: r.name, gender: r.gender, tier: r.tier, visibleRank, hiddenRank, delta: visibleRank - hiddenRank, visibleScore: +r.visibleScore.toFixed(4), hiddenScore: +r.hiddenScore.toFixed(4) };
  }).sort((a, b) => a.visibleRank - b.visibleRank);
  const rho = spearman(out.map((r) => r.visibleRank), out.map((r) => r.hiddenRank));
  const top5v = new Set(vis.slice(0, 5)), top5h = new Set(hid.slice(0, 5));
  const overlap = +([...top5v].filter((x) => top5h.has(x)).length / Math.max(1, Math.min(5, ids.length))).toFixed(3);
  const split = (top: string[]) => {
    const g: Record<string, number> = {}, t: Record<string, number> = {};
    for (const id of top) { const c = getCandidateLocal(id)!; g[c.gender] = (g[c.gender] ?? 0) + 1; t[`tier${c.tier}`] = (t[`tier${c.tier}`] ?? 0) + 1; }
    return { gender: g, tier: t };
  };

  // Findings: inspect any candidate who moved 3+ places. Which requirement's text similarity changed most once identity was hidden?
  const findings: string[] = [];
  for (const r of out) {
    if (Math.abs(r.delta) < 3) continue;
    const c = getCandidateLocal(r.id)!;
    const sentV = sentences(c.visible_text), sentH = sentences(c.redacted_text);
    const [vv, hh] = await Promise.all([embedTexts(sentV.map((x) => x.text)), embedTexts(sentH.map((x) => x.text))]);
    let worst = { req: "", diff: 0, before: "", after: "" };
    for (const q of reqs) {
      let bv = -1, bvi = 0, bh = -1, bhi = 0;
      vv.forEach((v, i) => { const d = dot(q.vec, v); if (d > bv) { bv = d; bvi = i; } });
      hh.forEach((v, i) => { const d = dot(q.vec, v); if (d > bh) { bh = d; bhi = i; } });
      if (Math.abs(bv - bh) > worst.diff) worst = { req: q.text, diff: Math.abs(bv - bh), before: sentV[bvi]?.text ?? "", after: sentH[bhi]?.text ?? "" };
    }
    const dir = r.delta > 0 ? `fell from #${r.visibleRank} to #${r.hiddenRank}` : `rose from #${r.visibleRank} to #${r.hiddenRank}`;
    const drivers = [c.tier === 1 ? "tier-1 college" : c.tier === 3 ? "tier-3 college" : null, /\[COMMUNITY\]|\[STUDENT ORG\]|\[GROUP\]/.test(c.redacted_text) ? "a gender-coded affiliation" : null].filter(Boolean).join(" and ");
    findings.push(`${c.name} ${dir} with identity hidden. The biggest shift was on "${worst.req}" (similarity moved ${worst.diff.toFixed(2)}); the redaction removed ${drivers || "name and pronouns"} from the sentence "${worst.before.slice(0, 110)}".`);
  }
  const recommendBlind = overlap < 0.8;
  if (recommendBlind) findings.push(`Top-5 overlap is ${(overlap * 100).toFixed(0)}%, below 80%: recommend using the blind ranking as the official shortlist.`);
  else findings.push(`Top-5 overlap is ${(overlap * 100).toFixed(0)}% and Spearman ρ is ${rho}: identity had little effect on this ranking.`);

  return { ids, weights: WEIGHTS, rows: out, spearman: rho, top5Overlap: overlap, split: { visible: split(vis.slice(0, 5)), hidden: split(hid.slice(0, 5)) }, findings, recommendBlind };
}
