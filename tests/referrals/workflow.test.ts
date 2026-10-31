import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { saveReferral, referralSnapshot } from '../../src/referrals/store';
import { loadMemory, keywordSearch, getCandidateLocal, getCandidates, memVector, vectorSearch } from '../../src/lib/db';
import { store } from '../../src/lib/store';
import { collectResponses } from '../../src/agent/assess';
import { toShortlist } from '../../src/contracts';
import { gradeAnswers, verifyClaims, planGeneratedQuestions, planAssessment } from '../../src/assess';
import { createReferralRun, checkReferrals, beginReferralApproval, prepareReferralAssessments, beginReferralSubmission, gradeReferralSubmission, referralRunView, failReferralRun, type ReferralDependencies } from '../../src/referrals/workflow';

mkdirSync('.cache',{recursive:true});
const dir=mkdtempSync(join(process.cwd(),'.cache','referral-test-')),previousPath=process.env.DB_PATH,previousDb=process.env.DATABASE_URL;
process.env.DB_PATH=join(dir,'app.db');delete process.env.DATABASE_URL;
store.resetForTests();
afterAll(()=>{store.flush();process.env.DB_PATH=previousPath;if(previousDb)process.env.DATABASE_URL=previousDb;rmSync(dir,{recursive:true,force:true});});
const vector=()=>Array.from({length:384},(_,i)=>i===0?1:0);
const embed:ReferralDependencies['embedTexts']=async texts=>texts.map(vector);
const hash=(file:string)=>createHash('sha256').update(readFileSync(file)).digest('hex');
const text='Synthetic Person built referralUniqueToken APIs using Python and PostgreSQL. They wrote tests, handled incidents, and deployed backend services.';
let invites=0,source:'generated'|'company'='generated';
const claim={id:'python',skill:'Python',assertion:'Builds Python APIs',evidence:'using Python',verified:false};
const deps:ReferralDependencies={
  embedTexts:embed,
  parseJd:async s=>{s.jd.title='Backend engineer';s.jd.requirements=[{id:'r1',text:'Python APIs',kind:'must'},{id:'r2',text:'Kubernetes production operations',kind:'must'}];return s.jd;},
  getProfile:async({candidate_id},{state})=>{state.candidates[candidate_id]={id:candidate_id,name:'Synthetic Person',semantic:0,seen:0,coverage:{},evidence:[],failedClaims:[],flags:[]};return{requirementHints:[{requirementId:'r1',bestSentence:'using Python'}]} as any;},
  citeEvidence:async({candidate_id},{state})=>{state.candidates[candidate_id].evidence=[{requirementId:'r1',quote:'using Python',start:0,end:12,strength:'strong',basis:'explicit',by:'local',confidence:1}];return{} as any;},
  prepareAssessment:async(_s,c)=>{
    expect(c.evidence).toEqual([]); // Resume quotes never verify a referral claim.
    const question={id:'q1',type:'mcq' as const,prompt:'Which keyword defines a Python function?',skills:['Python'],options:['def','function'],answerKey:'def',claimIds:['python'],estimatedMinutes:5,weight:1,required:true};
    const plan=source==='company'?planAssessment([claim],{company:'Test',title:'Backend',timeLimitMin:10,maxQuestions:1,passMark:0.9,questions:[question]},['Python']):planGeneratedQuestions([claim],[{...question,source:'generated'}],{});
    return{claims:[claim],plan,jdSkills:['Python'],source,verifiedByEvidence:[],matches:[]};
  },
  sendAssessmentEmail:async()=>{invites++;return{channel:'outbox',status:'queued'} as any;},
  gradeWithModule:async(_s,c,prep)=>{
    const grades=await gradeAnswers(prep.plan,Object.fromEntries(c.responses!.map(r=>[r.questionId!,r.answer])),async()=>{throw new Error('MCQ grading must not call an LLM');});
    const verdicts=verifyClaims(prep.claims,prep.plan,grades).map(r=>({claimId:r.claimId,skill:'Python',claim:claim.assertion,status:r.status,score:r.score,reason:r.reason,questions:['q1']}));
    const g=grades[0];return{grade:{total:g.score??0,parts:[{kind:'short',score:g.score??0,confidence:g.confidence??0}],regraded:false},verdicts};
  },
  fairnessAudit:async(_s,ids)=>({ids,weights:{semantic:.6,assessment:.4},rows:[],spearman:1,top5Overlap:1,split:{visible:{gender:{},tier:{}},hidden:{gender:{},tier:{}}},findings:[],recommendBlind:false}),
};

