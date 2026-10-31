# API

All routes live under the Next.js app (Node runtime). Every page and API route except `/health` and `/api/passcode` requires the passcode cookie `rm_pass` (set by `POST /api/passcode`); unauthenticated requests get `401 {"error":"passcode required"}`. When `APP_PASSCODE` is unset, the gate is off.

Types referenced below are in `src/contracts.ts`.

## GET /health
`200 {"ok":true,"db":"pgvector"|"memory","llm":"anthropic"|"openai-compatible"|"stub","candidates":2180}`

## POST /api/passcode
Request `{"passcode":"..."}` → `200 {"ok":true}` + `Set-Cookie: rm_pass=<hash>; HttpOnly; Path=/` or `401 {"ok":false}`.

## GET /api/presets
`200 {"presets": Preset[]}` — 3 presets; `presets[0].unlawful === true` (contains a line the agent must strip).

## POST /api/run
Request `{"jdText": string, "presetId"?: string, "roleKey"?: string}`. Chaos flags are global (see /api/chaos).
Response `202 {"runId":"run_abc123"}`. The run executes in the background; follow it on the events stream.

## GET /api/run/:id
`200 {"run": Run, "state": AgentState | null, "shortlist": ShortlistItem[], "spend": SpendSummary, "cascade": CascadeSummary, "outbox": OutboxRecord[]}`
`run.status ∈ running | waiting_approval | done | failed`.

## GET /api/run/:id/events  (Server-Sent Events)
Replays every stored Step for the run, then streams live ones. Each message: `event: step\ndata: <Step JSON>\n\n`. A `event: status\ndata: {"status": "..."}` message follows every status change. Heartbeat comment every 15s. Reconnecting replays from the start (idempotent by `seq`).

Step kinds and payloads the UI should render:
| kind | payload |
|---|---|
| `start` | `{roleKey, presetId, chaos, cascade}` |
| `phase` | `{phase:"INTAKE"\|"SOURCE"\|"ASSESS"\|"AUDIT"\|"FINALIZE", text}` |
| `refusal` | `{kind:"unlawful_criteria", line, reason}` or `{kind:"prompt_injection", candidateId, name, text}` |
| `parsed` | `{title, seniority, requirements: Requirement[], refused:[{line,reason}]}` |
| `reason` | `{n, text, source:"llm"\|"auto"}` — the one-line reason before tool call n |
| `tool_call` | `{n, name, input, phase}` — `search_candidates.input.mode` ∈ semantic \| keyword \| hybrid; `cite_evidence.input.citations[]` = `{requirement_id, quote}` |
| `tool_result` | `{n, name, ok, result}` or `{n, name, ok:false, error}` — for `cite_evidence`, `result.results[]` = `{requirement_id, accepted, strength, basis:"explicit"\|"implied", decidedBy, confidence, span:[start,end]}` |
| `gate_blocked` | `{n, gate, name, text}` |
| `decision` | `{task, by:"local"\|"jev"\|"claude", label, confidence, costUsd, input, rationale}` |
| `llm` | `{purpose, cached, costUsd, wouldCost?, model, ms?, usage?}` |
| `note` | `{text, banner?: "llm"\|"db"\|"budget"\|"memory"\|"limit", candidateId?, simulated?}` |
| `interrupt` | `{kind:"hr_approval", candidateIds, rationale, candidates:[{id,name,semantic,evidence,flags}]}` → show the approval modal |
| `approval` | `{approved, removed}` |
| `audit` | `FairnessAudit` |
| `done` | `{final:{ranked, weights, summary, officialBlind}, summary:{toolCalls, reformulations, dropped, llm, cascade}, degraded}` |
| `error` | `{text}` |

## POST /api/run/:id/approve
Request `{"approved": string[], "removed": string[]}` → `200 {"ok":true}`; `409` if the run is not waiting for approval. Resumes the agent in the background.

## POST /api/run/:id/feedback
Request `{"note": string, "rejectedCandidateId"?: string, "preferredSkills"?: string[]}` → `200 {"ok":true}`. Saved per role; the next run for that role applies it (`note` event with `banner:"memory"`).

## GET /api/runs
`200 {"runs": Run[]}` newest first (state omitted).

## GET /api/candidates/:id
`200 Candidate` (includes `visible_text` and `redacted_text`; evidence spans index into `visible_text`). `404` if unknown.

## GET /api/chaos · POST /api/chaos
GET → `200 ChaosFlags`. POST `{"LLM_OUTAGE"?:bool,"DB_DOWN"?:bool,"BUDGET_ZERO"?:bool}` → `200 ChaosFlags`. Flags apply to runs started afterwards (and to in-flight LLM calls).

## GET /api/spend
`200 {"spend": SpendSummary, "cascade": CascadeSummary, "cacheEntries": number}` — totals across all runs.

## GET /api/eval
`200` the contents of `eval/results.json` (`{generatedAt, headline, public?, planted?, guardrails?, fairness?, agent?, cascade?}`), or `404` if the eval has not been run.

## Mock mode for the UI
`public/index.html?mock=1` must render every screen from built-in fixture data shaped exactly like the responses above, without calling the backend.
