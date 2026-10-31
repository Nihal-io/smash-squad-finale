import { NextResponse } from "next/server";
import { toShortlist } from "../../../../src/contracts";
import { store } from "../../../../src/lib/store";
import { spendSummary } from "../../../../src/lib/llm";
import { cascadeSummary } from "../../../../src/lib/decide";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = store.getRun(id);
  if (!run) return NextResponse.json({ error: "unknown run" }, { status: 404 });
  const state = run.state ?? null;
  let shortlist: ReturnType<typeof toShortlist> = [];
  if (state) {
    try {
      shortlist = toShortlist(state);
    } catch {
      shortlist = [];
    }
  }
  return NextResponse.json({
    run,
    state,
    shortlist,
    spend: spendSummary(id),
    cascade: cascadeSummary(id),
    outbox: store.outbox(id),
  });
}
