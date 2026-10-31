import { randomUUID } from 'node:crypto';
import { store } from '../lib/store';
import { emit } from '../lib/trace';
import { getCandidateLocal, memVector, dot } from '../lib/db';
import { embedTexts, QUERY_PREFIX } from '../lib/embed';
import { sendAssessmentEmail } from '../lib/mailer';
import { parseJd } from '../agent/parse';
import { get_profile, cite_evidence } from '../agent/tools';
import { newState, type AgentState } from '../agent/state';
import { fairnessAudit } from '../agent/fairness';
import { prepareAssessment, toLegacyAssessment, gradeWithModule } from '../agent/assess-adapter';
import { referralSnapshot } from './store';

export type ReferralState = AgentState & { referralIds: string[]; referralErrors?: string[] };
const defaults = { parseJd, embedTexts, getProfile: get_profile.run, citeEvidence: cite_evidence.run,
  prepareAssessment, sendAssessmentEmail, gradeWithModule, fairnessAudit };
export type ReferralDependencies = typeof defaults;
export class ReferralConflict extends Error {}

export function createReferralRun(jdText: string, ids: string[], roleKey: string) {
  const known = new Set(referralSnapshot().records.map(r => r.id));
  if (!ids.length || ids.length > 10 || new Set(ids).size !== ids.length || ids.some(id => !known.has(id)))
    throw new Error('Choose between one and ten existing, distinct uploaded resumes.');
  const runId = `referral_${randomUUID().replaceAll('-','')}`;
  const state: ReferralState = { ...newState(runId, roleKey, jdText), referralIds: ids };
  state.targetN = ids.length;
  store.putRun({ id:runId, roleKey, jdText, status:'running', chaos:{}, createdAt:Date.now(),updatedAt:Date.now(),state });
  store.flush(); return runId;
}

function load(id: string): ReferralState {
  const r=store.getRun(id); if (!r?.state?.referralIds) throw new Error('Unknown referral run.');
  return r.state as ReferralState;
}
function save(s: ReferralState, status: Parameters<typeof store.patchRun>[1]['status']) {
  store.patchRun(s.runId,{state:s,status}); store.flush();
}

/** Same intake and evidence tools, scoped to HR's selected referrals (one is enough). */
export async function checkReferrals(runId: string, deps: ReferralDependencies = defaults) {
  const s=load(runId);
  emit(runId,'start',{roleKey:s.roleKey,referral:true,candidateIds:s.referralIds},'referrals');
  await deps.parseJd(s);
  const queries=s.jd.requirements.map(r=>QUERY_PREFIX+r.text);
  const qv=await deps.embedTexts(queries);
  for(const id of s.referralIds){
    const c=getCandidateLocal(id)!;
    const profile=await deps.getProfile({reason:'Inspect this uploaded referral against the selected JD',candidate_id:id},{state:s,runId});
    const st=s.candidates[id]; const v=memVector(id,'visible')!;
    st.semantic=qv.length?qv.reduce((n,q)=>n+dot(q,v),0)/qv.length:0;
    st.seen=1;
    const citations=profile.requirementHints.filter((h:any)=>h.bestSentence).map((h:any)=>({requirement_id:h.requirementId,quote:h.bestSentence}));
    if(citations.length)await deps.citeEvidence({reason:'Check verbatim resume evidence; leave unsupported requirements as gaps',candidate_id:id,citations},{state:s,runId});
    emit(runId,'note',{candidateId:id,text:`${c.name}: ${st.evidence.length}/${s.jd.requirements.length} requirements have resume evidence. Assessment answers are still required.`},'referrals');
  }
  s.shortlist=[...s.referralIds];
  emit(runId,'interrupt',{kind:'hr_approval',candidateIds:s.shortlist,rationale:'Review referral matches and evidence gaps. Uploading a resume does not approve contact or verify its claims.',
    candidates:s.shortlist.map(id=>s.candidates[id])},'request_hr_approval');
  save(s,'waiting_approval');
}

/** Called synchronously before background work so duplicate approval requests fail. */
export function beginReferralApproval(runId: string, approved: string[]) {
  const s=load(runId);
  if(store.getRun(runId)!.status!=='waiting_approval')throw new ReferralConflict('This run is not awaiting HR approval.');
  if(new Set(approved).size!==approved.length||approved.some(id=>!s.shortlist.includes(id)))throw new Error('Approval contains an unknown or duplicate candidate.');
  s.approval={approved,removed:s.shortlist.filter(id=>!approved.includes(id))};
  store.approve(runId,approved,s.approval.removed);save(s,'running');
}

