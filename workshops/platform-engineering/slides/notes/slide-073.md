Every model in this table can look competent at one well-formed tool call. Real incident
diagnosis chains get → describe → logs → events → hypothesis while carrying state, which
is why multi-turn evaluation matters.

Use the table as architecture context, not as a live benchmark promise. The Intar guest
does not ask learners to install Ollama, load a model beside the cluster, or call a hosted
provider. Those choices would change resource and network assumptions and are therefore
outside the verified workshop contract.

The transferable point is the cliff between a plausible single response and a sustained
evidence chain. Purpose-built models may improve the numbers; every diagnosis still needs
an explicit kill-test against the live system.
