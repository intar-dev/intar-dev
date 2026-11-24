# Content

This directory is a scenario repository: the same format an organization
keeps in a repository of its own. It holds the course Intar ships, and CI
uses it to check the scenario toolchain against real content.

```text
intar.hcl                           marks the repository root
scenarios/<slug>/scenario.hcl       one scenario: its machines, tasks, checks, hints and solution
courses/<course>/course.md          the course: front matter and an introduction
courses/<course>/<nn>-<name>/lecture.md   one lecture; the directories sort into the course's order
```

A lecture is Markdown with front matter. `scenario: <slug>` in it links the
lecture to a scenario; a lecture without it is theory only. Learners reach a
scenario only through a lecture, so every scenario must be named by at least
one. Otherwise validation refuses the repository with
``scenarios/<slug>/scenario.hcl: no lecture names the scenario `<slug>`: ...``.

[`scenarios/broken-nginx/scenario.hcl`](scenarios/broken-nginx/scenario.hcl)
is a complete, small example.

## Checking it

From the repository root:

```sh
cargo run -p intar-image-cli -- validate --root content      # every scenario, image and course, with lints
cargo run -p intar-image-cli -- fmt --root content           # lay the HCL files out canonically
cargo run -p intar-image-cli -- spec broken-nginx --root content   # print a scenario as its machines will run it
```

`cuenv task validate-images` runs all three as checks, and the `images` lane
runs it in CI. `cargo run -p intar-image-cli -- --help` lists the rest of the
CLI, which builds and publishes images.
