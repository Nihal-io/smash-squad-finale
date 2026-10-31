// Embeds visible and redacted text for every candidate. Writes data/vectors.json for the in-memory fallback.
import { readFileSync, writeFileSync } from "node:fs";
import { embedTexts } from "../src/lib/embed";

const candidates = JSON.parse(readFileSync("data/candidates.json", "utf8")) as Array<{ id: string; visible_text: string; redacted_text: string }>;
const t0 = Date.now();
const vis = await embedTexts(candidates.map((c) => c.visible_text));
const red = await embedTexts(candidates.map((c) => c.redacted_text));
const vectors: Record<string, { visible: number[]; redacted: number[] }> = {};
candidates.forEach((c, i) => (vectors[c.id] = { visible: vis[i], redacted: red[i] }));
writeFileSync("data/vectors.json", JSON.stringify(vectors));
console.log(`embedded ${candidates.length} x 2 texts in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
