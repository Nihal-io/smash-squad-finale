// Postgres access with an in-memory fallback over the same vectors. Env is read inside functions.
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { EMBED_DIM } from "./embed";
import { BM25, rrf } from "./bm25";
import { referralSnapshot, referralCandidate } from "../referrals/store";

export interface CandidateRow {
  id: string;
  source: string;
  name: string;
  gender: string;
  college: string;
  tier: number;
  yoe: number;
  role: string;
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
  if (!pool) pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 3, connectionTimeoutMillis: 6000 });
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
    dbDownUntil = Date.now() + 30_000;
    return false;
  }
}

// ---------- in-memory store over the same vectors ----------
interface Mem { candidates: CandidateRow[]; byId: Map<string, CandidateRow>; index: Map<string, number>; vectors: Float32Array }
let mem: Mem | null = null;
let referralVersion = '';

export function loadMemory(): Mem {
  const referrals = referralSnapshot();
  if (!mem || referralVersion !== referrals.version) {
    const candidates = JSON.parse(readFileSync("data/candidates.json", "utf8")) as CandidateRow[];
    const buf = readFileSync("data/vectors.bin");
    const baseVectors = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    if (baseVectors.length !== candidates.length * 2 * EMBED_DIM) throw new Error("vectors.bin does not match candidates.json; run bun run embed");
    const vectors = new Float32Array(baseVectors.length + referrals.records.length * 2 * EMBED_DIM);
    vectors.set(baseVectors);
    referrals.records.forEach((record, i) => {
      const off = baseVectors.length + i * 2 * EMBED_DIM;
      vectors.set(record.visibleVector, off); vectors.set(record.redactedVector, off + EMBED_DIM);
      candidates.push(referralCandidate(record));
    });
    mem = { candidates, byId: new Map(candidates.map((c) => [c.id, c])), index: new Map(candidates.map((c, i) => [c.id, i])), vectors };
    referralVersion = referrals.version;
    bm25Index.visible = undefined; bm25Index.redacted = undefined;
  }
  return mem;
}

export function memVector(id: string, mode: Mode): Float32Array | null {
  const m = loadMemory();
  const i = m.index.get(id);
  if (i === undefined) return null;
  const off = i * 2 * EMBED_DIM + (mode === "visible" ? 0 : EMBED_DIM);
  return m.vectors.subarray(off, off + EMBED_DIM);
}

export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < EMBED_DIM; i++) s += a[i] * b[i];
  return s;
}

export function memorySearch(queryVec: ArrayLike<number>, mode: Mode, k: number, filter?: (c: CandidateRow) => boolean): SearchHit[] {
  const m = loadMemory();
  const hits: SearchHit[] = [];
  const off0 = mode === "visible" ? 0 : EMBED_DIM;
  for (let i = 0; i < m.candidates.length; i++) {
    if (filter && !filter(m.candidates[i])) continue;
    const off = i * 2 * EMBED_DIM + off0;
    let s = 0;
    for (let j = 0; j < EMBED_DIM; j++) s += queryVec[j] * m.vectors[off + j];
    hits.push({ id: m.candidates[i].id, score: s });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, k);
}

// ---------- search with fallback ----------
export async function vectorSearch(queryVec: ArrayLike<number>, mode: Mode, k: number, filters?: { minYoe?: number; maxYoe?: number }): Promise<{ hits: SearchHit[]; source: "pgvector" | "memory" }> {
  if (await dbHealthy()) {
    try {
      const col = mode === "visible" ? "emb_visible" : "emb_redacted";
      const where: string[] = [];
      const params: any[] = [`[${Array.from(queryVec).join(",")}]`, k];
      if (filters?.minYoe !== undefined) { params.push(filters.minYoe); where.push(`yoe >= $${params.length}`); }
      if (filters?.maxYoe !== undefined) { params.push(filters.maxYoe); where.push(`yoe <= $${params.length}`); }
      const r = await getPool()!.query(
        `select id, 1 - (${col} <=> $1::vector) as score from candidates ${where.length ? "where " + where.join(" and ") : ""} order by ${col} <=> $1::vector limit $2`,
        params,
      );
      const hits = new Map<string, SearchHit>(r.rows.map((x: any) => [x.id, { id: x.id, score: Number(x.score) }]));
      // Uploaded resumes live in a private sidecar, including when the seed pool is in Postgres.
      for (const h of memorySearch(queryVec, mode, k, c => c.source === 'referral' &&
        (filters?.minYoe === undefined || c.yoe >= filters.minYoe) && (filters?.maxYoe === undefined || c.yoe <= filters.maxYoe))) hits.set(h.id,h);
      return { hits: [...hits.values()].sort((a,b) => b.score-a.score).slice(0,k), source: "pgvector" };
    } catch {
      dbDownUntil = Date.now() + 30_000;
    }
  }
  const f = filters ? (c: CandidateRow) => (filters.minYoe === undefined || c.yoe >= filters.minYoe) && (filters.maxYoe === undefined || c.yoe <= filters.maxYoe) : undefined;
  return { hits: memorySearch(queryVec, mode, k, f), source: "memory" };
}

