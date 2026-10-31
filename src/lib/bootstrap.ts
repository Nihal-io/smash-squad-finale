// First-boot data preparation: builds the candidate corpus and vectors when missing, and loads pgvector when empty.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

function runStep(script: string): void {
  console.log(`[bootstrap] running ${script}`);
  const r = spawnSync("bun", ["run", script], { stdio: "inherit", env: process.env });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${script} exited with status ${r.status}`);
}

export async function ensureData(): Promise<void> {
  process.env.HF_CACHE_DIR = process.env.MODEL_CACHE || "./.cache/models";

  if (!existsSync("data/candidates.json") || !existsSync("data/vectors.bin")) {
    console.log("[bootstrap] data files missing, running seed pipeline");
    for (const s of ["scripts/seed.ts", "scripts/fetch-hf.ts", "scripts/enrich.ts", "scripts/embed.ts"]) runStep(s);
  } else {
    console.log("[bootstrap] data files present");
  }

  if (!process.env.DATABASE_URL) {
    console.log("[bootstrap] DATABASE_URL not set, using in-memory vectors");
    return;
  }
  const { dbHealthy, sql } = await import("./db");
  if (!(await dbHealthy())) {
    console.log("[bootstrap] database unreachable, skipping migrate");
    return;
  }
  const rows = await sql<{ n: number }>("select count(*)::int as n from candidates");
  if (rows === null || !rows[0] || rows[0].n === 0) {
    console.log("[bootstrap] candidates table empty or missing, running migrate");
    runStep("scripts/migrate.ts");
  } else {
    console.log(`[bootstrap] database already holds ${rows[0].n} candidates`);
  }
}
