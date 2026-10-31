import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { NextResponse } from 'next/server';
import { store } from '@/src/lib/store';
import { ensureDataOnce } from '@/src/lib/bootstrap';
import { createReferralRun, checkReferrals, beginReferralApproval, prepareReferralAssessments,
  beginReferralSubmission, gradeReferralSubmission, referralRunView, failReferralRun, ReferralConflict } from '@/src/referrals/workflow';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=300;
const Id=z.string().min(1).max(100);
const Action=z.discriminatedUnion('action',[
  z.object({action:z.literal('check'),candidateIds:z.array(Id).min(1).max(10),sourceRunId:Id.optional(),presetId:Id.optional(),jdText:z.string().trim().min(20).max(20_000).optional()}),
  z.object({action:z.literal('approve'),runId:Id,approved:z.array(Id).max(10)}),
  z.object({action:z.literal('submit'),runId:Id,candidateId:Id,answers:z.record(z.string().max(20_000)).refine(a=>Object.keys(a).length<=10)}),
]);
function background(id:string,work:()=>Promise<unknown>){void work().catch(e=>{console.error('[referral workflow]',e);failReferralRun(id,e);});}

export async function GET(req:Request){
  try{return NextResponse.json(referralRunView(Id.parse(new URL(req.url).searchParams.get('runId'))));}
  catch{return NextResponse.json({error:'Unknown referral run.'},{status:404});}
}
export async function POST(req:Request){
  try{
    // Answers and metadata are JSON, not another unbounded upload body.
    let raw='';const reader=req.body?.getReader();if(!reader)throw new Error('Missing request body.');
    let size=0;const decoder=new TextDecoder();
    try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>240_000){await reader.cancel();throw new Error('Request is too large.');}raw+=decoder.decode(value,{stream:true});}raw+=decoder.decode();}finally{reader.releaseLock();}
    const body=Action.parse(JSON.parse(raw));
    if(body.action==='check'){
      await ensureDataOnce();
      const source=body.sourceRunId?store.getRun(body.sourceRunId):null;
      const preset=body.presetId?JSON.parse(readFileSync('data/jds.json','utf8')).presets.find((p:any)=>p.id===body.presetId):null;
      if(body.sourceRunId&&!source)throw new Error('The selected existing job run was not found.');
      if(body.presetId&&!preset)throw new Error('The selected JD preset was not found.');
      const jdText=source?.jdText??preset?.text??body.jdText;
      if(!jdText)throw new Error('Select an existing JD or supply the current job description.');
      const id=createReferralRun(jdText,body.candidateIds,source?.roleKey??preset?.archetype??'referral');
      background(id,()=>checkReferrals(id));return NextResponse.json({runId:id},{status:202});
    }
    if(body.action==='approve'){
      beginReferralApproval(body.runId,body.approved);
      background(body.runId,()=>prepareReferralAssessments(body.runId));
    }else{
      beginReferralSubmission(body.runId,body.candidateId,body.answers);
      background(body.runId,()=>gradeReferralSubmission(body.runId,body.candidateId));
    }
    return NextResponse.json({runId:body.runId},{status:202});
  }catch(e){
    const conflict=e instanceof ReferralConflict;
    const error=e instanceof z.ZodError?'Invalid workflow request.':e instanceof SyntaxError?'Invalid JSON.':e instanceof Error?e.message:'Could not process the request.';
    return NextResponse.json({error},{status:conflict?409:400});
  }
}
