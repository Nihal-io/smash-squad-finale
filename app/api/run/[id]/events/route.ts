import { store, type TraceEvent } from "../../../../../src/lib/store";
import { history, subscribe } from "../../../../../src/lib/trace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TERMINAL = new Set(["done", "failed", "stopped"]);

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!store.getRun(id)) {
    return new Response(JSON.stringify({ error: "unknown run" }), { status: 404, headers: { "content-type": "application/json" } });
  }
  const enc = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let lastSeq = 0;
      let lastStatus: string | null = null;
      let ticks = 0;

      const onAbort = () => close();
      const write = (s: string) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          close();
        }
      };
      const sendStep = (ev: TraceEvent) => {
        if (ev.seq <= lastSeq) return;
        lastSeq = ev.seq;
        write(`event: step\ndata: ${JSON.stringify(ev)}\n\n`);
      };
      const catchUp = () => {
        for (const ev of history(id)) sendStep(ev);
      };
      function close() {
        if (closed) return;
        closed = true;
        cleanup();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }

      const unsub = subscribe(id, sendStep);
      cleanup = () => {
        clearInterval(timer);
        unsub();
        req.signal.removeEventListener("abort", onAbort);
      };
      catchUp();

      const checkStatus = () => {
        const run = store.getRun(id);
        if (!run) return;
        if (run.status !== lastStatus) {
          lastStatus = run.status;
          catchUp();
          write(`event: status\ndata: ${JSON.stringify({ status: run.status })}\n\n`);
        }
        if (TERMINAL.has(run.status) && history(id).length <= lastSeq) close();
      };

      const timer = setInterval(() => {
        if (closed) return;
        ticks++;
        checkStatus();
        if (!closed && ticks % 15 === 0) write(`: ping\n\n`);
      }, 1000);

      req.signal.addEventListener("abort", onAbort);
      checkStatus();
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
