import { NextResponse } from "next/server";
import { store } from "../../../src/lib/store";
import { spendSummary } from "../../../src/lib/llm";
import { cascadeSummary } from "../../../src/lib/decide";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ spend: spendSummary(), cascade: cascadeSummary(), cacheEntries: store.cacheSize() });
}
