The ladder is deliberate, and it's the same one built across modules — not a new invention for module 10.

Step 1, Signal: the diagnostics work (DR-0005 slice 1) gave every resource page a WHY-it's-unhealthy rollup — CrashLoopBackOff, ProgressDeadlineExceeded, whatever the controller reports, no guessing required.

Step 2, Hint: DR-0005 slice 2 turned that signal into a cause → action hint — "likely OOM, check requests/limits" — one click deeper, still fully deterministic, no LLM involved anywhere yet.

Step 3, Agent: only when the hint runs out does "Open investigation" appear on the application-detail page, and it's always available, never mandatory — most incidents resolve at step 1 or 2, and that's the ladder working as designed, not the agent failing to add value.

The pedagogical point of the whole slide: an AI agent is the LAST resort here, not the first reflex — the opposite of "day 2 starts by pasting logs into a chatbot." The Console already told you WHAT'S wrong and probably WHY; the agent earns its keep on the harder slice where those aren't enough.
