import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";
import type { Preset } from "../../../src/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const raw = JSON.parse(readFileSync(join(process.cwd(), "data", "jds.json"), "utf8"));
  const presets: Preset[] = (raw.presets ?? []).map((p: any) => ({
    id: p.id,
    title: p.title,
    text: p.text,
    archetype: p.archetype,
  }));
  return NextResponse.json({ presets });
}
