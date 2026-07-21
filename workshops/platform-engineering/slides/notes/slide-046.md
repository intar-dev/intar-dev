The philosophy slide. Installing things teaches less per minute than debugging things — that's why fault injection is a core module, not a stretch.

The loop we're drilling:
1. Find the SYMPTOM first (get all, logs) before hunting causes.
2. Write down a one-sentence diagnosis — literally write it: "the pod can't X because Y". Unwritten diagnoses mutate to fit whatever you find next.
3. Before fixing anything, ask: if this sentence were true, what exactly would I observe on the live cluster? Design the observation that would falsify it.
4. Go observe. If reality disagrees, the diagnosis is dead — write a new one. This loop IS the module.

Four faults, escalating deviousness, each in its own faultlab-NN namespace so the real platform is never at risk: a deploy that never comes up, a database frozen mid-birth, everything-healthy-nothing-connects, and "works... sometimes."

Verify against the running system, never against text — that's design principle #6, and it applies equally to your own hunches and to anything an agent tells you.
