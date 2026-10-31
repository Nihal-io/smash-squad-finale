# Deploy (Railway)

Localhost is the primary demo. The deployed URL is the backup and the judges' link.

## One-time setup

1. Railway → **New Project → Deploy from GitHub repo** → pick this repository, branch `main`.
   Railway detects Bun from `bun.lock`. Set the start command to `bun run start` (Settings → Deploy).
   Build command: `bun run build` (default is fine).
2. **Add a volume** mounted at `/data` (Service → Volumes → Add). This keeps the app database and the embedding model between deploys.
3. **Variables** (Service → Variables):

   | Variable | Value |
   |---|---|
   | `DB_PATH` | `/data/app.db` |
   | `MODEL_CACHE` | `/data/models` |
   | `ANTHROPIC_API_KEY` | your key |
   | `LLM_MODEL` | `claude-haiku-5-5` |
   | `LLM_BUDGET_USD` | `2` |
   | `APP_PASSCODE` | a short passcode judges type once |
   | `DATABASE_URL` | optional: Supabase pooler URL for pgvector + checkpoints; without it search runs in memory over the same vectors |
   | `RESEND_API_KEY`, `RESEND_TEST_TO` | optional: real email to a test inbox; otherwise sends go to the outbox |
   | `PORT` | set by Railway automatically |

4. Deploy. Every push to `main` redeploys.

## What happens on boot

- `PORT`, `DB_PATH`, `MODEL_CACHE` are read from env (defaults `3000`, `./data/app.db`, `./.cache/models`).
- If `data/candidates.json` or `data/vectors.bin` is missing, the seed pipeline runs once: synthetic planted set → public dataset download → enrichment → local embeddings of both views. The committed data files make this a no-op on a normal deploy.
- If `DATABASE_URL` is set and the `candidates` table is empty, it is loaded.
- `GET /health` returns 200 with `{ok, db, llm, candidates}`.
- Every page and API route except `/health` and `/api/passcode` requires the passcode cookie.

## Budget

`LLM_BUDGET_USD` is enforced inside the LLM wrapper. Once reached, further calls are refused, the trace shows the refusal, and the run finishes with the work already done (embedding-only ranking, local evidence checks, fairness audit). Identical calls are cached, so re-running the three preset JDs costs nothing after the first pass.

## Local

```bash
bun install
cp .env.example .env.local   # fill in ANTHROPIC_API_KEY, optional DATABASE_URL
bun run dev                  # http://localhost:3000
bun run eval                 # eval/results.json → Eval tab
bun run agent 0              # CLI run on preset 1, auto-approves
```
