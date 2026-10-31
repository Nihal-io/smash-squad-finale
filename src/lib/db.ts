// Postgres access with an in-memory fallback. Env is read inside functions, never at module top level.
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { cosine } from "./embed";

export interface CandidateRow {
  id: string;
  name: string;
  gender: string;
  college: string;
  tier: number;
  yoe: number;
  skills: string[];
  projects: string[];
  bio: string;
  visible_text: string;
  redacted_text: string;
  archetype: string;
  planted: string;
  planted_for: string | null;
  flags: string[];
}

export type Mode = "visible" | "redacted";
export interface SearchHit { id: string; score: number }

let pool: Pool | null = null;
let dbDownUntil = 0;

export function getPool(): Pool | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  if (!pool) pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 4, connectionTimeoutMillis: 6000 });
  return pool;
}

export function chaosDbDown(): boolean {
  return process.env.CHAOS_DB_DOWN === "1" || Date.now() < dbDownUntil;
}

export async function dbHealthy(): Promise<boolean> {
  if (chaosDbDown()) return false;
  const p = getPool();
  if (!p) return false;
  try {
    await p.query("select 1");
    return true;
  } catch {
    dbDownUntil = Date.now() + 30_000; // stop hammering a dead DB for 30s
    return false;
  }
}

// ---------- in-memory fallback over the same vectors ----------
let memCandidates: CandidateRow[] | null = null;
let memVectors: Record<string, { visible: number[]; redacted: number[] }> | null = null;

export function loadMemory() {
  if (!memCandidates) memCandidates = JSON.parse(readFileSync("data/candidates.json", "utf8"));
  if (!memVectors) memVectors = JSON.parse(readFileSync("data/vectors.json", "utf8"));
  return { candidates: memCandidates!, vectors: memVectors! };
}

export function memorySearch(queryVec: number[], mode: Mode, k: number): SearchHit[] {
  const { vectors } = loadMemory();
  const hits: SearchHit[] = [];
  for (const [id, v] of Object.entries(vectors)) hits.push({ id, score: cosine(queryVec, v[mode]) });
  return hits.sort((a, b) => b.score - a.score).slice(0, k);
}

// ---------- search with fallback ----------
export async function vectorSearch(queryVec: number[], mode: Mode, k: number): Promise<{ hits: SearchHit[]; source: "pgvector" | "memory" }> {
  if (await dbHealthy()) {
    try {
      const col = mode === "visible" ? "emb_visible" : "emb_redacted";
      const r = await getPool()!.query(
        `select id, 1 - (${col} <=> $1::vector) as score from candidates order by ${col} <=> $1::vector limit $2`,
        [`[${queryVec.join(",")}]`, k],
      );
      return { hits: r.rows.map((x: any) => ({ id: x.id, score: Number(x.score) })), source: "pgvector" };
    } catch {
      dbDownUntil = Date.now() + 30_000;
    }
  }
  return { hits: memorySearch(queryVec, mode, k), source: "memory" };
}

export async function getCandidates(ids: string[]): Promise<CandidateRow[]> {
  if (ids.length === 0) return [];
  if (await dbHealthy()) {
    try {
      const r = await getPool()!.query(
        `select id,name,gender,college,tier,yoe,skills,projects,bio,visible_text,redacted_text,archetype,planted,planted_for,flags from candidates where id = any($1)`,
        [ids],
      );
      const byId = new Map(r.rows.map((x: any) => [x.id, x as CandidateRow]));
      return ids.map((id) => byId.get(id)!).filter(Boolean);
    } catch {
      dbDownUntil = Date.now() + 30_000;
    }
  }
  const { candidates } = loadMemory();
  const byId = new Map(candidates.map((c) => [c.id, c]));
  return ids.map((id) => byId.get(id)!).filter(Boolean);
}

export async function allCandidates(): Promise<CandidateRow[]> {
  return loadMemory().candidates;
}
