// Trace bus: every agent step is persisted and fanned out to SSE subscribers.
import { EventEmitter } from "node:events";
import { store, type TraceEvent } from "./store";

const bus = new EventEmitter();
bus.setMaxListeners(100);

export function emit(runId: string, kind: string, payload: any, node?: string): TraceEvent {
  const ev = store.pushEvent({ runId, kind, node, payload });
  bus.emit(runId, ev);
  bus.emit("*", ev);
  return ev;
}

export function subscribe(runId: string, fn: (ev: TraceEvent) => void): () => void {
  bus.on(runId, fn);
  return () => bus.off(runId, fn);
}

export function history(runId: string): TraceEvent[] {
  return store.events(runId);
}
