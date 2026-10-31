import { ensureDataOnce } from "@/src/lib/bootstrap";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { startRun } from "../../../src/agent/supervisor";
import { runInBackground } from "../../_lib/background";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function presetArchetype(presetId?: string): string | undefined {
  if (!presetId) return undefined;
  try {
    const raw = JSON.parse(readFileSync(join(process.cwd(), "data", "jds.json"), "utf8"));
    return (raw.presets ?? []).find((p: any) => p.id === presetId)?.archetype;
  } catch {
    return undefined;
  }
}

export async function POST(req: Request) {
  await ensureDataOnce();
  const body = await req.json().catch(() => null);
  const jdText = typeof body?.jdText === "string" ? body.jdText.trim() : "";
  if (!jdText) return NextResponse.json({ error: "jdText required" }, { status: 400 });
  const presetId = typeof body?.presetId === "string" ? body.presetId : undefined;
  const roleKey: string = (typeof body?.roleKey === "string" && body.roleKey) || presetArchetype(presetId) || "custom";
  const runId = `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const chaos = {
    LLM_OUTAGE: process.env.CHAOS_LLM_OUTAGE === "1",
    DB_DOWN: process.env.CHAOS_DB_DOWN === "1",
    BUDGET_ZERO: process.env.CHAOS_BUDGET_ZERO === "1",
  };
  runInBackground(runId, () => startRun({ runId, jdText, roleKey, presetId, chaos }));
  return NextResponse.json({ runId }, { status: 202 });
}
