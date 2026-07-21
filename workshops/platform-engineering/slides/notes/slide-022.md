This is how every module works, so learn it once:

1. Participant content states an outcome and where to look. It deliberately does not hand
   over the canonical build scripts.
2. Intar releases layered hints independently. Solution reveal is an explicit learner or
   facilitator action and remains separate from participant content.
3. The pinned manual `verify.sh` checks the running cluster. Intar maps it to named probes
   and keeps technical verification separate from explain-back. A later regression shows
   in current health without erasing latched completion.
4. Canonical catch-up scripts run only in the trusted publication builder. Learners recover
   through a checkpoint restore: Intar warns about lost post-checkpoint work, archives the
   old execution, starts a new generation, and preserves progress/audit history. Skipped
   modules are recorded as caught up, never verified.

At each core boundary, use the explain-back prompt. A green probe proves state; the
explain-back proves the learner can articulate why it works.
