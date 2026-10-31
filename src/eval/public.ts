// Public track: 100 sampled jobs from michaelozon/candidate-matching-synthetic with their ground-truth matches,
// restricted to resumes present in our pool. Semantic vs BM25 vs hybrid (reciprocal rank fusion).
// Labels are skill-overlap based, so BM25 may tie or win. Reported as measured. No LLM calls.
import { parquetReadObjects } from "hyparquet";
import { readFileSync } from "node:fs";
import { embedTexts, QUERY_PREFIX } from "../lib/embed";
import { memorySearch, loadMemory } from "../lib/db";
import { BM25, rrf as rrfScored } from "../lib/bm25";
import { mulberry32 } from "../lib/synth";

interface Job { job_id: string; job_title: string; seniority: string; industry: string; must_have_skills: string[]; nice_to_have_skills: string[]; description: string; requirements: string[] }

function jobText(j: Job) {
  return `${j.job_title} (${j.seniority}). Must have: ${j.must_have_skills.join(", ")}. Nice to have: ${j.nice_to_have_skills.join(", ")}. ${j.description} ${j.requirements.join(". ")}`;
}

function metricsAt10(ranked: string[], relevant: Set<string>) {
  const top = ranked.slice(0, 10);
  const recall = top.filter((id) => relevant.has(id)).length / Math.max(1, relevant.size);
  let dcg = 0;
  top.forEach((id, i) => { if (relevant.has(id)) dcg += 1 / Math.log2(i + 2); });
  let idcg = 0;
  for (let i = 0; i < Math.min(10, relevant.size); i++) idcg += 1 / Math.log2(i + 2);
  return { recall10: recall, ndcg10: idcg ? dcg / idcg : 0 };
}

export function rrf(lists: string[][], k = 60): string[] {
  return rrfScored(lists, k).map((x) => x.id);
}

function readParquet<T>(path: string): Promise<T[]> {
  const buf = readFileSync(path);
  const file = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return parquetReadObjects({ file }) as Promise<T[]>;
}

export async function runPublicEval(nJobs = Number(process.env.PUBLIC_EVAL_JOBS || 100)) {
  const { candidates } = loadMemory();
  const poolIds = new Set(candidates.filter((c) => c.source === "hf").map((c) => c.id));
  const jobs = await readParquet<Job>("data/hf/jobs.parquet");
  const matches = await readParquet<{ job_id: string; relevant_resume_ids: string[] }>("data/hf/matches.parquet");
  const rel = new Map(matches.map((m) => [m.job_id, m.relevant_resume_ids.filter((id) => poolIds.has(id))]));

  // Jobs with at least 5 relevant resumes inside our pool, sampled with a fixed seed.
  const eligible = jobs.filter((j) => (rel.get(j.job_id)?.length ?? 0) >= 5);
  const rand = mulberry32(42);
  const sampled = [...eligible].sort(() => rand() - 0.5).slice(0, nJobs);

  const hfDocs = candidates.filter((c) => c.source === "hf");
  const bm25 = new BM25(hfDocs.map((c) => ({ id: c.id, text: c.visible_text })));
  const qvecs = await embedTexts(sampled.map((j) => QUERY_PREFIX + jobText(j)), 32);

  // Label-free check using the dataset's own relevance rule: a resume qualifies when it has >=60% of the must-have skills.
  const byId = new Map(hfDocs.map((c) => [c.id, c]));
  const passes = (c: { skills: string[] }, j: Job) => j.must_have_skills.filter((s) => c.skills.includes(s)).length / Math.max(1, j.must_have_skills.length) >= 0.6;
  const rule60 = (ids: string[], j: Job) => ids.slice(0, 10).filter((id) => passes(byId.get(id)!, j)).length / 10;
  const qualifying = (j: Job) => hfDocs.filter((c) => passes(c, j)).length;

  const rows = sampled.map((j, i) => {
    const relevant = new Set(rel.get(j.job_id)!);
    const sem = memorySearch(qvecs[i], "visible", 50, (c) => c.source === "hf").map((h) => h.id);
    const kw = bm25.search(jobText(j), 50).map((h) => h.id);
    const hy = rrf([sem, kw]);
    return {
      jobId: j.job_id, title: j.job_title, relevantInPool: relevant.size, qualifyingInPool: qualifying(j),
      semantic: { ...metricsAt10(sem, relevant), rule60at10: rule60(sem, j) },
      bm25: { ...metricsAt10(kw, relevant), rule60at10: rule60(kw, j) },
      hybrid: { ...metricsAt10(hy, relevant), rule60at10: rule60(hy, j) },
    };
  });
  const mean = (f: (r: (typeof rows)[number]) => number) => +(rows.reduce((s, r) => s + f(r), 0) / rows.length).toFixed(3);
  const summary = {
    jobs: rows.length,
    eligibleJobs: eligible.length,
    poolSize: hfDocs.length,
    semantic_recall10: mean((r) => r.semantic.recall10),
    semantic_ndcg10: mean((r) => r.semantic.ndcg10),
    bm25_recall10: mean((r) => r.bm25.recall10),
    bm25_ndcg10: mean((r) => r.bm25.ndcg10),
    hybrid_recall10: mean((r) => r.hybrid.recall10),
    hybrid_ndcg10: mean((r) => r.hybrid.ndcg10),
    semantic_rule60at10: mean((r) => r.semantic.rule60at10),
    bm25_rule60at10: mean((r) => r.bm25.rule60at10),
    hybrid_rule60at10: mean((r) => r.hybrid.rule60at10),
    meanLabelledInPool: mean((r) => r.relevantInPool),
    meanQualifyingInPool: mean((r) => r.qualifyingInPool),
  };
  return {
    summary,
    cases: rows,
    note: `The dataset labels 30 resumes per job out of all that pass its own rule (>=60% must-have skill overlap). In our pool a job has on average ${summary.meanQualifyingInPool} qualifying resumes but only ${summary.meanLabelledInPool} labelled ones, so Recall@10 and nDCG@10 against the labels are capped low for every method. rule60at10 applies the dataset's own rule to each method's top 10 and is label-complete.`,
  };
}
