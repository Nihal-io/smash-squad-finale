// JEV: decision-only classifier tier. Not a text generator.
// Enabled only when JEV_URL is set. Request/response shape is configurable until the real contract is confirmed:
//   POST {JEV_URL}  headers: Authorization: Bearer {JEV_API_KEY}
//   body: { task, input }  →  { label: "yes"|"no"|"unsure", confidence?: number }
// If the endpoint returns no confidence, JEV_DEFAULT_CONFIDENCE (default 0.85) is assumed.
import type { Label, Task } from "./decide";

export function jevEnabled(): boolean {
  return !!process.env.JEV_URL && process.env.CASCADE !== "off";
}

export async function jevDecide(task: Task, input: any): Promise<{ label: Label; confidence: number; costUsd: number }> {
  const url = process.env.JEV_URL!;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), Number(process.env.JEV_TIMEOUT_MS || 4000));
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(process.env.JEV_API_KEY ? { authorization: `Bearer ${process.env.JEV_API_KEY}` } : {}) },
      body: JSON.stringify({ task, input }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`JEV ${res.status}`);
    const j: any = await res.json();
    const label = normalise(j.label ?? j.decision ?? j.prediction);
    const confidence = typeof j.confidence === "number" ? j.confidence : typeof j.score === "number" ? j.score : Number(process.env.JEV_DEFAULT_CONFIDENCE || 0.85);
    return { label, confidence, costUsd: Number(process.env.JEV_PRICE_PER_CALL || 0) };
  } finally {
    clearTimeout(t);
  }
}

function normalise(v: any): Label {
  const s = String(v ?? "").toLowerCase();
  if (["yes", "true", "1", "positive", "supports", "match"].includes(s)) return "yes";
  if (["no", "false", "0", "negative", "reject"].includes(s)) return "no";
  return "unsure";
}
