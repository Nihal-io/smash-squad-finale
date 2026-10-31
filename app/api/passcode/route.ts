import { createHash } from "node:crypto";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const expected = process.env.APP_PASSCODE;
  // With no passcode configured the gate is off, so there is nothing to set.
  if (!expected) return NextResponse.json({ ok: true });
  const body = await req.json().catch(() => ({}));
  const given = typeof body?.passcode === "string" ? body.passcode : "";
  if (given !== expected) return NextResponse.json({ ok: false }, { status: 401 });
  const res = NextResponse.json({ ok: true });
  res.cookies.set("rm_pass", createHash("sha256").update(expected).digest("hex"), {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60,
  });
  return res;
}
