The hands-on outcome is the day-2 loop, not a model call. Inject scenario 1 twice (first
seed, then fault), open the released Cloudbox Console app for the signal, collect evidence
in the guest terminal, connect it to the exact Git diff, push a forward revert, and run
the pinned verifier.

Scenarios 2 and 3 use the same loop. Scenario 3's unmirrored external image is the fault:
ImagePullBackOff is expected while offline, and the repair returns Git to the baked image.

External AI is an optional comparison only. It requires the learner's own connectivity
and provider credential, is not timed or verified, and must never delay the offline hints,
solution reveal, helper flow, or checkpoint recovery.
