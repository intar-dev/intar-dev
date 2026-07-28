# GO — Module 10

**Outcome:** watch a stock local model flail on your own fault — then flip one field and watch a hosted model actually diagnose it.

```bash
# enable kagent.yaml, inject a scenario, open the app's Case file in the Console
cd lab/10-day2-ops && ./verify.sh
```

~20 min · beat 1: `qwen3:4b` flails · beat 2: one `ModelConfig` push fixes it
