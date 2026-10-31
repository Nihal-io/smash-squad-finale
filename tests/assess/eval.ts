import { loadAssessment, runAssessment } from '../../src/assess';
import { answers, cases, fixtureLLM, jdSkills, labels, read } from './fixtures';

export async function evaluate() {
  const reports = [];
  for (const source of ['generated', 'acme', 'nimbus']) {
    const pack = source === 'generated' ? undefined : loadAssessment(read(source === 'acme' ? 'acme-backend.json' : 'nimbus-data.json'));
    let correct = 0, total = 0, contradicted = 0, recovered = 0, falseContradictions = 0;
    for (const candidate of cases) {
      const result = await runAssessment(read(`resumes/${candidate.id}.txt`), jdSkills, answers[candidate.id][source], fixtureLLM, pack);
      for (const [claimId, expected] of Object.entries(labels[candidate.id][source])) {
        const actual = result.claimResults.find(c => c.claimId === claimId)?.status;
        total++; if (actual === expected) correct++;
        if (expected === 'contradicted') { contradicted++; if (actual === expected) recovered++; }
        if (candidate.flavour === 'honest' && actual === 'contradicted') falseContradictions++;
      }
    }
    reports.push({ source, candidates: cases.length, correct, total, accuracy: correct / total,
      contradicted, recovered, contradictedRecall: contradicted ? recovered / contradicted : null, falseContradictions });
  }
  return reports;
}

if (import.meta.main) {
  console.log('Offline stub-LLM evaluation; this measures module behavior, not live-model quality.');
  for (const r of await evaluate()) console.log(JSON.stringify(r));
}
