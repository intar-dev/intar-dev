---
title: Image v11 Course Catalog Cutover
---

Image v11 uses `CourseCatalogSnapshotV2` and Markdown-first Course source. It
keeps the 4 MiB content-addressed image chunks and the read-only guest tools
disk. A Course Markdown update does not change an image hash. A technical HCL
or runtime-file update uses `intar-image-build-v11` and needs an image build.

This is one planned maintenance cut. HTTP 202 only means that the bundle entered
the queue. Do not reopen learner starts until the required images and hosts are
ready.

## Prepare

1. Validate the v11 CLI, builder, control plane, database migration, and
   converted Course source without publishing it.
2. Keep the prior app, CLI, builder, and Course source revision ready for
   rollback.
3. Confirm each Course contains `course.md`, each Lecture contains
   `lecture.md`, and every technical Scenario is inside a Lecture directory.
4. Confirm the V2 catalog has the required Course and Lecture IDs before the
   cut. These IDs are the stable learner-progress keys.

## Cut over

1. Stop new Scenario starts. Drain active runs and queued browser drafts.
2. Delete browser draft data and remove the old draft-source integration. The
   application cannot recover deleted drafts.
3. Replace V1 catalog storage with V2 catalog and Lecture-completion storage.
   Disable published Scenarios that do not occur in the V2 catalog.
4. Deploy the V2-only control plane, CLI, and builder.
5. Publish the complete converted V2 catalog immediately. A publish replaces
   its whole public or organization scope.
6. Backfill completion only from historical runs that successfully finished the
   linked Scenario.
7. Confirm the Course catalog, image builds, host cache, theory pages, Scenario
   starts, checks, replay, and run deletion before reopening starts.

## Verify

The cut is complete only when all required V2 catalog rows are present, all
required images are ready on the required hosts, and each Scenario has passed
boot, initial failing checks, repair, final checks, replay, and deletion proof.
Also prove one theory-only Lecture completes and unlocks the next Lecture. Then
publish a Markdown-only update and confirm it queues zero image builds.

## Roll back

Drain the fleet again before rollback. Restore the retained prior app, CLI,
builder, and source revision, then republish the prior catalog through the
approved maintenance process. Recreate an empty draft table only if the old app
requires it. Deleted browser drafts stay deleted.
