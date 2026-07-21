Everything up to now has been day 1: build it, ship it, watch it come up green. Day 2 is
where platforms earn their keep—something that worked breaks after an ordinary-looking
Git change.

Three realistic faults land as plausible commits against `demo-web`: a bad release, an
OOM-inducing "rightsizing" change, and an image reference outside the baked mirror. The
third failure is intentional and deterministic while offline; no successful Docker Hub
request is part of the lab.

The verified path is human-led and fully offline: signal → evidence → Git diff → forward
revert → live verification. The later agent material is an optional architecture and
hypothesis-comparison extension, never a completion dependency.
