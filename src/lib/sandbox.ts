// Code execution tool: QuickJS (WebAssembly) with interrupt-based CPU limit and a memory cap. No host access.
import { newQuickJSWASMModuleFromVariant, shouldInterruptAfterDeadline } from "quickjs-emscripten";

let modP: ReturnType<typeof newQuickJSWASMModuleFromVariant> | null = null;
async function mod() {
  if (!modP) {
    const variant = await import("@jitl/quickjs-wasmfile-release-sync");
    modP = newQuickJSWASMModuleFromVariant(variant.default as any);
  }
  return modP;
}

export interface TestResult { input: string; expected: string; got: string; pass: boolean }

export async function runInSandbox(code: string, tests: { input: string; expected: string }[], timeoutMs = 1500): Promise<{ passed: number; total: number; results: TestResult[]; error?: string }> {
  const QuickJS = await mod();
  const results: TestResult[] = [];
  let error: string | undefined;
  for (const t of tests) {
    const rt = QuickJS.newRuntime();
    rt.setMemoryLimit(32 * 1024 * 1024);
    rt.setMaxStackSize(512 * 1024);
    rt.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + timeoutMs));
    const vm = rt.newContext();
    try {
      const src = `${code}\n;(function(){ try { return String(solve(${JSON.stringify(t.input)})); } catch (e) { return "__ERR__ " + String(e && e.message || e); } })()`;
      const r = vm.evalCode(src);
      let got: string;
      if (r.error) { got = "__ERR__ " + JSON.stringify(vm.dump(r.error)); r.error.dispose(); }
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
  return { passed: results.filter((r) => r.pass).length, total: results.length, results, error };
}
