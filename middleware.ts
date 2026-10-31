import { NextResponse, type NextRequest } from "next/server";

const OPEN_PATHS = new Set(["/health", "/api/passcode", "/favicon.ico"]);

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

const GATE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Passcode</title>
<style>body{font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;background:#f6f7f9}
form{background:#fff;padding:28px;border-radius:10px;box-shadow:0 2px 12px rgba(0,0,0,.08);display:flex;flex-direction:column;gap:12px;min-width:260px}
input,button{font:inherit;padding:10px;border-radius:6px;border:1px solid #c9ced6}button{background:#1f2937;color:#fff;border:0;cursor:pointer}
#err{color:#b91c1c;font-size:14px;min-height:18px}</style></head>
<body><form id="f"><strong>Enter passcode</strong>
<input id="p" type="password" autocomplete="current-password" autofocus required>
<button type="submit">Continue</button><div id="err"></div></form>
<script>
document.getElementById("f").addEventListener("submit", async function (e) {
  e.preventDefault();
  var r = await fetch("/api/passcode", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passcode: document.getElementById("p").value }) });
  if (r.ok) location.reload(); else document.getElementById("err").textContent = "Wrong passcode";
});
</script></body></html>`;

export async function middleware(req: NextRequest) {
  const passcode = process.env.APP_PASSCODE;
  if (!passcode) return NextResponse.next();
  const { pathname } = req.nextUrl;
  if (OPEN_PATHS.has(pathname) || pathname.startsWith("/_next/")) return NextResponse.next();

  const cookie = req.cookies.get("rm_pass")?.value;
  if (cookie && cookie === (await sha256Hex(passcode))) return NextResponse.next();

  if (pathname === "/" || pathname === "/index.html") {
    return new NextResponse(GATE_PAGE, { status: 401, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  return NextResponse.json({ error: "passcode required" }, { status: 401 });
}

export const config = {
  matcher: ["/((?!_next/|favicon.ico).*)"],
};
