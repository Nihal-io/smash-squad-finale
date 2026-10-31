import { NextResponse } from "next/server";
import { config } from "../../src/lib/llm";
import { dbHealthy, loadMemory } from "../../src/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  let candidates = 0;
  try {
    candidates = loadMemory().candidates.length;
  } catch {
    candidates = 0;
  }
  const db = (await dbHealthy()) ? "pgvector" : "memory";
  return NextResponse.json({ ok: true, db, llm: config().provider, candidates });
}
