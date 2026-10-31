import { expect, test } from 'bun:test';
import { extractResumeText, MAX_RESUME_BYTES } from '../../src/referrals/files';

const text='Synthetic referral: built Python APIs, maintained PostgreSQL databases, and wrote automated tests for production services.';

// Small real document fixtures, assembled without another test dependency.
function pdf(pages=1, content=text) {
  const objects=['<< /Type /Catalog /Pages 2 0 R >>',`<< /Type /Pages /Count ${pages} /Kids [${Array.from({length:pages},(_,i)=>`${5+i} 0 R`).join(' ')}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const stream=`BT /F1 10 Tf 40 700 Td (${content}) Tj ET`;
  objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  for(let i=0;i<pages;i++)objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1000 800] /Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >>');
  let output='%PDF-1.4\n';const offsets=[0];
  objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(output));output+=`${i+1} 0 obj\n${o}\nendobj\n`;});
  const start=Buffer.byteLength(output);
  output+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('');
  output+=`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(output);
}
function crc32(bytes:Buffer){let crc=0xffffffff;for(const b of bytes){crc^=b;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return(crc^0xffffffff)>>>0;}
function docx() {
  const files={
    '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml':`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
  };
  const local:Buffer[]=[],central:Buffer[]=[];let offset=0;
  for(const [filename,value] of Object.entries(files)){
    const name=Buffer.from(filename),data=Buffer.from(value),crc=crc32(data),header=Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt32LE(crc,14);header.writeUInt32LE(data.length,18);header.writeUInt32LE(data.length,22);header.writeUInt16LE(name.length,26);
    local.push(header,name,data);
    const entry=Buffer.alloc(46);entry.writeUInt32LE(0x02014b50);entry.writeUInt16LE(20,4);entry.writeUInt16LE(20,6);entry.writeUInt32LE(crc,16);entry.writeUInt32LE(data.length,20);entry.writeUInt32LE(data.length,24);entry.writeUInt16LE(name.length,28);entry.writeUInt32LE(offset,42);central.push(entry,name);offset+=header.length+name.length+data.length;
  }
  const cd=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(3,8);end.writeUInt16LE(3,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,cd,end]);
}

test('extracts actual UTF-8 TXT, PDF, and DOCX files',async()=>{
  expect(await extractResumeText('referral.TXT',Buffer.from('\r\n'+text+'\r\n'))).toBe(text);
  expect(await extractResumeText('referral.pdf',pdf())).toContain(text);
  expect(await extractResumeText('referral.docx',docx())).toBe(text);
},30_000);
test('rejects unsupported, malformed, oversized, and unreadable documents',async()=>{
  for(const [filename,bytes] of [['resume.html',Buffer.from(text)],['bad.pdf',Buffer.from(text)],['bad.docx',Buffer.from(text)],['empty.txt',Buffer.alloc(0)],['too-big.txt',Buffer.alloc(MAX_RESUME_BYTES+1)],['invalid.txt',Buffer.from([0xff,0xfe])],['short.txt',Buffer.from('too short')]] as const)
    await expect(extractResumeText(filename,bytes)).rejects.toThrow();
  await expect(extractResumeText('scanned.pdf',pdf(1,''))).rejects.toThrow('OCR');
  await expect(extractResumeText('long.pdf',pdf(21))).rejects.toThrow('20 pages');
  await expect(extractResumeText('long.txt',Buffer.from('a'.repeat(60_001)))).rejects.toThrow('60,000');
});
test('rejects a DOCX declaring excessive expanded data before parsing',async()=>{
  const bytes=docx(),central=bytes.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));bytes.writeUInt32LE(11*1024*1024,central+24);
  await expect(extractResumeText('bomb.docx',bytes)).rejects.toThrow('expands');
});
