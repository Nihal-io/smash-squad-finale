// Embeds visible and redacted text for every candidate.
// Writes data/vectors.bin: Float32 little-endian, [visible(384) | redacted(384)] per candidate, in data/candidates.json order.
import { readFileSync, writeFileSync } from "node:fs";
import { embedTexts, EMBED_DIM } from "../src/lib/embed";

const candidates = JSON.parse(readFileSync("data/candidates.json", "utf8")) as Array<{ id: string; visible_text: string; redacted_text: string }>;
const t0 = Date.now();
const out = new Float32Array(candidates.length * 2 * EMBED_DIM);
const vis = await embedTexts(candidates.map((c) => c.visible_text), 32);
console.log(`visible done ${((Date.now() - t0) / 1000).toFixed(1)}s`);
const red = await embedTexts(candidates.map((c) => c.redacted_text), 32);
candidates.forEach((_, i) => {
  out.set(vis[i], i * 2 * EMBED_DIM);
  out.set(red[i], i * 2 * EMBED_DIM + EMBED_DIM);
});
writeFileSync("data/vectors.bin", Buffer.from(out.buffer));
console.log(`embedded ${candidates.length} x 2 texts in ${((Date.now() - t0) / 1000).toFixed(1)}s → data/vectors.bin (${(out.byteLength / 1e6).toFixed(1)} MB)`);
