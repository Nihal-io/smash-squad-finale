// One-off: apply src/lib/plant.ts to the committed data without reseeding the whole pool.
// Patches data/planted.json, data/candidates.json and data/eval-labels.json, re-embeds the changed candidate into
// data/vectors.bin, and updates its pgvector row when DATABASE_URL is reachable. Safe to run twice.
//   bun run scripts/plant-demo-cases.ts
import { readFileSync, writeFileSync } from "node:fs";
import { Client } from "pg";
import { embedTexts, EMBED_DIM, QUERY_PREFIX } from "../src/lib/embed";
import { dot } from "../src/lib/db";
import { plantInjection, DEMO_INJECTION } from "../src/lib/plant";

const id = DEMO_INJECTION.candidateId;
const candidates = JSON.parse(readFileSync("data/candidates.json", "utf8")) as any[];
const idx = candidates.findIndex((c) => c.id === id);
if (idx < 0) throw new Error(`${id} not in data/candidates.json`);
const buf = readFileSync("data/vectors.bin");
const vectors = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const visibleAt = (i: number) => vectors.subarray(i * 2 * EMBED_DIM, i * 2 * EMBED_DIM + EMBED_DIM);

// Rank of the candidate for preset 1's queries, so we can see the line does not push them out of reach.
const { presets } = JSON.parse(readFileSync("data/jds.json", "utf8"));
const queries: string[] = [presets[0].text, ...presets[0].mustHave, "pgvector HNSW FAISS vector search on PostgreSQL with FastAPI Python services"];
const qv = await embedTexts(queries.map((q) => QUERY_PREFIX + q));
const ranks = () => qv.map((q) => {
  const mine = dot(q, visibleAt(idx));
  return 1 + candidates.reduce((n, _c, i) => n + (i !== idx && dot(q, visibleAt(i)) > mine ? 1 : 0), 0);
});
const before = ranks();

const changed = plantInjection(candidates[idx]);
if (changed) {
  const c = candidates[idx];
  const [vis, red] = await embedTexts([c.visible_text, c.redacted_text]);
  vectors.set(vis, idx * 2 * EMBED_DIM);
  vectors.set(red, idx * 2 * EMBED_DIM + EMBED_DIM);
  writeFileSync("data/vectors.bin", Buffer.from(vectors.buffer));
  writeFileSync("data/candidates.json", JSON.stringify(candidates));
  const planted = JSON.parse(readFileSync("data/planted.json", "utf8")) as any[];
  const p = planted.find((x) => x.id === id);
  if (p) { plantInjection(p); writeFileSync("data/planted.json", JSON.stringify(planted, null, 1)); }
  const labels = JSON.parse(readFileSync("data/eval-labels.json", "utf8"));
  labels.demoInjectionCandidateId = id;
  writeFileSync("data/eval-labels.json", JSON.stringify({ injectionCandidateId: labels.injectionCandidateId, demoInjectionCandidateId: id, labels: labels.labels }, null, 1));
  console.log(`${id}: planted "${DEMO_INJECTION.line}" and re-embedded`);
} else console.log(`${id}: already planted`);
console.log(`rank for preset 1 queries (JD, must-haves, agent query): before ${before.join(",")} after ${ranks().join(",")}`);

if (process.env.DATABASE_URL) {
  const c = candidates[idx];
  const vec = (which: 0 | 1) => `[${Array.from(vectors.subarray(idx * 2 * EMBED_DIM + which * EMBED_DIM, idx * 2 * EMBED_DIM + (which + 1) * EMBED_DIM)).map((x) => x.toFixed(6)).join(",")}]`;
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
    const r = await client.query("update candidates set bio=$2, visible_text=$3, redacted_text=$4, flags=$5, emb_visible=$6::vector, emb_redacted=$7::vector where id=$1", [id, c.bio, c.visible_text, c.redacted_text, c.flags, vec(0), vec(1)]);
    console.log(`pgvector: updated ${r.rowCount} row`);
  } catch (e: any) {
    console.log(`pgvector: not updated (${e?.message}); the in-memory vectors are current`);
  } finally {
    await client.end().catch(() => {});
  }
}
process.exit(0);
