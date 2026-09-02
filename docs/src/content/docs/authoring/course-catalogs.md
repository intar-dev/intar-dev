---
title: Course catalogs
---

Course source is Markdown-first. The course and lecture Markdown teach the
theory. An optional HCL file provides the runnable technical scenario.

```text
content/
  courses/
    linux-operations/
      course.md
      01-broken-nginx/
        lecture.md
        scenario.hcl
        ...scenario runtime files
  scenarios/
    base-images.hcl
```

The course directory name is the Course ID. The lecture directory name is the
Lecture ID. Both IDs must be safe slugs. The CLI sorts both levels by directory
name. Use prefixes such as `01-`, `02-`, and `03-` to set the learning order.

Every Course needs `course.md` and at least one Lecture directory. Every
Lecture needs `lecture.md`. A Lecture can contain one `scenario.hcl`; HCL
outside a Lecture is invalid. Scenario IDs come from the HCL and must be unique
in the complete Course source. They do not need to match the Lecture ID.

`course.md` and `lecture.md` must start with YAML frontmatter, contain only the
fields shown below, and have a non-empty Markdown body. The CLI rejects
symlinks, duplicate YAML keys, YAML merge keys, unknown fields, invalid types,
and empty bodies.

## Course Markdown

`course.md` sets the Course title, summary, and order policy:

```markdown
---
title: Linux operations
summary: Learn how to diagnose and repair common Linux service failures.
sequential: true
---

This course explains the operating model before each repair exercise.
```

`sequential: true` requires a learner to complete each Lecture before the next
Lecture opens. `false` makes all Lectures available.

## Lecture Markdown

`lecture.md` contains the theory and the task context. Its fields are:

```markdown
---
title: Broken Nginx
summary: Bring a stopped website back online.
category: web
tags: [nginx, systemd, linux]
difficulty: easy
estimated_minutes: 15
---

Nginx accepts HTTP requests and returns website content.
```

`title`, `summary`, `category`, `tags`, and `estimated_minutes` are required.
`tags` must be non-empty and unique. `estimated_minutes` must be greater than
zero. `difficulty` is required when the Lecture has `scenario.hcl`; it is
optional for a theory-only Lecture.

The HCL file contains only technical Scenario data: images, VMs, probes, hints,
solutions, and build steps. Do not set `title`, `category`, `tags`,
`difficulty`, `estimated_minutes`, `description`, or `briefing` in course HCL.
The Lecture Markdown body is the learner briefing.

Scenario IDs are globally unique safe slugs.

## Build and publish

The CLI compiles the source into `CourseCatalogSnapshotV2`. The generated
contract contains Course and Lecture IDs, fields from frontmatter, Markdown
bodies, the sequential setting, and an optional Scenario ID for each Lecture.
Only version 2 is accepted.

Run the normal image commands from the repository root:

```sh
just validate-images
just bundle-images
```

The default source root is `content/courses`. Use `--courses-root` to validate
another Course source directory. A bundle contains:

```text
curriculum/catalog.json
curriculum/<course-id>/course.md
curriculum/<course-id>/<lecture-id>/lecture.md
scenarios/<scenario-id>/**
```

The `scenarios/` tree has only technical Scenario files. It excludes
`lecture.md`. The technical scenario hash and image-builder input also exclude
`lecture.md`. A Markdown-only change updates the catalog and presentation data
without a VM image build. A HCL or runtime-file change creates a new
`intar-image-build-v11` technical hash.

Every upload contains the complete V2 snapshot for its public or organization
scope. The server replaces that scope's catalog; it does not merge Courses from
an earlier publish. A content-only Course bundle with zero technical Scenarios
is valid.

Public and organization Course source is published with the CLI bundle upload.
There is no browser HCL authoring, private browser authoring, or standalone
learner Scenario catalog. Link every learner Scenario to a Lecture.

The learner reads the Lecture before starting its linked Scenario. A theory-only
Lecture has an explicit completion action. A linked Lecture completes only after
the learner successfully finishes and saves its Scenario run.
