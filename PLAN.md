# PLAN.md — Recruiter Reverse-Matching Copilot (amended)

**One sentence.** HR posts a JD; a single tool-using agent sources candidates by meaning, cites verbatim evidence, asks HR before sending anything, assesses and grades, audits its own ranking with identity hidden, and hands back a shortlist with proof.

**User.** A recruiter. **Before:** post, wait, screen whoever applies. **After:** the agent goes to the pool and returns a shortlist with quoted evidence and a fairness audit. Every decision it made is visible in the trace.

---

## 0. Status at the time of this amendment

Done and working in `finale/smash-squad-finale`: repo scaffold, deps, `.env.local` with pooler `DATABASE_URL` (verified), 180 synthetic candidates seeded, redaction, local bge-small embeddings (8s for 360 texts), pgvector tables + HNSW loaded, retrieval eval running. Uncommitted.

**Retrieval eval today (planted, 180-pool):** semantic nDCG@5 0.153 vs BM25 0.034; recall@10 0.52 vs 0.20; tier-3 gems in top-5: 0.5 vs 0.08. Problem: keyword-stuffers still reach the semantic top-5 (3 of 5 on average) because bge-small rewards literal overlap with the raw JD text. Fix in §5: the agent searches per requirement cluster, not the raw JD, and `cite_evidence` drops stuffers that cannot back a claim. Both numbers get reported.

**Still missing:** the Anthropic key is not in `finale/smash-squad-finale/.env.local` (variable list has no key). Add `LLM_API_KEY=...`, `LLM_PROVIDER=anthropic`, `LLM_MODEL=claude-haiku-5-5` (or whatever cheapest model your key can use).

---

## 1. Architecture — one supervisor agent inside phase gates

```
app/                       Next.js App Router (Node runtime; never edge)
  page.tsx                 JD input | live trace (reason → call → result) | shortlist with evidence
  fairness/ eval/          tabs
  api/run                  POST start run → runId
  api/run/[id]/events      SSE stream; replays persisted events on refresh
  api/run/[id]/approve     POST → resumes the LangGraph interrupt with HR's kept list
  api/run/[id]/feedback    POST → save_memory
src/lib/
  llm.ts                   ONLY LLM caller. provider via env; sha256 cache (Postgres + memory);
                           spend meter; budget refusal; Zod validate + 1 repair retry; backoff;
                           Anthropic prompt caching on the system+tools prefix; temperature 0.
  embed.ts db.ts bm25.ts redact.ts   (exist)   sandbox.ts mailer.ts trace.ts hf.ts
src/agent/
  supervisor.ts            LangGraph tool-calling loop: llm → tool → llm … with phase state
  phases.ts                SOURCE → ASSESS → AUDIT → FINALIZE; exit conditions in code
  gates.ts                 throws: send without approval record; finalize without audit/spans
  tools/*.ts               one file per tool, Zod input schema, every schema starts with `reason`
  prompts/supervisor.ts    phase-aware system prompt; candidate text always wrapped as DATA
src/eval/  public.ts planted.ts agent.ts guardrails.ts index.ts   → eval/results.json
scripts/   seed.ts (exists) fetch-hf.ts enrich.ts embed.ts (exists) migrate.ts (exists) prewarm.ts
```

**Loop.** State = `{runId, phase, jd, requirements, toolCalls[], candidates{}, evidence{}, approvals{}, assessments{}, grades{}, audit?, dropped[], memoryApplied[]}`. Each step: the supervisor LLM sees the phase, its exit condition, a compact view of state, and the tool results so far; it returns one tool call whose first field is `reason` (one line). The runtime streams `reason → call → result` as three trace events, executes the tool, checks gates, updates state, and either advances the phase or loops. Limits: 25 tool calls per run, `LLM_BUDGET_USD`, 2 re-plan attempts flagged by the planner itself.

**Phases and exit conditions (code, not prompt).**
| Phase | Exit when | Tools allowed |
|---|---|---|
| SOURCE | ≥ N candidates (N from plan, 5–8) each with validated evidence for every must-have, or 2 reformulations exhausted | search_candidates, get_profile, cite_evidence, recall_memory, request_hr_approval |
| ASSESS | every approved candidate has a graded assessment, or chaos/budget stop | create_assessment, send_assessment, collect_responses, run_code, grade_answer |
| AUDIT | fairness_audit ran on the current shortlist | fairness_audit, get_profile, save_memory |
| FINALIZE | finalize_shortlist succeeded | finalize_shortlist, save_memory |

