// Creates tables and loads candidates + vectors into pgvector in batches.
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { EMBED_DIM } from "../src/lib/embed";

function url() {
  const u = process.env.DATABASE_URL;
  if (!u) throw new Error("DATABASE_URL not set");
  return u;
}

const client = new Client({ connectionString: url(), ssl: { rejectUnauthorized: false } });
await client.connect();
await client.query("drop table if exists candidates");
await client.query(readFileSync("scripts/migrate.sql", "utf8"));

const candidates = JSON.parse(readFileSync("data/candidates.json", "utf8")) as any[];
const buf = readFileSync("data/vectors.bin");
const vectors = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
const vec = (i: number, which: 0 | 1) => {
  const off = i * 2 * EMBED_DIM + which * EMBED_DIM;
  return `[${Array.from(vectors.subarray(off, off + EMBED_DIM)).map((x) => x.toFixed(6)).join(",")}]`;
};

const COLS = ["id", "source", "name", "gender", "college", "tier", "yoe", "role", "skills", "projects", "bio", "visible_text", "redacted_text", "archetype", "planted", "planted_for", "flags", "emb_visible", "emb_redacted"];
const BATCH = 25;
const t0 = Date.now();
for (let b = 0; b < candidates.length; b += BATCH) {
  const chunk = candidates.slice(b, b + BATCH);
  const params: any[] = [];
  const rows = chunk.map((c, j) => {
    const i = b + j;
    const vals = [c.id, c.source, c.name, c.gender, c.college, c.tier, c.yoe, c.role, c.skills, c.projects, c.bio, c.visible_text, c.redacted_text, c.archetype, c.planted, c.planted_for, c.flags, vec(i, 0), vec(i, 1)];
    const ph = vals.map((v, k) => { params.push(v); return k >= 17 ? `$${params.length}::vector` : `$${params.length}`; });
    return `(${ph.join(",")})`;
  });
  await client.query(`insert into candidates (${COLS.join(",")}) values ${rows.join(",")}`, params);
}
const n = await client.query("select count(*) from candidates");
console.log(`loaded ${n.rows[0].count} candidates into pgvector in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
await client.end();
