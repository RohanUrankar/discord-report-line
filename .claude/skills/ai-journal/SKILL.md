---
name: ai-journal
description: Keeps docs/ai-journal.md, a running, honest log of every time an AI agent (including you) got something wrong — a wrong API assumption, a bug in generated code caught by a test or the quality verifier, a user correction, docs contradicting memory — plus how it was noticed and fixed. Later used to write AI_NOTES.md, whose "hardest bug" section graders read most closely. Use this immediately whenever a test fails because of code you or another agent wrote, a library behaves differently from what you expected, the user corrects you, the verifier reports a failure, or you reverse an earlier approach, and when drafting AI_NOTES.md.
---

# AI journal

The assignment asks for "the single hardest bug or wrong turn the AI led you into — what it got wrong, how you noticed, and how you fixed it", and says that's the part they read most closely. Reconstructing that from memory at the end produces vague, flattering stories. Capturing it at the moment it happens produces specific, credible ones. So: log while the evidence is fresh.

## When to add an entry

Add one whenever any of these happen — even if the fix took 30 seconds:

- A test, typecheck, or the quality-verifier failed on AI-written code.
- A library/API behaved differently from what was assumed (signature, async vs sync, defaults, version change).
- Context7/official docs contradicted what was "remembered".
- The user corrected an approach or rejected a suggestion.
- You undid or rewrote something you or another agent built earlier in the session.
- A deploy or integration failed in a way local tests didn't predict.

Don't log routine iteration (typo fixed before running anything) — the journal is for moments where a wrong belief survived long enough to matter.

## Entry format

Append to `docs/ai-journal.md` (create it with a `# AI journal` heading if missing). Newest at the bottom.

```markdown
### YYYY-MM-DD — <area>: <one-line summary>
- **Believed / generated:** what the AI assumed or wrote (quote the code or claim, briefly).
- **Noticed by:** the concrete signal — failing test name, verifier check, error message, user comment, log line.
- **Root cause:** why the belief was wrong (stale training data, missing await, misread docs, wrong default…).
- **Fix:** what changed (file/commit).
- **Cost:** rough time lost / blast radius (e.g. "would have accepted forged requests in prod").
- **Lesson → guardrail:** what now prevents a repeat (test added, skill updated, hook added) or "none".
```

Be blunt and specific. "The verifier sent an unsigned POST and got 200" beats "there was an issue with verification". Note who erred — "backend-implementer", "me (orchestrator)", "the user's initial suggestion" — without blame theatre.

## Drafting AI_NOTES.md from the journal

When asked to write AI_NOTES.md (~1 page):

1. **Tools & split** — models/agents used and roughly what the human decided vs. delegated.
2. **2–3 key decisions** — pull from accepted ADRs where the human made the call; one line each on why.
3. **Hardest bug** — pick the entry with the highest `Cost` × subtlety (it looked right, passed a naive check, and would have bitten in production). Tell it as: what the AI produced → how it was noticed → why it was wrong → fix → guardrail. Quote the actual wrong line if short.
4. **With more time** — real gaps, not filler.
5. Optional short prompt excerpt from the trickiest moment.

Never invent or embellish an incident to make the notes more interesting — the graders compare against the commit history.
