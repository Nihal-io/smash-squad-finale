# Demo script (about 90 seconds)

Before the demo: `bun run demo:reset`, then `bun run dev`, open `http://localhost:3000`. Every click below replays from the model cache, so it costs nothing and does not depend on the network.

1. **Post the first preset.** Click "Senior Backend Engineer, Retrieval Platform" (it carries the "unlawful line" tag), then "Post JD".
   Say: *HR pastes a JD. This one also asks for female candidates under 28 from IIT, unmarried.*

2. **Watch INTAKE.** Two amber "Refused" cards appear: gender, and marital status, each with the reason and the tier that decided.
   Say: *The unlawful lines are stripped and logged. The run continues on the lawful requirements.*

3. **Watch SOURCE.** The memory strip reads "Applied from earlier session". Each tool card shows the one-line reason first, then the call, then the result. Point at a `cite_evidence` card: five requirements, each accepted with "implied" or "explicit" and the deciding tier.
   Say: *Every claim is a verbatim quote. Framework to language counts as implied. Keyword lists get rejected.*

4. **Approve.** The modal opens with five candidates. Remove one if you like. Click "Approve and send assessments".
   Say: *Nothing is sent before this click. The send tool refuses without an approval record.*

5. **Watch ASSESS.** One call each: create, send, collect, run code, grade. The assessment module extracts each candidate's claims, treats the ones we already quoted as verified, and writes two or three questions for the rest. Each card then shows claim verdicts: verified, contradicted or not tested, with the question behind each. The outbox holds five emails, answers are labelled "Simulated".

6. **Open Fairness.** Two columns, visible and hidden identity, with rank arrows, Spearman ρ, top-5 overlap, and the gender and college-tier split of each top 5. Flip "Use blind ranking as the official shortlist".
   Say: *Same shortlist, re-ranked with names, colleges and gender removed. The numbers are whatever they are.*

7. **Back to Run.** The done card lists tool calls, reformulations and drops, and shows the tool-sequence strip.

8. **Post the second preset** ("LLM Application Engineer"). Point at the strip: more searches, two drops with reasons, one reformulation. Different JD, different plan.

9. **Open Eval.** Headline line, then the planted table (semantic vs hybrid vs keyword), the public-dataset note, 7/7 guardrails, the agent track, the cascade costs.

10. **Chaos, if asked.** Open the Chaos menu, switch on "LLM outage", post a preset: the run degrades to embedding-only ranking with a banner and still finishes with an audit.

## Questions judges ask

- *Why is this agentic?* One model decision per step, choosing the next tool from the last result; two presets produce different sequences; phases exit only when code says the condition holds.
- *What happens when a tool fails?* Postgres down → in-memory search over the same vectors. Model down → embedding-only ranking with local evidence checks. Budget hit → clean stop with the work kept. All shown as banners.
- *How do you stop a bad action?* The send gate needs an HR approval record for that exact candidate. Finalize needs an audit on exactly that id set and a validated span behind every claim.
- *Cost?* About $0.05 to $0.07 per fresh run on the small model; $0 when cached. The cascade meter shows how much the local tier resolved.
- *Next?* Real inbound replies instead of simulated ones, a JEV classifier tier, and a larger blind-ranking study across many roles.
