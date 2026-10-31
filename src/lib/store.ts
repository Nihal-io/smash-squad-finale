// File-backed app state at DB_PATH (default ./data/app.db). Runs, trace events, LLM cache, spend, HR memory,
// outbox, approvals and decisions all live here so the app keeps working when Postgres is unreachable.
// Writes are whole-file, atomic (write temp + rename). Scale is a hackathon's worth of runs.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync } from "node:fs";
import { dirname } from "node:path";

export interface TraceEvent {
  seq: number;
  runId: string;
  ts: number;
  kind: string; // phase | reason | tool_call | tool_result | gate_blocked | refusal | decision | llm | note | error | interrupt | done
  node?: string;
  payload: any;
}

export interface RunRecord {
  id: string;
  roleKey: string;
  jdText: string;
  presetId?: string;
  status: "running" | "waiting_approval" | "done" | "failed" | "stopped";
  chaos: Record<string, boolean>;
  createdAt: number;
  updatedAt: number;
  state?: any; // supervisor state snapshot
  summary?: any;
}

export interface SpendRecord { runId?: string; model: string; purpose: string; inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number; costUsd: number; cached: boolean; ts: number }
export interface DecisionRecord { runId?: string; task: string; by: "local" | "jev" | "claude"; label: string; confidence: number; costUsd: number; counterfactualUsd: number; ts: number; input: any }
export interface MemoryRecord { roleKey: string; runId?: string; note: string; rejectedCandidateId?: string; preferredSkills?: string[]; ts: number }
export interface OutboxRecord { id: string; runId: string; candidateId: string; to: string; subject: string; body: string; channel: "resend" | "outbox"; status: string; ts: number }

interface Db {
  runs: Record<string, RunRecord>;
  events: Record<string, TraceEvent[]>;
  cache: Record<string, { response: any; costUsd: number; model: string; ts: number }>;
  spend: SpendRecord[];
  decisions: DecisionRecord[];
  memory: MemoryRecord[];
  outbox: OutboxRecord[];
  approvals: Record<string, { candidateIds: string[]; approvedAt: number; removed: string[] }>;
}

const EMPTY: Db = { runs: {}, events: {}, cache: {}, spend: [], decisions: [], memory: [], outbox: [], approvals: {} };

let db: Db | null = null;
let dirty = false;
let flushTimer: NodeJS.Timeout | null = null;
let loadedMtime = 0;

export function dbPath() {
  return process.env.DB_PATH || "./data/app.db";
}

// Several processes (dev server, CLI runs, prewarm) share the file. Reads and writes both MERGE the on-disk copy with
// memory instead of replacing either: a run keeps whichever copy was updated last, event lists keep the longer one,
// append-only lists are unioned. Nothing a process wrote is lost because another process wrote in between.
function mergeInto(mine: Db, other: Partial<Db>, preferMine: boolean): Db {
  const out: Db = { ...EMPTY, ...mine };
  for (const [id, r] of Object.entries(other.runs ?? {})) {
    const m = out.runs[id];
    if (!m) out.runs[id] = r;
    else if (preferMine ? (r.updatedAt > m.updatedAt && !dirty) : r.updatedAt >= m.updatedAt) out.runs[id] = r;
  }
  for (const [id, list] of Object.entries(other.events ?? {})) {
    const m = out.events[id];
    if (!m || list.length > m.length) out.events[id] = list;
  }
  out.approvals = { ...(other.approvals ?? {}), ...out.approvals };
  out.memory = mergeByTs(other.memory ?? [], out.memory);
  out.spend = mergeByTs(other.spend ?? [], out.spend);
  out.decisions = mergeByTs(other.decisions ?? [], out.decisions);
  out.outbox = mergeByTs(other.outbox ?? [], out.outbox);
  return out;
}

function readDisk(p: string): Partial<Db> | null {
  try { return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Partial<Db>) : null; } catch { return null; }
}

function load(): Db {
  const p = dbPath();
  let mtime = 0;
  try { mtime = existsSync(p) ? statSync(p).mtimeMs : 0; } catch {}
  if (db && mtime === loadedMtime) return db;
  const disk = readDisk(p);
  db = db ? (disk ? mergeInto(db, disk, true) : db) : { ...EMPTY, ...(disk ?? {}) };
  loadedMtime = mtime;
  return db!;
}

function flushNow() {
  if (!db || !dirty) return;
  const p = dbPath();
  mkdirSync(dirname(p), { recursive: true });
  try {
    if (existsSync(p) && statSync(p).mtimeMs !== loadedMtime) {
      const other = readDisk(p);
      if (other) db = mergeInto(db, other, true);
    }
  } catch {}
  writeFileSync(p + ".tmp", JSON.stringify(db));
  renameSync(p + ".tmp", p);
  dirty = false;
  try { loadedMtime = statSync(p).mtimeMs; } catch {}
}