test('indexes without editing seeds, deduplicates, and refreshes keyword/vector searches',async()=>{
  const before=[hash('data/candidates.json'),hash('data/vectors.bin')],count=loadMemory().candidates.length;
  keywordSearch('referralUniqueToken','visible',5); // Build cache before the upload.
  const {record,duplicate}=await saveReferral({name:'Synthetic Person',text,filename:'resume.txt',years:3},embed);
  expect(duplicate).toBe(false);expect(loadMemory().candidates.length).toBe(count+1);
  expect(getCandidateLocal(record.id)?.source).toBe('referral');expect((await getCandidates([record.id]))[0].id).toBe(record.id);
  expect(memVector(record.id,'visible')?.length).toBe(384);
  expect(keywordSearch('referralUniqueToken','visible',5).map(x=>x.id)).toContain(record.id);
  expect((await vectorSearch(vector(),'visible',1,{minYoe:3})).hits[0].id).toBe(record.id);
  expect((await saveReferral({name:'Synthetic Person',text,filename:'renamed.txt',years:3},embed)).duplicate).toBe(true);
  expect(referralSnapshot().records.length).toBe(1);expect(record.redacted).not.toContain('Synthetic Person');
  expect([hash('data/candidates.json'),hash('data/vectors.bin')]).toEqual(before);
});
for(const mode of ['generated','company'] as const)test(`${mode}: waits for HR and real answers, hides keys, then verifies performance`,async()=>{
  source=mode;const id=referralSnapshot().records[0].id,run=createReferralRun('Backend engineer needs Python APIs and Kubernetes',[id],'backend'),before=invites;
  expect(()=>beginReferralApproval(run,[id])).toThrow();
  await checkReferrals(run,deps);expect(store.getRun(run)?.status).toBe('waiting_approval');expect(invites).toBe(before);
  expect(referralRunView(run).candidates[0].missing).toEqual(['Kubernetes production operations']);
  beginReferralApproval(run,[id]);expect(()=>beginReferralApproval(run,[id])).toThrow();
  await prepareReferralAssessments(run,deps);expect(store.getRun(run)?.status).toBe('waiting_responses');expect(invites).toBe(before+1);
  const state=store.getRun(run)!.state;expect(state.candidates[id].responses).toBeUndefined();expect(state.candidates[id].grade).toBeUndefined();
  const question=referralRunView(run).candidates[0].questions[0];expect(question).not.toHaveProperty('answerKey');expect(question).not.toHaveProperty('rubric');expect(question).not.toHaveProperty('tests');
  await expect(collectResponses(state,state.candidates[id],run)).rejects.toThrow('actual responses');
  expect(()=>beginReferralSubmission(run,id,{wrong:'def'})).toThrow();expect(()=>beginReferralSubmission(run,id,{q1:' '})).toThrow();
  beginReferralSubmission(run,id,{q1:mode==='generated'?'def':'function'});await gradeReferralSubmission(run,id,deps);
  expect(store.getRun(run)?.status).toBe('done');const result=referralRunView(run).candidates[0];
  expect(result.grade).toBe(mode==='generated'?1:0);expect(result.claims[0].status).toBe(mode==='generated'?'verified':'contradicted');
  expect(toShortlist(store.getRun(run)!.state)[0].simulatedResponses).toBe(false);
  expect(store.getRun(run)!.state.audit.findings[0]).toContain('cannot establish');
  expect(()=>beginReferralSubmission(run,id,{q1:'def'})).toThrow();
});
test('generation failure sends no invitations and invents no responses or grades',async()=>{
  const id=referralSnapshot().records[0].id,run=createReferralRun('Backend engineer needs Python APIs',[id],'backend');await checkReferrals(run,deps);beginReferralApproval(run,[id]);const before=invites;
  try{await prepareReferralAssessments(run,{...deps,prepareAssessment:async()=>{throw new Error('Provider unavailable');}});}catch(e){failReferralRun(run,e);}
  expect(invites).toBe(before);expect(referralRunView(run).status).toBe('failed');expect(referralRunView(run).candidates[0].grade).toBeNull();expect(referralRunView(run).candidates[0].submitted).toBe(false);
});
test('missing evidence remains unscored and rejects unknown candidates',async()=>{
  expect(()=>createReferralRun('Backend engineer needs Python APIs',['ref_'+'0'.repeat(24)],'backend')).toThrow();
  const id=referralSnapshot().records[0].id,run=createReferralRun('Backend engineer needs Python APIs',[id],'backend');await checkReferrals(run,deps);beginReferralApproval(run,[id]);await prepareReferralAssessments(run,deps);beginReferralSubmission(run,id,{q1:'def'});
  await gradeReferralSubmission(run,id,{...deps,gradeWithModule:async()=>({grade:{total:0,parts:[{kind:'short',score:0,confidence:0}],regraded:false},verdicts:[{claimId:'python',skill:'Python',claim:claim.assertion,status:'not_tested',reason:'Low confidence',questions:['q1']}]})});
  expect(referralRunView(run).candidates[0].grade).toBeNull();expect(referralRunView(run).candidates[0].claims[0].status).toBe('not_tested');
});
