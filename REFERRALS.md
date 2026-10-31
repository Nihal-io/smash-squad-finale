# Referral resume uploads

This branch adds an HR referral intake alongside the existing seeded candidate pool. Open the **Referrals** link in the main navigation, or visit `/referrals.html` after entering the app passcode.

## Demo workflow

1. Enter a candidate name, optionally enter experience, and upload a PDF, DOCX, or UTF-8 TXT resume.
2. Select an existing job run, a JD preset, or paste the current JD. The Referrals link carries the main screen's current JD into this page.
3. Select one to ten uploaded referrals and click **Check selected resumes**. Review semantic similarity, cited resume evidence, and missing requirements. These are matching signals; quoting a resume does not prove its claims.
4. Approve the candidates who should receive assessments. The workflow uses the existing assessment module: candidate-specific generated questions by default, or the authoritative JSON pack at `data/assessments/active.json` when configured.
5. Read the invitation in the existing main app outbox. With Resend configured, the existing mailer delivers to `RESEND_TEST_TO`, the configured test inbox. This branch does not add direct delivery to a candidate email address or a public response portal.
6. Collect actual replies and paste them beside the saved questions in the referral screen. Click **Grade actual received answers**. The saved assessment plan is used for grading and claim verification; candidate identity is not added to the grading prompt.
7. Review the score and claim results: **verified**, **contradicted**, or **not tested**. Missing evidence, unusable grades, and low confidence do not establish a contradiction. HR makes the hiring decision.

Real uploaded referrals never receive the seeded demo's simulated responses. The generic simulation function explicitly rejects candidates whose source is `referral`; use the dedicated Referrals workflow for them. Its HR review accepts even one candidate rather than requiring the existing demo's minimum batch. A single-candidate audit explicitly says it cannot establish ranking fairness.

## Setup and storage

Use the repository's existing Bun setup and provider configuration. Install the new dependencies with `bun install`, then use `bun run dev`. `unpdf` 2.x requires Node 24 or newer when running the server with Node. Text extraction uses `unpdf` for PDF, `mammoth` for DOCX, and a strict UTF-8 decoder for TXT; no OCR service is included.

- Maximum file size: **3 MB**. PDF maximum: **20 pages**. Extracted text: **80–60,000 characters**. DOCX archives declaring more than 10 MB of expanded data or 2,000 entries are rejected.
- The existing local embedding model indexes both visible and redacted text. The first upload needs the model already cached or permission to download it, just like existing embedding functionality.
- A newly uploaded resume needs live assessment-provider access; the seeded demo's cached responses are not a substitute. Provider failures stop the run visibly without creating fictional answers or scores. Start a new check after fixing configuration.
- Extracted text and vectors live in `referrals/` beside `DB_PATH`: by default `data/referrals/`; on the documented Railway volume, `/data/referrals/`. Original PDF/DOCX/TXT bytes are not retained.
- `data/referrals/` is ignored by Git. Use a private persistent volume and the existing passcode gate for referral records, run state, answers, traces, and outbox. Changing `DB_PATH` changes which referrals are visible. A custom data directory must also stay outside committed source and publicly served directories.
- Duplicate uploads with the same normalized candidate name, exact extracted text, and experience reuse their record. Filenames are display metadata, not storage paths. Unknown gender and college are left unspecified; the app does not infer them.
- Redaction removes the supplied candidate name, existing supported pronouns, email addresses, and phone numbers. It cannot guarantee removal of every identity detail embedded in arbitrary prose. Grading uses the module's answer-only prompt contract.

The seeded `data/candidates.json`, `data/vectors.bin`, CSV/dataset import, existing assessments, and database migrations are untouched. The memory/vector/keyword lookup layer appends private referral records at runtime and refreshes its caches after uploads. If Postgres is available, vector results include local referrals alongside Postgres results; referral records themselves stay in the private sidecar rather than being written into the seeded Postgres table.

This retains the project's file-backed, single-service deployment model and background processing. It is not a new distributed job queue or a multi-tenant hiring system.

## API

All routes inherit the existing passcode middleware.

- `GET /api/referrals`: referral metadata, without resume text or embeddings.
- `POST /api/referrals`: multipart `file`, `name`, optional `years`; returns the candidate ID and duplicate flag. The body is bounded even without `Content-Length`.
- `POST /api/referrals/workflow`: JSON actions:
  - `check`: `candidateIds` and either `sourceRunId`, `presetId`, or `jdText`. An existing run/preset is authoritative when selected. Returns a new `runId`.
  - `approve`: `runId`, `approved` IDs from that run's shortlist. An empty approval finishes without invitations.
  - `submit`: `runId`, `candidateId`, `answers` keyed by saved question ID. Blank submissions, unknown questions, duplicate submissions, and invalid workflow transitions are rejected.
- `GET /api/referrals/workflow?runId=...`: status, matching evidence, safe question content, grades, and claim results. It excludes answer keys, rubrics, and hidden tests. Existing administrator run endpoints retain their existing access and behavior.

States progress through `running → waiting_approval → running → waiting_responses → running → done`. With several approved candidates, the run returns to `waiting_responses` until each candidate has submitted. Provider failures produce `failed`.

## Files and integration

Most implementation is isolated in `src/referrals/`, `app/api/referrals/`, and `public/referrals.*`. Small shared changes append referral records to search, add `waiting_responses` to stored statuses, distinguish actual responses in the shortlist contract, block simulated referral answers, externalize the document parsers for Next, and add one navigation link. No existing assessment-module implementation is replaced.

## Validation and teammate handoff

```sh
bun test tests/referrals tests/assess
bun run typecheck
bun run build
```

Validated locally: **31 passing tests**, TypeScript check, and a successful Next production build. Tests cover real PDF/DOCX/TXT extraction, limits and malformed files, duplicate handling, seed-file hashes, search cache refresh, HR approval, waiting for actual replies, grading secrecy, no simulated referral responses, failure handling, and both generated/company assessment sources. Workflow tests inject deterministic dependencies and exercise the real assessment planner/MCQ grading/verifier; they do not claim a live provider/email delivery test. The existing assessment tests also run their generated and company-pack evaluations.

The Windows sandbox prevented Bun's package installer from renaming its temporary lockfile. Dependencies were installed with npm for local verification, and the existing Bun lock was extended with the installed registry versions/integrities while preserving previous resolutions; `bun pm ls mammoth unpdf --all` parses the result. A clean frozen Bun install still needs to be checked in the teammate's normal environment.

The branch starts from the updated main snapshot. Shared-file edits are deliberately small, and the dataset is unchanged. Recheck the comparison against the latest main before merging, because later teammate changes can still introduce conflicts. This branch does not merge itself or create a pull request.
