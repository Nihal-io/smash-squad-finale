import { extname } from 'node:path';

export const MAX_RESUME_BYTES = 3 * 1024 * 1024;
export const MAX_RESUME_CHARS = 60_000;

export class ResumeInputError extends Error {}

/** Extract text locally. Never render uploaded HTML or execute document macros. */
export async function extractResumeText(filename: string, bytes: Uint8Array): Promise<string> {
  if (!bytes.length || bytes.length > MAX_RESUME_BYTES) throw new ResumeInputError('Choose a non-empty resume no larger than 3 MB.');
  const extension = extname(filename).toLowerCase();
  let text: string;
  try {
    if (extension === '.txt') {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (text.includes('\0')) throw new ResumeInputError('The TXT file must contain UTF-8 text.');
    } else if (extension === '.pdf') {
      if (new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') throw new ResumeInputError('This file is not a valid PDF.');
      const { getDocumentProxy, extractText } = await import('unpdf');
      const pdf = await getDocumentProxy(new Uint8Array(bytes), { maxImageSize: 1_000_000 });
      try {
        if (pdf.numPages > 20) throw new ResumeInputError('Resumes must have 20 pages or fewer.');
        text = (await extractText(pdf, { mergePages: true })).text;
      } finally { await pdf.loadingTask.destroy(); }
    } else if (extension === '.docx') {
      checkDocxSize(bytes);
      const { extractRawText } = await import('mammoth');
      text = (await extractRawText({ buffer: Buffer.from(bytes) })).value;
    } else throw new ResumeInputError('Supported formats are PDF, DOCX, and TXT.');
  } catch (error) {
    if (error instanceof ResumeInputError) throw error;
    throw new ResumeInputError('Could not read this resume. Use an unlocked, text-based PDF, DOCX, or UTF-8 TXT file.');
  }
  text = text.replace(/\r\n?/g, '\n').trim();
  if (text.length < 80) throw new ResumeInputError('Not enough readable text. Scanned PDFs need OCR; upload a text-based document instead.');
  if (text.length > MAX_RESUME_CHARS) throw new ResumeInputError('The resume is too long. Keep it under 60,000 characters.');
  return text;
}

function checkDocxSize(bytes: Uint8Array) {
  const buf = Buffer.from(bytes);
  if (buf.readUInt32LE(0) !== 0x04034b50) throw new ResumeInputError('This file is not a valid DOCX.');
  let entries = 0, expanded = 0;
  // Central-directory entries declare the expanded size; reject common ZIP bombs
  // before giving the archive to the document parser.
  for (let i = 0; i + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(i) !== 0x02014b50) continue;
    entries++; expanded += buf.readUInt32LE(i + 24);
    if (entries > 2000 || expanded > 10 * 1024 * 1024) throw new ResumeInputError('The DOCX expands beyond the allowed document size.');
    i += 45 + buf.readUInt16LE(i + 28) + buf.readUInt16LE(i + 30) + buf.readUInt16LE(i + 32);
  }
  if (!entries) throw new ResumeInputError('The DOCX archive is incomplete.');
}
