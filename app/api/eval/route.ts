import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const p = join(process.cwd(), "eval", "results.json");
  if (!existsSync(p)) return NextResponse.json({ error: "eval has not been run" }, { status: 404 });
  try {
    return NextResponse.json(JSON.parse(readFileSync(p, "utf8")));
  } catch {
    return NextResponse.json({ error: "eval results unreadable" }, { status: 404 });
  }
}
