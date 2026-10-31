import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { redactProfile } from '../lib/redact';
import type { CandidateRow } from '../lib/db';
import { EMBED_DIM, embedTexts } from '../lib/embed';

const RecordSchema = z.object({
  id: z.string().regex(/^ref_[a-f0-9]{24}$/), name: z.string().min(1).max(120),
  text: z.string().min(80).max(60_000), redacted: z.string(), filename: z.string().max(200),
  years: z.number().min(0).max(80), createdAt: z.number(),
  visibleVector: z.array(z.number().finite()).length(EMBED_DIM),
  redactedVector: z.array(z.number().finite()).length(EMBED_DIM),
});
export type ReferralRecord = z.infer<typeof RecordSchema>;
export const referralDirectory = () => join(dirname(process.env.DB_PATH || './data/app.db'), 'referrals');
let snapshot: { version: string; records: ReferralRecord[] } = { version: '', records: [] };

export function referralSnapshot() {
  const dir = referralDirectory();
  const files = existsSync(dir) ? readdirSync(dir).filter(n => /^ref_[a-f0-9]{24}\.json$/.test(n)).sort() : [];
  const version = dir + files.map(n => { const s = statSync(join(dir,n)); return `${n}:${s.mtimeMs}:${s.size}`; }).join('|');
  if (snapshot.version !== version) snapshot = { version, records: files.map(n => RecordSchema.parse(JSON.parse(readFileSync(join(dir,n),'utf8')))) };
  return snapshot;
}

export function referralCandidate(record: ReferralRecord): CandidateRow {
  return { id: record.id, source: 'referral', name: record.name, gender: 'not provided', college: '', tier: 0,
    yoe: record.years, role: 'Referred candidate', skills: [], projects: [], bio: record.text,
    visible_text: record.text, redacted_text: record.redacted, archetype: 'referral', planted: '', planted_for: null,
    flags: ['uploaded_resume', 'real_answers_required'] };
}

export async function saveReferral(input: { name: string; text: string; filename: string; years?: number }, embed = embedTexts) {
  const name = z.string().trim().min(1).max(120).parse(input.name);
  const years = z.number().finite().min(0).max(80).parse(input.years ?? 0);
  const text = z.string().min(80).max(60_000).parse(input.text);
  const id = 'ref_' + createHash('sha256').update(JSON.stringify({ name: name.toLowerCase(), text, years })).digest('hex').slice(0,24);
  const existing = referralSnapshot().records.find(r => r.id === id);
  if (existing) return { record: existing, duplicate: true };
  const redacted = redactProfile({ text, names: [name, ...name.split(/\s+/).filter(x => x.length > 2)], colleges: [] })
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[EMAIL]')
    .replace(/(?:\+?\d[\d ()-]{7,}\d)/g, '[PHONE]');
  const vectors = await embed([text, redacted]);
  const record = RecordSchema.parse({ id, name, text, redacted, years, filename: input.filename.replace(/^.*[\\/]/,'').slice(0,200),
    createdAt: Date.now(), visibleVector: vectors[0], redactedVector: vectors[1] });
  const dir = referralDirectory(); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir,`${id}.${randomUUID()}.tmp`);
  writeFileSync(temp, JSON.stringify(record), { mode: 0o600 }); renameSync(temp,join(dir,`${id}.json`));
  return { record, duplicate: false };
}