export async function prepareReferralAssessments(runId: string, deps: ReferralDependencies = defaults) {
  const s=load(runId), ids=s.approval!.approved;
  emit(runId,'approval',s.approval,'request_hr_approval');
  s.phase='ASSESS';emit(runId,'phase',{phase:'ASSESS',text:'Preparing assessments for approved referrals. Real answers are required.'},'referrals');
  if(!ids.length){s.final={ranked:[],weights:{semantic:1,assessment:0},summary:'HR approved no referrals.',officialBlind:false};s.phase='DONE';save(s,'done');return;}
  // Prepare all plans before any email is queued. A provider failure leaves no
  // fictional answers or fabricated scores, and no partial batch of invitations.
  for(const id of ids){
    const st=s.candidates[id];
    // A quote establishes what the resume says, not whether the claim is true.
    // Keep matching evidence for HR, but require assessment evidence for referrals.
    const prep=await deps.prepareAssessment(s,{...st,evidence:[]},s.jd.requirements.map(r=>r.id),runId);
    st.assessV2=prep;st.assessment=toLegacyAssessment(s,st,prep);
  }
  save(s,'running');
  for(const id of ids){
    const st=s.candidates[id];
    if(!st.sent){const message=await deps.sendAssessmentEmail(runId,st,st.assessment!);st.sent={channel:message.channel,at:Date.now()};save(s,'running');}
  }
  emit(runId,'note',{text:'Waiting for actual referral responses. HR can paste received answers in the Referrals screen. No answers are simulated.'},'referrals');
  save(s,'waiting_responses');
}

export function beginReferralSubmission(runId:string,candidateId:string,answers:Record<string,string>){
  const s=load(runId),st=s.candidates[candidateId];
  if(store.getRun(runId)!.status!=='waiting_responses')throw new ReferralConflict('This run is not awaiting responses.');
  if(!s.approval?.approved.includes(candidateId)||!st?.assessV2||!st.sent)throw new Error('This candidate has no approved assessment.');
  if(st.responses)throw new ReferralConflict('Answers have already been submitted for this candidate.');
  const questions=st.assessV2.plan.questions as {id:string;type:string}[];
  if(!Object.values(answers).some(a=>a.trim())||Object.keys(answers).some(id=>!questions.some(q=>q.id===id)))throw new Error('Supply actual answers using the assessment question IDs.');
  st.responses=questions.map(q=>({questionId:q.id,kind:q.type==='code'?'code':q.type==='mcq'?'short':'scenario',answer:answers[q.id]??''}));
  st.responsesSimulated=false;save(s,'running');
}

export async function gradeReferralSubmission(runId:string,candidateId:string,deps:ReferralDependencies=defaults){
  const s=load(runId),st=s.candidates[candidateId];
  const result=await deps.gradeWithModule(s,st,st.assessV2 as any,runId);
  st.claimVerdicts=result.verdicts;
  if(result.grade.parts.some(p=>p.confidence>=0.7))st.grade=result.grade;
  else if(!st.flags.includes('grading_incomplete'))st.flags.push('grading_incomplete');
  emit(runId,'note',{candidateId,text:'Graded actual submitted answers against the saved assessment plan.',simulated:false},'grade_answer');
  const ids=s.approval!.approved;
  if(ids.some(id=>!s.candidates[id].responses)){save(s,'waiting_responses');return;}
  s.phase='AUDIT';emit(runId,'phase',{phase:'AUDIT',text:'Auditing the assessed referral shortlist.'},'referrals');
  s.audit=await deps.fairnessAudit(s,ids);
  if(ids.length===1)s.audit.findings=['One referral was assessed. A single-candidate audit cannot establish ranking fairness.'];
  emit(runId,'audit',s.audit,'fairness_audit');
  const score=(id:string)=>{const c=s.candidates[id];return c.grade?0.6*c.semantic+0.4*c.grade.total:c.semantic;};
  const ranked=[...ids].sort((a,b)=>score(b)-score(a));
  s.final={ranked,weights:{semantic:0.6,assessment:0.4},summary:'Referral review completed using actual submitted answers. See evidence gaps and claim verdicts; HR makes the hiring decision.',officialBlind:false};
  s.phase='DONE';emit(runId,'done',{final:s.final,degraded:s.degraded,referral:true},'referrals');save(s,'done');
}

/** Recovery after a provider failure never overwrites another run's data. */
export function failReferralRun(runId:string,error:unknown){
  const s=load(runId);s.referralErrors=[error instanceof Error?error.message:'Referral processing failed'];
  emit(runId,'error',{text:'Referral processing could not finish. Check the server provider configuration and start a new check. No assessment results were invented.'},'referrals');save(s,'failed');
}

/** Candidate-facing question data; excludes stored keys, rubrics and test cases. */
export function referralRunView(runId:string){
  const s=load(runId);
  return {runId,status:store.getRun(runId)!.status,title:s.jd.title,refused:s.jd.refused,degraded:s.degraded,
    errors:s.referralErrors?.map(()=> 'A processing step failed. Check server logs.'),
    candidates:s.referralIds.map(id=>{const c=s.candidates[id];return {id,name:c?.name??getCandidateLocal(id)?.name,
      semantic:c?.semantic??null,evidence:c?.evidence??[],missing:s.jd.requirements.filter(r=>!c?.evidence.some(e=>e.requirementId===r.id)).map(r=>r.text),
      approved:!!s.approval?.approved.includes(id),submitted:!!c?.responses,grade:c?.grade?.total??null,claims:c?.claimVerdicts??[],
      questions:c?.assessV2?.plan.questions.map((q:any)=>({id:q.id,type:q.type,prompt:q.prompt,options:q.options}))??[]};})};
}
