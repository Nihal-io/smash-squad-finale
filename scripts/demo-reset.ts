// Demo reset: clears runs, trace events, approvals, spend, decisions and the outbox, and restores agent memory
// from data/demo-memory.json. The LLM cache (data/llm-cache.db) is untouched, so presets replay from cache.
//   bun run demo:reset            reset to the snapshot
//   bun run demo:reset --snapshot save the current memory as the snapshot first
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const dbPath = process.env.DB_PATH || "./data/app.db";
const snapshotPath = "data/demo-memory.json";

const current = existsSync(dbPath) ? JSON.parse(readFileSync(dbPath, "utf8")) : {};
if (process.argv.includes("--snapshot") || !existsSync(snapshotPath)) {
  const memory = (current.memory ?? []).map((m: any) => ({ ...m, runId: undefined }));
  writeFileSync(snapshotPath, JSON.stringify(memory, null, 1));
  console.log(`saved ${memory.length} memory note(s) to ${snapshotPath}`);
}
const memory = JSON.parse(readFileSync(snapshotPath, "utf8"));
const fresh = { runs: {}, events: {}, cache: {}, spend: [], decisions: [], memory, outbox: [], approvals: {} };
mkdirSync(dirname(dbPath), { recursive: true });
const tmp = `${dbPath}.${process.pid}.tmp`;
writeFileSync(tmp, JSON.stringify(fresh));
renameSync(tmp, dbPath);
const cachePath = process.env.LLM_CACHE_PATH || "./data/llm-cache.db";
const cacheEntries = existsSync(cachePath) ? Object.keys(JSON.parse(readFileSync(cachePath, "utf8"))).length : 0;
console.log(`reset ${dbPath}: 0 runs, 0 outbox, ${memory.length} memory note(s) restored; LLM cache kept (${cacheEntries} entries)`);
