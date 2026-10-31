import { NextResponse } from "next/server";
import { store } from "../../../../../src/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = store.getRun(id);
  if (!run) return NextResponse.json({ error: "unknown run" }, { status: 404 });
  const body = await req.json().catch(() => null);
  const note = typeof body?.note === "string" ? body.note.trim() : "";
  if (!note) return NextResponse.json({ error: "note required" }, { status: 400 });
  store.addMemory({
    roleKey: run.roleKey,
    runId: id,
    note,
    rejectedCandidateId: typeof body?.rejectedCandidateId === "string" ? body.rejectedCandidateId : undefined,
    preferredSkills: Array.isArray(body?.preferredSkills) ? body.preferredSkills.filter((s: unknown): s is string => typeof s === "string") : undefined,
    ts: Date.now(),
  });
  return NextResponse.json({ ok: true });
}
