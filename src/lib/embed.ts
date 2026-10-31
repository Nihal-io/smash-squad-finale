// Local embeddings. bge-small-en-v1.5, 384 dimensions, runs on CPU in Node. Costs nothing.
// Never import this from an edge runtime.
import type { FeatureExtractionPipeline } from "@huggingface/transformers";

export const EMBED_MODEL = "Xenova/bge-small-en-v1.5";
export const EMBED_DIM = 384;

let pipe: Promise<FeatureExtractionPipeline> | null = null;

async function getPipe(): Promise<FeatureExtractionPipeline> {
  if (!pipe) {
    pipe = (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");
      env.cacheDir = process.env.MODEL_CACHE || process.env.HF_CACHE_DIR || "./.cache/models";
      const p: any = await (pipeline as any)("feature-extraction", EMBED_MODEL, { dtype: "fp32" });
      return p as FeatureExtractionPipeline;
    })();
  }
  return pipe;
}

// bge models recommend a short instruction prefix for queries, not for passages.
export const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

export async function embedTexts(texts: string[], batch = 16): Promise<number[][]> {
  const p = await getPipe();
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += batch) {
    const chunk = texts.slice(i, i + batch);
    const t = await p(chunk, { pooling: "cls", normalize: true });
    const data = t.data as Float32Array;
    for (let r = 0; r < chunk.length; r++) out.push(Array.from(data.slice(r * EMBED_DIM, (r + 1) * EMBED_DIM)));
    t.dispose();
  }
  return out;
}

export async function embedQuery(q: string): Promise<number[]> {
  return (await embedTexts([QUERY_PREFIX + q]))[0];
}

export function cosine(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s; // vectors are normalised
}
