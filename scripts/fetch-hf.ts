// Lists the dataset repo via the Hugging Face API, then downloads the resumes, jobs and matches parquet files.
// Dataset: michaelozon/candidate-matching-synthetic (MIT). See CREDITS.md.
import { mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";

const REPO = "michaelozon/candidate-matching-synthetic";
const API = `https://huggingface.co/api/datasets/${REPO}/tree/main`;
const RAW = `https://huggingface.co/datasets/${REPO}/resolve/main`;
const WANT = ["resumes", "jobs", "matches"];

mkdirSync("data/hf", { recursive: true });
for (const dir of WANT) {
  const list = (await (await fetch(`${API}/${dir}`)).json()) as Array<{ path: string; size: number; type: string }>;
  const files = list.filter((f) => f.type === "file" && f.path.endsWith(".parquet"));
  console.log(`${dir}: ${files.map((f) => `${f.path} (${(f.size / 1024).toFixed(0)} KB)`).join(", ")}`);
  for (const f of files) {
    const out = `data/hf/${dir}.parquet`;
    if (existsSync(out) && statSync(out).size === f.size) {
      console.log(`  cached ${out}`);
      continue;
    }
    const res = await fetch(`${RAW}/${f.path}`);
    if (!res.ok) throw new Error(`download failed ${f.path}: ${res.status}`);
    writeFileSync(out, Buffer.from(await res.arrayBuffer()));
    console.log(`  saved ${out}`);
  }
}
