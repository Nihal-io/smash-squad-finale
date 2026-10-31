import { NextResponse } from 'next/server';
import { z } from 'zod';
import { extractResumeText, MAX_RESUME_BYTES, ResumeInputError } from '@/src/referrals/files';
import { referralSnapshot, saveReferral } from '@/src/referrals/store';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=60;

export async function GET(){
  return NextResponse.json({referrals:referralSnapshot().records.map(({id,name,filename,years,createdAt})=>({id,name,filename,years,createdAt}))});
}

export async function POST(req:Request){
  try{
    const limit=MAX_RESUME_BYTES+64*1024;
    if(Number(req.headers.get('content-length'))>limit)throw new ResumeInputError('The upload exceeds 3 MB.');
    if(!req.headers.get('content-type')?.startsWith('multipart/form-data'))throw new ResumeInputError('Send the resume as multipart form data.');
    // Bound the body even when Content-Length is absent or inaccurate.
    const reader=req.body?.getReader();if(!reader)throw new ResumeInputError('No file was supplied.');
    const chunks:Uint8Array[]=[];let size=0;
    try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw new ResumeInputError('The upload exceeds 3 MB.');}chunks.push(value);}}
    finally{reader.releaseLock();}
    const data=new Uint8Array(size);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length;}
    const form=await new Response(data,{headers:{'content-type':req.headers.get('content-type')!}}).formData();
    const file=form.get('file');
    if(!(file instanceof File)||form.getAll('file').length!==1)throw new ResumeInputError('Choose one PDF, DOCX, or TXT resume.');
    const name=z.string().trim().min(1).max(120).parse(form.get('name'));
    const years=z.coerce.number().min(0).max(80).parse(form.get('years')||0);
    const text=await extractResumeText(file.name,new Uint8Array(await file.arrayBuffer()));
    const {record,duplicate}=await saveReferral({name,text,years,filename:file.name});
    return NextResponse.json({id:record.id,name:record.name,duplicate,characters:text.length},{status:duplicate?200:201});
  }catch(e){
    if(e instanceof ResumeInputError||e instanceof z.ZodError)return NextResponse.json({error:e instanceof ResumeInputError?e.message:'Provide a candidate name and valid years of experience.'},{status:400});
    console.error('[referral upload]',e);return NextResponse.json({error:'Could not index this resume. Check that the embedding model and private data directory are available.'},{status:503});
  }
}