**Gates (throw, logged as `gate_blocked` trace events).** `send_assessment` → needs an approval record for that exact candidate id in this run. `finalize_shortlist` → needs an audit on this exact id set and a validated span behind every claim. A phase advance → exit condition true.

**Memory.** LangGraph PostgresSaver checkpoints every step (refresh-safe; the approval interrupt resumes). `recall_memory(role)` loads HR notes from earlier runs and emits "applied from earlier session".

**Real tools (≥3).** pgvector search · Postgres read/write · Resend/outbox · quickjs sandbox · HF dataset API fetch (at seed time).

---

## 2. Tools (exact signatures, all with a leading `reason`)

| Tool | Does | Guard |
|---|---|---|
| `search_candidates(query, k, filters?, view)` | pgvector cosine on `emb_visible` or `emb_redacted`; DB down → memory | returns id, score, 1-line snippet |
| `get_profile(id)` | full profile text | text wrapped as DATA; injection pattern flagged, never followed |
| `cite_evidence(candidate_id, requirement, quote)` | verbatim check → char offsets stored | rejects non-verbatim; no span, no claim |
| `recall_memory(role)` / `save_memory(role, note)` | hr_feedback table | — |
| `request_hr_approval(candidate_ids, rationale)` | LangGraph interrupt → UI modal | nothing sends without the resume payload |
| `create_assessment(candidate_id, unverified_requirements)` | LLM sub-call: short answer + scenario + coding task with hidden tests, targeted at the unverified must-haves | plain-language email copy |
| `send_assessment(candidate_id, assessment_id)` | Resend to test inbox or outbox row | **gate** |
| `collect_responses(assessment_ids)` | LLM sub-call, in character, varied quality, cached | UI badge "Simulated" |
| `run_code(code, tests)` | quickjs-emscripten, CPU/time limits | sandboxed |
| `grade_answer(question, answer, rubric, test_results?)` | LLM sub-call → score + confidence | disagreement/low confidence → re-grade or flag |
| `fairness_audit(shortlist_ids)` | deterministic rerank on redacted vectors; rank Δ, Spearman ρ, top-5 overlap, gender/tier split | real numbers only |
| `finalize_shortlist(ranked_ids, weights, summary)` | ends run | **gate** |

---

## 3. Decisions the agent makes (visible in trace)

1. Splits the JD into requirement-cluster searches; after seeing score spread and must-have coverage it reformulates or relaxes (max 2).
2. Opens borderline profiles and tries `cite_evidence` per must-have; drops candidates whose claims fail and logs why.
3. Builds each assessment from the must-haves it could not verify, so different candidates get different questions.
4. Re-grades or flags when the LLM grade and code tests disagree or confidence is low.
5. After the audit: any rank move ≥ 3 → inspects the profile and writes a finding; top-5 overlap < 80% → recommends blind ranking.

**Proof.** Two preset JDs produce visibly different tool-call sequences (the trace shows the sequence as a strip). Every run ends with a summary: tool calls, re-plans, dropped candidates and reasons.

---

## 4. Data

**Public base (MIT, credited in CREDITS.md):** `michaelozon/candidate-matching-synthetic`. Verified via HF API: `resumes/train-00000-of-00001.parquet` (10,000; role, seniority, industry, years_experience, skills[], summary, bullets), `jobs/…parquet` (2,500; job_title, seniority, industry, must_have_skills[], description), `matches/…parquet` (2,500; job_id → 30 relevant_resume_ids). Read with `hyparquet` (MIT, pure JS).

**Pool:** 2,000 tech/data resumes (embedding both views for all 10,000 ≈ 7–8 min at the measured rate, over the 5-minute limit). **Enrichment (seed 42, deterministic):** name, gender, college tier and 2 role-specific project lines from template banks with synonym variation; gender and college drawn independently of skills. VISIBLE and REDACTED texts as today.

**Planted on top (kept from the current seed):** 12 JDs × (4–6 true fits in different words, 3 keyword-stuffers, 1–2 tier-3 gems) + 1 injection resume. Labels in `data/eval-labels.json`.

---

