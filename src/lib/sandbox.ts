// Code execution tool: QuickJS (WebAssembly) with interrupt-based CPU limit and a memory cap. No host access.
import { newQuickJSWASMModuleFromVariant, shouldInterruptAfterDeadline } from "quickjs-emscripten";

let modP: ReturnType<typeof newQuickJSWASMModuleFromVariant> | null = null;
async function mod() {
  if (!modP) {
    const mod: any = await import("@jitl/quickjs-wasmfile-release-sync");
    // Interop differs between Bun and the Next bundle: the variant may be the default export or the module itself.
    const variant = mod?.default?.type ? mod.default : mod?.type ? mod : (mod?.default ?? mod);
    modP = newQuickJSWASMModuleFromVariant(variant as any);
  }
  return modP;
}

export interface TestResult { input: string; expected: string; got: string; pass: boolean }

export const SANDBOX_TIMEOUT_MS = 1500;

// timedOut: the code hit the time limit and the runtime killed it; the remaining tests are not run.
export async function runInSandbox(code: string, tests: { input: string; expected: string }[], timeoutMs = SANDBOX_TIMEOUT_MS): Promise<{ passed: number; total: number; results: TestResult[]; error?: string; timedOut?: boolean }> {
  const QuickJS = await mod();
  const results: TestResult[] = [];
  let error: string | undefined;
  let timedOut = false;
  for (const t of tests) {
    if (timedOut) { results.push({ input: t.input, expected: t.expected, got: "__NOT_RUN__ earlier test timed out", pass: false }); continue; }
    const rt = QuickJS.newRuntime();
    rt.setMemoryLimit(32 * 1024 * 1024);
    rt.setMaxStackSize(512 * 1024);
    rt.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + timeoutMs));
    const vm = rt.newContext();
    try {
      const src = `${code}\n;(function(){ try { return String(solve(${JSON.stringify(t.input)})); } catch (e) { return "__ERR__ " + String(e && e.message || e); } })()`;
      const r = vm.evalCode(src);
      let got: string;
      if (r.error) {
        const err = vm.dump(r.error); r.error.dispose();
        // QuickJS reports a deadline interrupt as an uncatchable InternalError("interrupted").
        if (/interrupted/i.test(String(err?.message ?? err))) { timedOut = true; error = `code timed out after ${timeoutMs} ms and was stopped`; got = "__TIMEOUT__"; }
        else got = "__ERR__ " + JSON.stringify(err);
      }
      else { got = String(vm.dump(r.value)); r.value.dispose(); }
      results.push({ input: t.input, expected: t.expected, got, pass: got.trim() === t.expected.trim() });
    } catch (e: any) {
      error = String(e?.message ?? e);
      results.push({ input: t.input, expected: t.expected, got: "__ERR__ " + error, pass: false });
    } finally {
      vm.dispose();
      rt.dispose();
    }
  }
  return { passed: results.filter((r) => r.pass).length, total: results.length, results, error, ...(timedOut ? { timedOut } : {}) };
}
