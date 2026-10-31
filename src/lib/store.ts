// File-backed app state at DB_PATH (default ./data/app.db). Runs, trace events, LLM cache, spend, HR memory,
// outbox, approvals and decisions all live here so the app keeps working when Postgres is unreachable.
// Writes are whole-file, atomic (write temp + rename). Scale is a hackathon's worth of runs.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
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

export function dbPath() {
  return process.env.DB_PATH || "./data/app.db";
}

function load(): Db {
  if (db) return db;
  const p = dbPath();
  if (existsSync(p)) {
    try {
      db = { ...EMPTY, ...JSON.parse(readFileSync(p, "utf8")) };
    } catch {
      db = structuredClone(EMPTY);
    }
  } else db = structuredClone(EMPTY);
  return db!;
}

function flushNow() {
  if (!db || !dirty) return;
  const p = dbPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p + ".tmp", JSON.stringify(db));
  renameSync(p + ".tmp", p);
  dirty = false;
}

function mark() {
  dirty = true;
  if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; flushNow(); }, 150);
}

process.on?.("beforeExit", flushNow);

export const store = {
  flush: flushNow,
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
  // cache
  cacheGet: (key: string) => load().cache[key],
  cachePut(key: string, v: { response: any; costUsd: number; model: string }) { load().cache[key] = { ...v, ts: Date.now() }; mark(); },
  cacheSize: () => Object.keys(load().cache).length,
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
