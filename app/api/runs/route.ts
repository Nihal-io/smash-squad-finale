import { NextResponse } from "next/server";
import { store } from "../../../src/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const runs = store.listRuns().map(({ state: _state, ...rest }) => rest);
  return NextResponse.json({ runs });
}
