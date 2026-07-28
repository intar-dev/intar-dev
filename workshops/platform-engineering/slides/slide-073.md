# The cliff: one tool call vs. a diagnosis

| Model | Single-turn | Multi-turn (BFCL v3) |
|---|---|---|
| GPT-4o-class | ~80–90% | **~41–48%** |
| Qwen3-4B (`qwen3:4b`, 2.5 GB) | ~80%+ | **~16%** |
| Llama-3.1-8B-Instruct | ~80%+ | **~5%** |

- A seeded fault needs 5–15 chained tool calls
- Stock ≤8B models: **single digits to ~16%** in that regime
- The drop is **~5–16×** for small models — ~2× for GPT-4o-class

Source: BFCL v3 multi-turn — https://gorilla.cs.berkeley.edu/blogs/13_bfcl_v3_multi_turn.html; exact small-model figures via papers using BFCL v3 baselines (see issue #124 for the research trail — treat the digits as indicative, the cliff as robust)
