import { describe, expect, test } from 'bun:test';
import {
  extractClaims, generateQuestions, gradeAnswers, loadAssessment, planAssessment,
  planGeneratedQuestions, runAssessment, verifyClaims, toCandidateQuestions, type Claim, type LLM, type Question,
} from '../../src/assess';
import { cases, fixtureLLM, jdSkills, read } from './fixtures';
import { evaluate } from './eval';

const pack = () => loadAssessment(read('acme-backend.json'));
const claims = cases[0].claims;
const never: LLM = async () => { throw new Error('Unexpected LLM call'); };
const q = (overrides = {}): Question => ({ id:'q', type:'short', prompt:'Explain generators', skills:['Python'],
  weight:1, required:false, rubric:'Use yield and lazy iteration', estimatedMinutes:5, claimIds:['python'], source:'generated', ...overrides });
const claim: Claim = {id:'python',skill:'Python',assertion:'I use Python',evidence:'I use Python',verified:false};

describe('JSON packs and planning', () => {
  test('candidate invitation payload omits grading secrets and claim metadata', () => {
    const plan = planAssessment(claims,pack(),jdSkills);
    const candidateQuestions = toCandidateQuestions(plan.questions);
    expect(candidateQuestions.length).toBe(plan.questions.length);
    for(const question of candidateQuestions) {
      expect(question).not.toHaveProperty('answerKey');
      expect(question).not.toHaveProperty('rubric');
      expect(question).not.toHaveProperty('tests');
      expect(question).not.toHaveProperty('claimIds');
      expect(question).not.toHaveProperty('skills');
    }
  });
  test('loads both JSON packs and all question types', () => {
    expect(pack().questions.length).toBe(8);
    expect(loadAssessment(read('nimbus-data.json')).questions.length).toBe(6);
    expect(new Set(pack().questions.map(q => q.type)).size).toBe(3);
  });
  test('rejects Markdown and malformed or duplicate questions', () => {
    expect(() => loadAssessment('## Q1')).toThrow();
    expect(() => loadAssessment('{}')).toThrow();
    const p = pack(); p.questions[1].id = p.questions[0].id;
    expect(() => loadAssessment(JSON.stringify(p))).toThrow('Duplicate');
    expect(() => loadAssessment(JSON.stringify({ ...pack(), questions:[{ ...pack().questions[0], answerKey:'missing option' }] }))).toThrow();
  });
  test('required questions survive and both budgets are enforced', () => {
    const p = { ...pack(), maxQuestions:2, timeLimitMin:10 };
    const plan = planAssessment(cases.flatMap(c => c.claims).slice(0,10).filter((c,i,a) => a.findIndex(x=>x.id===c.id)===i), p, jdSkills);
    expect(plan.questions.some(q => q.id === 'sql')).toBe(true);
    expect(plan.questions.length).toBeLessThanOrEqual(2);
    expect(plan.questions.reduce((n,q)=>n+q.estimatedMinutes,0)).toBeLessThanOrEqual(10);
    expect(() => planAssessment(claims,{...p,timeLimitMin:1},jdSkills)).toThrow('Required');
  });
  test('different claims produce different company plans; JD claims win', () => {
    expect(planAssessment(claims,pack(),jdSkills).questions.map(q=>q.id)).not.toEqual(planAssessment(cases[1].claims,pack(),jdSkills).questions.map(q=>q.id));
    const p = { ...pack(), maxQuestions:2 };
    const plan = planAssessment([...cases[1].claims, ...claims],p,['Python']);
    expect(plan.questions.map(q=>q.id)).toEqual(['sql','python']);
    expect(plan.uncovered).toContain('docker');
  });
  test('company content and threshold are preserved; no generated fallback', async () => {
    const p = pack();
    const result = await runAssessment(read('resumes/honest-2.txt'),jdSkills,{},async (prompt,schema) => {
      if (!prompt.startsWith('Extract')) throw Error('Must not generate company fallback');
      return fixtureLLM(prompt,schema);
    },p);
    for (const question of result.questions) {
      const original = p.questions.find(q=>q.id===question.id)!;
      expect(question).toEqual({...original,source:'company'});
    }
    expect(planAssessment(claims,p,jdSkills).passMark).toBe(0.8);
  });
});

describe('extraction and generated default', () => {
  test('drops non-verbatim evidence and cannot trust resume verification flags', async () => {
    const result = await extractClaims('I use Python',async()=>[
      {...claim,verified:true}, {...claim,id:'fake',evidence:'I use SQL'},
    ]);
    expect(result).toEqual([claim]);
  });
  test('validates extraction and skips blank resumes', async () => {
    await expect(extractClaims('text',async()=>[{...claim,years:-1}])).rejects.toThrow();
    expect(await extractClaims(' ',never)).toEqual([]);
  });
  test('different candidate claims produce different generated questions', async () => {
    const first = await generateQuestions(claims,jdSkills,fixtureLLM);
    const second = await generateQuestions(cases[1].claims,jdSkills,fixtureLLM);
    expect(first.map(q=>q.id)).not.toEqual(second.map(q=>q.id));
    expect(first.every(q=>q.source==='generated')).toBe(true);
  });
  test('same skill with a different assertion is included in generation context', async () => {
    const a = await generateQuestions([claim],['Python'],fixtureLLM);
    const b = await generateQuestions([{...claim,assertion:'I optimized Python generators for streaming data'}],['Python'],fixtureLLM);
    expect(a[0].prompt).not.toBe(b[0].prompt);
  });
  test('targets only unverified JD skills; sends no raw resume evidence', async () => {
    const seen:string[]=[];
    const llm:LLM = async (prompt,schema) => {seen.push(prompt);return fixtureLLM(prompt,schema);};
    await generateQuestions([{...claim,evidence:'Private college'},...cases[1].claims],['Python'],llm);
    expect(seen[0]).not.toContain('Private college');
    expect(seen[0]).not.toContain('Docker');
    expect(await generateQuestions([{...claim,verified:true}],['Python'],never)).toEqual([]);
  });
  test('rejects invalid coverage, over-budget responses and malformed LLM output', async () => {
    await expect(generateQuestions([claim],['Python'],async()=>[q({claimIds:['made-up']})])).rejects.toThrow('coverage');
    await expect(generateQuestions([claim],['Python'],async()=>[q()],{timeLimitMin:1})).rejects.toThrow('limits');
    await expect(generateQuestions([claim],['Python'],async()=>[q(),q({id:'q2'})],{maxQuestions:1})).rejects.toThrow('limits');
    await expect(generateQuestions([claim],['Python'],async()=>({questions:[]}))).rejects.toThrow();
  });
});

