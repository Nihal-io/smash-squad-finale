import { NextResponse } from "next/server";
import type { ChaosFlags } from "../../../src/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KEYS = ["LLM_OUTAGE", "DB_DOWN", "BUDGET_ZERO"] as const;

function flags(): ChaosFlags {
  return {
    LLM_OUTAGE: process.env.CHAOS_LLM_OUTAGE === "1",
    DB_DOWN: process.env.CHAOS_DB_DOWN === "1",
    BUDGET_ZERO: process.env.CHAOS_BUDGET_ZERO === "1",
  };
}

export async function GET() {
  return NextResponse.json(flags());
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  for (const k of KEYS) {
    if (typeof body?.[k] !== "boolean") continue;
    if (body[k]) process.env[`CHAOS_${k}`] = "1";
    else delete process.env[`CHAOS_${k}`];
  }
  return NextResponse.json(flags());
}
