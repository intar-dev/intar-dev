---
title: Course catalogs
---

Courses are authored independently from scenario manifests in the optional
`content/courses.hcl` file. The order of the blocks is the order shown in the
catalog, and the order of `scenarios` is the curriculum order inside the course.

```hcl
course "linux-operations" {
  title       = "Linux operations"
  description = "Practice Linux failures adapted from [the upstream course](https://example.test/course)."
  scenarios   = ["broken-nginx"]
}
```

Course IDs and scenario IDs must be safe path-style identifiers. Every course
needs a non-empty title, description, and scenario list. Course IDs must be
unique, and a scenario may appear in at most one course in a snapshot.

Descriptions support inline Markdown. Links are active on a course detail page
and appear as plain link labels in course pickers, where nested links would be
invalid.

## Publication semantics

Image bundle creation reads the complete manifest even when bundling one
scenario. The normalized version-1 course snapshot is carried in bundle
metadata, while the original `courses.hcl` is included in the archive for
provenance. Course metadata does not change scenario manifests, content hashes,
or image-builder inputs.

For a standalone source passed as `--courses-root /path/to/source/courses`, the
manifest is the sibling `/path/to/source/courses.hcl`. The complete nested
scenario tree is still used to validate a partial bundle's course snapshot.

The file's presence is meaningful:

- No `courses.hcl`: omit course metadata and leave the stored catalog unchanged.
- Empty `courses.hcl`: publish an empty replacement snapshot and clear the
  scope's courses.
- Non-empty `courses.hcl`: replace the scope's ordered snapshot.

Public bundle uploads publish the public course snapshot. Organization bundle
uploads publish that organization's snapshot; those courses may reference
public scenarios and private scenarios from the same organization. References
to unavailable or other-organization scenarios are rejected.

Use the existing image commands to validate and publish content:

```sh
just validate-images
just bundle-images
```

Courses affect catalog presentation only. Scenario assignments, run progress,
scenario detail routes, and image build formats remain scenario-based.
