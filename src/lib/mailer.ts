// Messaging tool: Resend when RESEND_API_KEY is set (to the test inbox only), otherwise the outbox. Every send is logged.
import { store } from "./store";
import type { CandidateState } from "../agent/state";

export async function sendAssessmentEmail(runId: string, st: CandidateState, a: NonNullable<CandidateState["assessment"]>) {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.RESEND_TEST_TO || "test-inbox@example.com";
  const body = `${a.emailBody}\n\n---\n${a.questions.map((q, i) => `${i + 1}. ${q.prompt}`).join("\n\n")}`;
  let channel: "resend" | "outbox" = "outbox";
  let status = "queued";
  if (key) {
    try {
      const { Resend } = await import("resend");
      const r = await new Resend(key).emails.send({ from: process.env.RESEND_FROM || "onboarding@resend.dev", to, subject: a.emailSubject, text: body });
      channel = "resend";
      status = r.error ? `error: ${r.error.message}` : `sent:${r.data?.id}`;
    } catch (e: any) {
      status = `error: ${e?.message}`;
      channel = "outbox";
    }
  }
  const id = `msg_${st.id}`;
  store.addOutbox({ id: `${runId}_${id}`, runId, candidateId: st.id, to, subject: a.emailSubject, body, channel, status, ts: Date.now() });
  return { messageId: id, channel, status, to: channel === "resend" ? to : "(outbox)", subject: a.emailSubject };
}
