import { NextResponse } from "next/server";
import { getCandidateLocal } from "../../../../src/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let c;
  try {
    c = getCandidateLocal(id);
  } catch {
    c = undefined;
  }
  if (!c) return NextResponse.json({ error: "unknown candidate" }, { status: 404 });
  return NextResponse.json(c);
}
