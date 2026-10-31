import { z } from 'zod';

const nonempty = z.string().trim().min(1);
export const ClaimSchema = z.object({
  id: nonempty, skill: nonempty, assertion: nonempty,
  years: z.number().nonnegative().optional(), evidence: z.string().min(1),
  verified: z.boolean().default(false),
});
export const ClaimsSchema = z.array(ClaimSchema);
export const QuestionSchema = z.object({
  id: nonempty, type: z.enum(['mcq', 'short', 'code']), prompt: nonempty,
  skills: z.array(nonempty).min(1), weight: z.number().positive().default(1),
  required: z.boolean().default(false), answerKey: nonempty.optional(),
  options: z.array(nonempty).min(2).optional(), rubric: nonempty.optional(),
  tests: z.array(z.object({ input: z.string(), expected: z.string() })).optional(),
  estimatedMinutes: z.number().positive().default(5),
  claimIds: z.array(nonempty).default([]),
}).superRefine((q, ctx) => {
  if (q.type === 'mcq' && (!q.options || !q.answerKey || !q.options.includes(q.answerKey)))
    ctx.addIssue({ code: 'custom', message: 'MCQ needs options and an answerKey equal to an option' });
  if (q.type === 'short' && !q.answerKey && !q.rubric)
    ctx.addIssue({ code: 'custom', message: 'Short question needs an answerKey or rubric' });
});
export const QuestionsSchema = z.array(QuestionSchema);
export const AssessmentPackSchema = z.object({
  company: nonempty, title: nonempty, timeLimitMin: z.number().positive(),
  maxQuestions: z.number().int().positive(), passMark: z.number().min(0).max(1).default(0.7),
  questions: QuestionsSchema.min(1),
});
export const RubricGradeSchema = z.object({
  score: z.number().min(0).max(1), reason: nonempty,
  confidence: z.number().min(0).max(1),
});
export const LimitsSchema = z.object({
  maxQuestions: z.number().int().positive().default(8),
  timeLimitMin: z.number().positive().default(40),
  passMark: z.number().min(0).max(1).default(0.7),
  minConfidence: z.number().min(0).max(1).default(0.7),
});
export type Claim = z.infer<typeof ClaimSchema>;
export type Question = z.infer<typeof QuestionSchema> & { source: 'generated' | 'company' };
export type AssessmentPack = z.infer<typeof AssessmentPackSchema>;
export type Limits = z.input<typeof LimitsSchema>;
export type LLM = (prompt: string, schema: z.ZodType) => Promise<unknown>;
export type Plan = {
  questions: Question[]; coverage: Record<string, string[]>; uncovered: string[];
  rationale: string; passMark: number; minConfidence: number;
};
export type Grade = {
  questionId: string; status: 'graded' | 'pending' | 'missing' | 'unusable';
  score?: number; confidence?: number; reason: string; answerExcerpt?: string;
};
export type ClaimResult = {
  claimId: string; status: 'verified' | 'contradicted' | 'not_tested';
  score?: number; questionIds: string[]; answerExcerpt?: string; reason: string;
};
export type CandidateQuestion = Pick<Question, 'id' | 'type' | 'prompt' | 'options' | 'estimatedMinutes'>;