type CacheDb = Db["cache"];
let cacheDb: CacheDb | null = null;
let cacheDirty = false;
let cacheMtime = 0;
let cacheTimer: NodeJS.Timeout | null = null;
export function cachePath() { return process.env.LLM_CACHE_PATH || "./data/llm-cache.db"; }
function loadCache(): CacheDb {
  const p = cachePath();
  if (cacheDb && cacheDirty) return cacheDb;
  let mtime = 0;
  try { mtime = existsSync(p) ? statSync(p).mtimeMs : 0; } catch {}
  if (cacheDb && mtime === cacheMtime) return cacheDb;
  try { const disk = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {}; cacheDb = { ...disk, ...(cacheDb ?? {}) }; } catch { cacheDb = cacheDb ?? {}; }
  cacheMtime = mtime;
  return cacheDb!;
}
function flushCache() {
  if (!cacheDb || !cacheDirty) return;
  const p = cachePath();
  mkdirSync(dirname(p), { recursive: true });
  try { if (existsSync(p) && statSync(p).mtimeMs !== cacheMtime) cacheDb = { ...JSON.parse(readFileSync(p, "utf8")), ...cacheDb }; } catch {}
  writeFileSync(p + ".tmp", JSON.stringify(cacheDb));
  renameSync(p + ".tmp", p);
  cacheDirty = false;
  try { cacheMtime = statSync(p).mtimeMs; } catch {}
}

function mergeByTs<T extends { ts: number }>(a: T[], b: T[]): T[] {
  const seen = new Set(b.map((x) => JSON.stringify(x)));
  return [...a.filter((x) => !seen.has(JSON.stringify(x))), ...b];
}

function mark() {
  dirty = true;
  if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; flushNow(); }, 150);
}

process.on?.("beforeExit", () => { flushNow(); flushCache(); });

export const store = {
  flush: () => { flushNow(); flushCache(); },
  // runs
  getRun: (id: string) => load().runs[id],
  listRuns: () => Object.values(load().runs).sort((a, b) => b.createdAt - a.createdAt),
  putRun(r: RunRecord) { load().runs[r.id] = r; mark(); },
  patchRun(id: string, patch: Partial<RunRecord>) { const r = load().runs[id]; if (r) { Object.assign(r, patch, { updatedAt: Date.now() }); mark(); } return r; },
  // events
  events: (runId: string) => load().events[runId] ?? [],
  pushEvent(e: Omit<TraceEvent, "seq" | "ts">): TraceEvent {
    const d = load();
    const list = (d.events[e.runId] ??= []);
    const ev: TraceEvent = { ...e, seq: list.length + 1, ts: Date.now() };
    list.push(ev);
    mark();
    return ev;
  },
  // cache: its own file (LLM_CACHE_PATH, default ./data/llm-cache.db) so the eval, the CLI and the app share one cache
  cacheGet: (key: string) => loadCache()[key],
  cachePut(key: string, v: { response: any; costUsd: number; model: string }) { loadCache()[key] = { ...v, ts: Date.now() }; cacheDirty = true; if (!cacheTimer) cacheTimer = setTimeout(() => { cacheTimer = null; flushCache(); }, 150); },
  cacheSize: () => Object.keys(loadCache()).length,
  // spend
  addSpend(s: SpendRecord) { load().spend.push(s); mark(); },
  spend: (runId?: string) => load().spend.filter((s) => !runId || s.runId === runId),
  // decisions
  addDecision(d: DecisionRecord) { load().decisions.push(d); mark(); },
  decisions: (runId?: string) => load().decisions.filter((d) => !runId || d.runId === runId),
  // memory
  addMemory(m: MemoryRecord) { load().memory.push(m); mark(); },
  memoryFor: (roleKey: string) => load().memory.filter((m) => m.roleKey === roleKey),
  // outbox
  addOutbox(o: OutboxRecord) { load().outbox.push(o); mark(); },
  outbox: (runId?: string) => load().outbox.filter((o) => !runId || o.runId === runId),
  // approvals
  approve(runId: string, candidateIds: string[], removed: string[]) { load().approvals[runId] = { candidateIds, removed, approvedAt: Date.now() }; mark(); },
  approval: (runId: string) => load().approvals[runId],
  // test helpers
  resetForTests() { db = structuredClone(EMPTY); dirty = true; },
};
