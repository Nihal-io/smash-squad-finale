import { NextResponse } from "next/server";
import { resumeRun } from "../../../../../src/agent/supervisor";
import { store } from "../../../../../src/lib/store";
import { runInBackground } from "../../../../_lib/background";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = store.getRun(id);
  if (!run) return NextResponse.json({ error: "unknown run" }, { status: 404 });
  if (run.status !== "waiting_approval") {
    return NextResponse.json({ error: "run is not waiting for approval", status: run.status }, { status: 409 });
  }
  const body = await req.json().catch(() => ({}));
  const approved = strings(body?.approved);
  const removed = strings(body?.removed);
  runInBackground(id, () => resumeRun(id, { approved, removed }));
  return NextResponse.json({ ok: true });
}
