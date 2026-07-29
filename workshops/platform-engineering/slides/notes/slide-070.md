Everything up to now has been day 1: build it, ship it, watch it come up green. Day 2 is where platforms actually earn their keep — the moment something that was working breaks, usually because someone (maybe you) pushed a change. Module 05 taught the debugging discipline with a bring-your-own AI assistant sitting outside the platform; this module puts an agent INSIDE the platform as a first-class, GitOps-delivered capability, wired straight into the Console built in module 08.

The shape of the module: three realistic faults land as plausible git commits against your own demo-app (a bad rollback, a "rightsizing" that OOMKills, an image reference that quietly points at Docker Hub). Work each one through an escalation ladder — signal, hint, agent — and fix everything with git revert, never a console apply button.

This is a stretch module: nothing later depends on it, and module 05's muscle memory is the rehearsed fallback if anything about Kagent itself misbehaves on the day.