// ---------- keyword (BM25) and hybrid (RRF) over the same pool ----------
const bm25Index: Partial<Record<Mode, BM25>> = {};
function bm25For(mode: Mode): BM25 {
  loadMemory(); // Refresh the keyword index after an upload in this or another process.
  if (!bm25Index[mode]) {
    const { candidates } = loadMemory();
    bm25Index[mode] = new BM25(candidates.map((c) => ({ id: c.id, text: mode === "visible" ? c.visible_text : c.redacted_text })));
  }
  return bm25Index[mode]!;
}

export function keywordSearch(query: string, mode: Mode, k: number, filter?: (c: CandidateRow) => boolean): SearchHit[] {
  const { byId } = loadMemory();
  return bm25For(mode).search(query, filter ? k * 4 : k).filter((h) => !filter || filter(byId.get(h.id)!)).slice(0, k);
}

export type SearchMode = "semantic" | "keyword" | "hybrid";
export interface PoolHit { id: string; score: number; cosine: number }

export async function searchPool(queryVec: ArrayLike<number>, query: string, mode: SearchMode, view: Mode, k: number, filters?: { minYoe?: number; maxYoe?: number }): Promise<{ hits: PoolHit[]; source: "pgvector" | "memory" }> {
  const f = filters ? (c: CandidateRow) => (filters.minYoe === undefined || c.yoe >= filters.minYoe) && (filters.maxYoe === undefined || c.yoe <= filters.maxYoe) : undefined;
  const cosineOf = (id: string) => { const v = memVector(id, view); return v ? dot(queryVec, v) : 0; };
  if (mode === "keyword") {
    return { hits: keywordSearch(query, view, k, f).map((h) => ({ id: h.id, score: h.score, cosine: cosineOf(h.id) })), source: "memory" };
  }
  const sem = await vectorSearch(queryVec, view, mode === "hybrid" ? k * 4 : k, filters);
  if (mode === "semantic") return { hits: sem.hits.map((h) => ({ id: h.id, score: h.score, cosine: h.score })), source: sem.source };
  const kw = keywordSearch(query, view, k * 4, f);
  const fused = rrf([sem.hits.map((h) => h.id), kw.map((h) => h.id)]);
  const semScore = new Map(sem.hits.map((h) => [h.id, h.score]));
  return { hits: fused.slice(0, k).map((x) => ({ id: x.id, score: x.score, cosine: semScore.get(x.id) ?? cosineOf(x.id) })), source: sem.source };
}

export async function getCandidates(ids: string[]): Promise<CandidateRow[]> {
  if (ids.length === 0) return [];
  if (await dbHealthy()) {
    try {
      const r = await getPool()!.query(
        `select id,source,name,gender,college,tier,yoe,role,skills,projects,bio,visible_text,redacted_text,archetype,planted,planted_for,flags from candidates where id = any($1)`,
        [ids],
      );
      const byId = new Map(r.rows.map((x: any) => [x.id, x as CandidateRow]));
      return ids.map((id) => byId.get(id) ?? getCandidateLocal(id)).filter((c): c is CandidateRow => !!c);
    } catch {
      dbDownUntil = Date.now() + 30_000;
    }
  }
  const { byId } = loadMemory();
  return ids.map((id) => byId.get(id)!).filter(Boolean);
}

export function getCandidateLocal(id: string): CandidateRow | undefined {
  return loadMemory().byId.get(id);
}

export async function sql<T = any>(text: string, params: any[] = []): Promise<T[] | null> {
  if (!(await dbHealthy())) return null;
  try {
    const r = await getPool()!.query(text, params);
    return r.rows as T[];
  } catch {
    dbDownUntil = Date.now() + 30_000;
    return null;
  }
}
