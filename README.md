# Reverse Match

HR posts a job description and waits; the best people never apply. Reverse Match sends one agent to the candidate pool instead. It finds people by what they have done rather than the words they used, backs every claim with a verbatim quote from the profile, asks HR before it contacts anyone, assesses and grades, and then audits its own ranking with names, colleges and gender hidden.

## Run it

```bash
bun install            # needs ANTHROPIC_API_KEY in .env.local; DATABASE_URL (Supabase pgvector) is optional
bun run dev            # http://localhost:3000  (data and vectors are committed; boot seeds them if missing)
bun run eval           # writes eval/results.json, shown on the Eval tab
```

`bun run demo:reset` clears runs and the outbox and restores agent memory to the shipped snapshot; the model cache is kept, so the three presets replay with zero API calls. `bun run agent 0` runs preset 1 from the CLI. Deployment: `DEPLOY.md`. Demo script: `DEMO.md`. API: `API.md`.

## Architecture

1. **Pool**: 2,000 public resumes (MIT dataset) enriched deterministically with synthetic names, genders and college tiers, plus a planted set of true fits, keyword-stuffers, tier-3 gems and one prompt-injection profile. Visible and identity-redacted text, both embedded locally with bge-small (384-d) into pgvector, with an in-memory fallback over the same vectors.
2. **Agent**: a LangGraph loop; each step is one model decision that picks one of 15 tools, with a one-line reason streamed to the trace. Phases SOURCE → ASSESS → AUDIT → FINALIZE exit only when code says so.
3. **Gates in code**: `send_assessment` throws without an HR approval record for that exact candidate; `finalize_shortlist` throws without a fairness audit on that exact id set and a validated span behind every claim. HR approval is a LangGraph interrupt.
4. **Decisions** (requirement support, injection, unlawful criteria, short-answer pass) run through a cascade: local rules and embeddings first, an optional JEV classifier, then Claude only when earlier tiers are unsure. Every decision is logged with tier, confidence and cost.
5. **Generation** lives in one file, `src/lib/llm.ts`: provider by env, every call cached by hash, spend tracked and capped by `LLM_BUDGET_USD`, Zod on every structured output with one repair retry. Grading combines a rubric grade with hidden tests run in a QuickJS sandbox.
6. **Fairness audit**: the shortlist is re-ranked on redacted vectors; the UI shows rank moves, Spearman ρ, top-5 overlap and the gender and tier split of each top 5, with a toggle to make the blind ranking official.

## Eval (`bun run eval`)

| Track | Result |
|---|---|
| Planted retrieval, 12 JDs, judged candidates, nDCG@5 / P@5 / R@10 | semantic **0.198 / 0.267 / 0.604** · hybrid 0.062 / 0.083 / 0.275 · keyword 0.000 / 0.000 / 0.133 |
| Public dataset, 100 jobs, R@10 / nDCG@10 | semantic 0.026 / 0.038 · keyword 0.029 / 0.038 · hybrid 0.034 / 0.046 (labels cover 13 of ~384 qualifying resumes per job, so all three are capped near zero; by the dataset's own ≥60% skill rule at 10: semantic 0.85, keyword 0.95, hybrid 0.95) |
| Guardrails | 7/7: unlawful criteria stripped, injection not boosted, model outage, send before approval, DB down, budget cap, malformed output |
| Agent, 3 planted JDs | success 3/3, 0 guardrail violations, P@5 1.0, 26 tool calls and ~100 s per run |
| Decision cascade, 36 labelled cases | cascade accuracy 1.0, agreement with all-Claude 1.0, 69% escalated; $0.000 vs $0.003 all-Claude on cached runs |
| Fairness, 12 JDs | mean Spearman ρ 0.745, mean top-5 overlap 0.83, blind ranking recommended on 1 of 12 |

Hybrid scores below semantic on the planted set because the true fits never use the JD's words while the keyword-stuffers repeat them, so the keyword half of the fusion pulls stuffers up and fits down; on real resumes, where skill names are shared vocabulary, keyword and hybrid win (see the public track).

## Limitations

- Candidates are synthetic; names, genders and colleges are assigned at random, so the fairness numbers describe this pool, not the world.
- Candidate answers are simulated by the model from each fictional profile and labelled as such; emails go to an outbox unless a Resend key is set.
- The intake guardrail catches the common phrasings by rule and sends the rest to the model; paraphrased discriminatory lines can still slip through when no model is available.
- The JEV classifier tier is wired but not connected; the cascade runs local → Claude.

## Credits

Assessment module (claim extraction, targeted questions, grading and claim verification in `src/assess`): Ritvik Yadgirkar. Public resumes from `michaelozon/candidate-matching-synthetic` (MIT). Embeddings: `Xenova/bge-small-en-v1.5` via transformers.js. LangGraph.js, pgvector, QuickJS, hyparquet. Full list with licenses in `CREDITS.md`. No real people appear in the data.
