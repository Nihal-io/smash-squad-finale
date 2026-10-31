# Assessment module

The module validates resume skill claims after HR shortlists a candidate. It does not make hiring decisions or establish whether an entire resume is true. A contradiction means assessment evidence fell below the applicable threshold for that claim.

## Pipeline

```ts
extractClaims(resumeText: string, llm: LLM): Promise<Claim[]>
generateQuestions(claims: Claim[], jdSkills: string[], llm: LLM, limits?: Limits): Promise<Question[]>
loadAssessment(input: string, format?: 'json'): AssessmentPack
planAssessment(claims: Claim[], pack: AssessmentPack, jdSkills: string[], opts?: { minConfidence?: number }): Plan
planGeneratedQuestions(claims: Claim[], questions: Question[], limits?: Limits): Plan
gradeAnswers(plan: Plan, answers: Record<string, string>, llm: LLM): Promise<Grade[]>
verifyClaims(claims: Claim[], plan: Plan, grades: Grade[]): ClaimResult[]
runAssessment(resumeText: string, jdSkills: string[], answers: Record<string, string>, llm: LLM, pack?: AssessmentPack): Promise<{ questions: Question[]; grades: Grade[]; claimResults: ClaimResult[] }>
toCandidateQuestions(questions: Question[]): CandidateQuestion[]
gradeCode(question: Question, answer: string): { status: 'pending'; reason: string }
```

`LLM` is `(prompt: string, schema: z.ZodType) => Promise<unknown>`. The injected adapter converts the supplied Zod schema into its provider's structured-output format. Every response is parsed locally with Zod even when the provider promises structured output. Tests require no model API key. Zod must be installed by the host app; this module adds no package manifest changes.

## Shortlist, invite, submit

The core owns HR approval, storage, candidate authentication, email or messenger delivery, scheduling and answer submission. Use the staged functions for the real invitation workflow:

```ts
import {
  extractClaims, generateQuestions, loadAssessment, planAssessment,
  planGeneratedQuestions, toCandidateQuestions, gradeAnswers, verifyClaims,
} from './assess';

const claims = await extractClaims(resumeText, llm);
const plan = packJSON
  ? planAssessment(claims, loadAssessment(packJSON), jdSkills)
  : planGeneratedQuestions(claims, await generateQuestions(claims, jdSkills, llm));

// Core: show planned questions to HR for approval, then persist { claims, plan }
// under an assessment ID and candidate ID. Keep this record on the server.
const candidateQuestions = toCandidateQuestions(plan.questions);
// Core: send an authenticated assessment link by email/messenger after HR approval.
// Only candidateQuestions may be rendered to the candidate; Plan contains keys.

// Later, retrieve the SAME saved claims/plan when answers arrive:
const grades = await gradeAnswers(plan, submittedAnswers, llm);
const claimResults = verifyClaims(claims, plan, grades);
// Core: show claimResults and raw scores on HR's shortlist cards.
```

`runAssessment` is a convenience for callers already holding answers to the questions their LLM adapter will return, and offline evaluation. Do not call it once to invite and again to submit: regenerating could change question wording, IDs or answer keys. Persist the staged plan instead. An unanswered or unanswered-in-part claim is `not_tested`, so a pre-invitation run does not manufacture contradictions.

## Question sources and thresholds

Generated questions are the default. Only unverified claims whose normalized skill matches a JD skill are sent to generation. The prompt includes the assertion so candidates claiming different work receive questions targeted to their work. Raw evidence and resume identity fields are excluded from generation. Generated coverage IDs and skills must match real targeted claims. Invalid outputs or budgets fail closed; no static fallback is silently used.

A JSON company pack overrides generation entirely. Its question text, answer keys, rubrics, weights and pass mark are preserved. Required questions always appear; impossible required-question budgets raise an error. Remaining questions are selected greedily by uncovered JD claim coverage, then other claims, using pack order to break ties. Skill matching uses case-insensitive, whitespace-normalized exact labels; the caller should normalize aliases such as JS/JavaScript consistently. A multi-skill question covers each listed skill.

Pass marks and scores are fractions in `[0, 1]`. The default threshold is 0.7 if no company mark is supplied, and 0.7 for generated assessments. A pack may explicitly use 0. `estimatedMinutes` defaults to 5 per question; provide it for accurate time budgeting. The host enforces actual elapsed assessment time.

MCQs use full option text as `answerKey` and require the candidate to submit that text. Keyed short answers and MCQs use Unicode-normalized, case-insensitive, whitespace-normalized exact matching. Rubrics are used only when no answer key exists. Rubric grading sends only question text, rubric and submitted answer text to the LLM. It receives no candidate record, resume, name, gender or college metadata. The answer itself is untrusted text. A rubric grader failure or invalid output produces unusable evidence.

Claim scores are question-weighted means. Every relevant question must have a usable grade with confidence at least 0.7 (configurable on the plan). Missing answers, pending code, invalid grades and low confidence leave the claim `not_tested`. Usable scores at or above the applicable threshold are `verified`; lower scores are `contradicted`. A claim without coverage is `not_tested`. Code is never executed here; `gradeCode` returns `pending` / `needs sandbox`. A future server sandbox integration may supply validated code grades to `verifyClaims`.

## Validation

```sh
bun test tests/assess
bun run tests/assess/eval.ts
```

The data directory contains two JSON company packs, ten synthetic resumes, honest and inflated answer sets, expected per-source labels, and a question bank used only by the offline LLM double. The eval runs every resume against generated questions and both packs. It reports accuracy, recall of contradicted claims, and false contradictions on honest candidates. It measures deterministic module behavior with a stub, not live-model extraction/generation/grading quality. Production adapters need a separate live-model evaluation.

Only `src/assess/**`, `tests/assess/**` and `data/assessments/**` belong in the target PR.
