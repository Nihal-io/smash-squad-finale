// Assessment-module track: the module's own offline evaluation (stub LLM) on ten synthetic resumes.
// Reports claim-verification accuracy and false contradictions on honest candidates for generated questions and both company packs.
export async function runAssessmentEval() {
  const { evaluate } = await import("../../tests/assess/eval");
  const reports = await evaluate();
  const gen = reports.find((r: any) => r.source === "generated") ?? reports[0];
  return {
    summary: {
      claimAccuracy: gen.accuracy,
      falseContradictions: gen.falseContradictions,
      contradictedRecall: gen.contradictedRecall,
      candidates: gen.candidates,
      claims: gen.total,
      sources: reports.map((r: any) => ({ source: r.source, accuracy: r.accuracy, falseContradictions: r.falseContradictions, contradictedRecall: r.contradictedRecall })),
    },
    note: "Offline stub-LLM evaluation of the module's contract on synthetic resumes, not live-model quality.",
    reports,
  };
}
