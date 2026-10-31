// Creates tables and loads candidates + vectors into pgvector.
import { readFileSync } from "node:fs";
import { Client } from "pg";

function url() {
  const u = process.env.DATABASE_URL;
  if (!u) throw new Error("DATABASE_URL not set");
  return u;
}

const client = new Client({ connectionString: url(), ssl: { rejectUnauthorized: false } });
await client.connect();
await client.query(readFileSync("scripts/migrate.sql", "utf8"));

const candidates = JSON.parse(readFileSync("data/candidates.json", "utf8")) as any[];
const vectors = JSON.parse(readFileSync("data/vectors.json", "utf8")) as Record<string, { visible: number[]; redacted: number[] }>;

const vec = (v: number[]) => `[${v.join(",")}]`;
await client.query("begin");
await client.query("truncate candidates");
for (const c of candidates) {
  const v = vectors[c.id];
  await client.query(
    `insert into candidates (id,name,gender,college,tier,yoe,skills,projects,bio,visible_text,redacted_text,archetype,planted,planted_for,flags,emb_visible,emb_redacted)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::vector,$17::vector)`,
    [c.id, c.name, c.gender, c.college, c.tier, c.yoe, c.skills, c.projects, c.bio, c.visible_text, c.redacted_text, c.archetype, c.planted, c.planted_for, c.flags, vec(v.visible), vec(v.redacted)],
  );
}
await client.query("commit");
const n = await client.query("select count(*) from candidates");
console.log(`loaded ${n.rows[0].count} candidates into pgvector`);
await client.end();
