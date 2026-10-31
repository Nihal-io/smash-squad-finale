// Prints, for the latest run (or a given run id), one table per approved candidate:
// claim -> matched requirement -> similarity -> question(s) asked -> verdict.
//   bun run scripts/assess-report.ts [runId]
import { readFileSync } from "node:fs";

const db = JSON.parse(readFileSync(process.env.DB_PATH || "./data/app.db", "utf8"));
const runs = Object.values(db.runs ?? {}) as any[];
const run = process.argv[2] ? db.runs[process.argv[2]] : runs.sort((a, b) => b.createdAt - a.createdAt)[0];
if (!run) throw new Error("no run found");
const s = run.state;
console.log(`run ${run.id} · ${s.jd.title} · status ${run.status}`);
const fallbackLines = (db.events[run.id] ?? []).filter((e: any) => e.kind === "note" && /Automatic fallback: assessment module/.test(e.payload?.text ?? ""));
console.log(`assessment-module fallback lines in trace: ${fallbackLines.length}`);
const approved: string[] = s.approval?.approved ?? [];
let allOk = true;
for (const id of approved) {
  const c = s.candidates[id];
  const v2 = c.assessV2;
  const nQ = c.assessment?.questions?.length ?? 0;
  console.log(`\n== ${c.name} (${id}) · source ${v2 ? v2.source : "built-in"} · ${nQ} question(s)${nQ < 2 ? "  <-- FEWER THAN 2" : ""}`);
  if (nQ < 2 || !v2) allOk = false;
  if (!v2) { console.log("   (no module plan; built-in path)"); continue; }
  const verdictOf = (claimId: string) => (c.claimVerdicts ?? []).find((x: any) => x.claimId === claimId);
  const qText = (qid: string) => v2.plan.questions.find((q: any) => q.id === qid)?.prompt ?? qid;
  const rows = (v2.matches ?? []).map((m: any) => {
    const qs: string[] = (v2.plan.coverage?.[m.claimId] ?? []).map(qText);
    const vd = verdictOf(m.claimId);
    return [m.skill, (m.claim ?? "").slice(0, 60), m.requirement ? `${m.requirementId} ${m.requirement}` : "-", m.similarity.toFixed(2), m.targeted ? "target" : m.verifiedBy ? `verified (${m.verifiedBy})` : "skip", qs.length ? qs.map((q) => q.slice(0, 70)).join(" | ") : "-", vd ? `${vd.status}${vd.score != null ? " " + vd.score : ""}` : "-"];
  });
  const head = ["claim skill", "claim", "matched requirement", "sim", "handling", "question(s) asked", "verdict"];
  const widths = head.map((h, i) => Math.min(72, Math.max(h.length, ...rows.map((r: string[]) => String(r[i]).length))));
  const fmt = (r: string[]) => r.map((x, i) => String(x).slice(0, widths[i]).padEnd(widths[i])).join("  ");
  console.log("   " + fmt(head));
  for (const r of rows) console.log("   " + fmt(r));
}
console.log(`\nRESULT: ${allOk && fallbackLines.length === 0 ? "PASS" : "FAIL"} (every approved candidate has a module plan with >=2 questions: ${allOk}; fallback lines: ${fallbackLines.length})`);
