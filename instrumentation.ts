export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Node 25 ships a localStorage global without getItem unless web storage is configured; some dependencies
  // feature-detect on `typeof localStorage` and then call getItem. Hide the half-object.
  const ls = (globalThis as any).localStorage;
  if (ls && typeof ls.getItem !== "function") {
    try { Object.defineProperty(globalThis, "localStorage", { value: undefined, configurable: true, writable: true }); } catch {}
  }
  // Data bootstrap runs lazily from the Node API routes (see src/lib/bootstrap.ts) so this file stays free of Node-only imports.
}