## 5. Evaluation — three tracks, `bun run eval` → `eval/results.json` → /eval

| Track | Cases | Metrics | Honesty note |
|---|---|---|---|
| Public | 100 sampled jobs with their 30 matches | Recall@10, nDCG@10: semantic vs BM25 vs hybrid (RRF) | labels are skill-overlap, BM25 may tie or win; reported as is |
| Planted | 12 JDs | P@5, R@10, nDCG@5 for semantic vs BM25, with (a) raw-JD query and (b) requirement-split queries; stuffers-in-top-5; gems-in-top-5 | current raw-JD result is in §0 |
| Agent | full agent on 12 planted JDs, cached | task success rate, guardrail violations (target 0), P@5 of final shortlist, mean tool calls per run | one paid pass (~$1.5 est., see §7), cached forever after |
| Guardrails | G1 unlawful criteria stripped + refusal · G2 injection not boosted and flagged · G3 LLM outage degrades to embedding-only · G4 send before approval throws · G5 DB down → memory fallback, same top-5 · G6 budget 0 → clean stop · G7 bad JSON → repair → visible failure | pass/fail | — |

Headline printed as one line.

---

## 6. 90-second demo

1. Preset "Senior Backend, Retrieval Platform" (contains the unlawful line). Post.
2. Trace: `parse` strips "female, under 28, IIT only, unmarried" → **refused** chip with reason; continues.
3. SOURCE: reason lines scroll: "must-have 'vector search' covered by 2 of 6; searching 'ANN index / retrieval infra' on redacted-safe phrasing" → second search → `cite_evidence` ×N → one candidate dropped: "claims Postgres, no span found". Injection resume: "instruction text in profile ignored and flagged". "Applied from earlier session: HR rejected c0xx last run."
4. Approval modal: remove one, approve. ASSESS: assessments differ per candidate (chips show the unverified must-haves each one targets). Outbox fills. Responses badge "Simulated". `run_code` test results; one grade flagged for disagreement.
5. AUDIT: fairness panel side by side, arrows, ρ, overlap, splits; a finding on a ≥3-place move. Toggle blind ranking as official.
6. FINALIZE summary: tool calls, re-plans, dropped and why. Switch to preset 2: visibly different tool sequence strip.
7. Eval tab: three tracks, headline. Chaos → LLM outage → banner, embedding-only ranking.

---

## 7. Budget estimate

Haiku-class pricing assumed (~$1/M in, $5/M out; overridable via `LLM_PRICE_IN_PER_M`, `LLM_PRICE_OUT_PER_M`). Supervisor step ≈ 5k input (system+tools prefix cached) + 150 output. ~20 steps/run → ~$0.08/run; 12 agent-eval runs + 3 presets + sub-calls ≈ **$1.5**. Cap stays at $3. If the first two runs exceed $0.15 each, the agent eval drops to 6 JDs.

---

## 8. Clock from "go" (≈2h15 remain)

| Δ | Work | Commit |
|---|---|---|
| 0:00–0:25 | fetch-hf.ts (API list → parquet), hyparquet, enrich 2,000, planted on top, re-embed, reload pgvector, public + planted eval | "public dataset, enrichment, retrieval eval" |
| 0:25–1:05 | llm.ts, supervisor loop, phases/gates, SOURCE tools (search, profile, cite, memory, approval), fairness_audit, finalize; CLI run on preset 1 | "supervisor agent with gates and fairness audit" |
| 1:05–1:35 | UI: SSE trace with reason/call/result, approval modal, shortlist + span highlight, fairness tab | "ui: trace, approval, shortlist, fairness" |
| 1:35–1:55 | ASSESS tools: assessment, send, collect, run_code, grade; memory | "assessment, sandbox grading, hr memory" |
| 1:55–2:10 | guardrail cases, chaos, agent eval pass, /eval page, prewarm presets | "guardrails, chaos, eval page" |
| 2:10–2:15 | freeze: copy pass, README, CREDITS, two clean demo runs | "docs and demo polish" |

**Cut order if >15 min behind:** Resend → outbox only · collect_responses → seeded answers · cross-session memory → per-run · public-track eval → 50 jobs · agent eval → 6 JDs. **Never cut:** shortlist + evidence, fairness, approval gate, one refusal, eval page.

**STOPPED. Type "go".**