describe('grading and evidence', () => {
  test('MCQ and keyed short answers are deterministic and normalized', async () => {
    const plan=planAssessment(claims,pack(),jdSkills);
    const result=await gradeAnswers({...plan,questions:plan.questions.filter(q=>q.id==='sql')},{sql:'  having  '},never);
    expect(result[0].score).toBe(1);
    const short=planGeneratedQuestions([claim],[q({answerKey:'Yield'})]);
    expect((await gradeAnswers(short,{q:'yield'},never))[0].score).toBe(1);
    expect((await gradeAnswers(short,{q:'other'},never))[0].score).toBe(0);
  });
  test('rubric prompt contains question, rubric and answer only', async () => {
    const plan=planGeneratedQuestions([{...claim,assertion:'Jane, female, Famous College'}],[q()]);
    let payload:object={};
    const grades=await gradeAnswers(plan,{q:'yield lazily'},async prompt=>{
      expect(prompt).not.toContain('Jane'); expect(prompt).not.toContain('female'); expect(prompt).not.toContain('Famous College');
      payload=JSON.parse(prompt.slice(prompt.indexOf('\n')+1));
      return {score:1,confidence:0.9,reason:'Meets rubric'};
    });
    expect(Object.keys(payload).sort()).toEqual(['answer','question','rubric']);
    expect(verifyClaims([claim],plan,grades)[0].status).toBe('verified');
  });
  test.each([NaN,-1,2])('invalid score %s cannot become a contradiction', async score=>{
    const plan=planGeneratedQuestions([claim],[q()]);
    const grades=await gradeAnswers(plan,{q:'text'},async()=>({score,confidence:1,reason:'bad'}));
    expect(grades[0].status).toBe('unusable');
    expect(verifyClaims([claim],plan,grades)[0].status).toBe('not_tested');
  });
  test('missing answer, grading failure, low confidence and pending code are not tested', async()=>{
    const plan=planGeneratedQuestions([claim],[q()]);
    for (const grades of [
      await gradeAnswers(plan,{},never),
      await gradeAnswers(plan,{q:'text'},never),
      await gradeAnswers(plan,{q:'text'},async()=>({score:0,confidence:0.2,reason:'Uncertain'})),
    ]) expect(verifyClaims([claim],plan,grades)[0].status).toBe('not_tested');
    const code=planGeneratedQuestions([claim],[q({type:'code'})]);
    const grades=await gradeAnswers(code,{q:'return 1'},never);
    expect(grades[0].reason).toBe('needs sandbox');
    expect(verifyClaims([claim],code,grades)[0].status).toBe('not_tested');
  });
  test('missing one of several relevant answers leaves the whole claim not tested', async()=>{
    const plan=planGeneratedQuestions([claim],[q({answerKey:'yes'}),q({id:'q2',answerKey:'yes'})]);
    const grades=await gradeAnswers(plan,{q:'yes'},never);
    expect(verifyClaims([claim],plan,grades)[0].status).toBe('not_tested');
  });
  test('weighted scores use the company threshold, including exact boundary', ()=>{
    const plan=planGeneratedQuestions([claim],[q({weight:3}),q({id:'q2'})],{passMark:0.75});
    const grades=[{questionId:'q',status:'graded' as const,score:1,confidence:1,reason:'key'},
      {questionId:'q2',status:'graded' as const,score:0,confidence:1,reason:'key'}];
    expect(verifyClaims([claim],plan,grades)[0]).toMatchObject({score:0.75,status:'verified'});
    expect(verifyClaims([claim],{...plan,passMark:0.8},grades)[0].status).toBe('contradicted');
  });
  test('uncovered claims never become contradictions',()=>{
    const plan=planGeneratedQuestions([claim],[]);
    expect(verifyClaims([claim],plan,[])[0].status).toBe('not_tested');
  });
  test('duplicate grades are rejected',()=>{
    const plan=planGeneratedQuestions([claim],[q()]);
    const grade={questionId:'q',status:'graded' as const,score:0,confidence:1,reason:'key'};
    expect(()=>verifyClaims([claim],plan,[grade,grade])).toThrow('Duplicate');
  });
});

test('10-resume evaluation passes for generated questions and both company packs',async()=>{
  const reports=await evaluate();
  expect(reports.length).toBe(3);
  for(const r of reports) {
    expect(r.candidates).toBe(10); expect(r.accuracy).toBe(1);
    expect(r.contradictedRecall).toBe(1); expect(r.falseContradictions).toBe(0);
  }
});
