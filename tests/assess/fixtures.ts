import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type Claim, type LLM, type Question } from '../../src/assess';

export const dataDir = fileURLToPath(new URL('../../data/assessments/', import.meta.url));
export const read = (name: string) => readFileSync(dataDir + name, 'utf8');
export const cases: { id: string; flavour: string; claims: Claim[] }[] = JSON.parse(read('cases.json'));
export const answers: Record<string, Record<string, Record<string, string>>> = JSON.parse(read('answers.json'));
export const labels: Record<string, Record<string, Record<string, string>>> = JSON.parse(read('labels.json'));
const bank: Question[] = JSON.parse(read('question-bank.json'));
export const jdSkills = bank.flatMap(q => q.skills);

/** Offline contract double, deliberately independent of expected verdict labels. */
export const fixtureLLM: LLM = async prompt => {
  const payload = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1));
  if ('resumeText' in payload) return cases.flatMap(c => c.claims).filter((c, i, all) =>
    payload.resumeText.includes(c.evidence) && all.findIndex(x => x.id === c.id) === i);
  if ('claims' in payload) return payload.claims.flatMap((c: Claim) => {
    const q = bank.find(q => q.skills.includes(c.skill));
    return q ? [{ ...q, id: `generated-${q.id}`, prompt: `${q.prompt} Context: ${c.assertion}`,
      claimIds: [c.id], estimatedMinutes: 5 }] : [];
  }).slice(0, payload.maxQuestions);
  const correct = /yield/i.test(payload.answer) && /laz/i.test(payload.answer);
  return { score: correct ? 1 : 0, confidence: 0.95, reason: correct ? 'Explains lazy iteration and yield' : 'Does not explain generator semantics' };
};
