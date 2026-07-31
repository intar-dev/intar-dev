#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const PINNED_REVISION = "1b6fad43551a720b143d7a52799f81c4c89455cb";
const EXPECTED_RAW_TREE_SHA256 =
  "368e5abd243cc0058bd30b55e2f35cb143d1fe5166d9bb3ae1b02b42630a47c4";
const EXPECTED_ADAPTED_TREE_SHA256 =
  "3b6dad9e56adeb92a19eccdcdf05db8104f5a43f7d184c67ab0dcec3ef2f1180";
const EXPECTED_OVERLAY_SHA256 =
  "d812453117d4dc2ba3c47b21c7e3d865c1efbfd7aed8253b84ec411803e25b8f";
const EXPECTED_CHANGED_FILES = 2;

const rawRoot = resolve(process.argv[2] ?? "");
const adaptedRoot = resolve(process.argv[3] ?? "");
if (!process.argv[2] || !process.argv[3]) {
  throw new Error(
    "usage: bun scripts/check-platform-engineering-workshop-import.ts RAW_IMPORT ADAPTED_TREE",
  );
}

assertNullSafeConditionWaitContract(rawRoot, "regenerated import");
assertNullSafeConditionWaitContract(adaptedRoot, "checked-in workshop");
assertModule07VerifierContract(rawRoot, "regenerated import");
assertModule07VerifierContract(adaptedRoot, "checked-in workshop");
assertModule09OutcomeContract(rawRoot, "regenerated import");
assertModule09OutcomeContract(adaptedRoot, "checked-in workshop");

const raw = snapshot(rawRoot);
const adapted = snapshot(adaptedRoot);
const rawTree = digestTree(raw);
const adaptedTree = digestTree(adapted);
const overlay = digestOverlay(raw, adapted);

const actual = {
  rawTreeSha256: rawTree,
  adaptedTreeSha256: adaptedTree,
  overlaySha256: overlay.sha256,
  changedFiles: overlay.changedFiles,
};
const expected = {
  rawTreeSha256: EXPECTED_RAW_TREE_SHA256,
  adaptedTreeSha256: EXPECTED_ADAPTED_TREE_SHA256,
  overlaySha256: EXPECTED_OVERLAY_SHA256,
  changedFiles: EXPECTED_CHANGED_FILES,
};
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  process.stderr.write(
    `Platform Engineering Workshop import drifted from ${PINNED_REVISION}.\n` +
      `Expected: ${JSON.stringify(expected, null, 2)}\n` +
      `Actual:   ${JSON.stringify(actual, null, 2)}\n` +
      "Review the pinned import and every Intar adaptation before updating this lock.\n",
  );
  process.exit(1);
}

process.stdout.write(
  `Verified pinned import ${PINNED_REVISION}: ${raw.size} raw files, ` +
    `${adapted.size} adapted files, ${overlay.changedFiles} explicit adaptations\n`,
);

interface SnapshotEntry {
  executable: boolean;
  sha256: string;
}

function snapshot(root: string): Map<string, SnapshotEntry> {
  const rootMetadata = lstatSync(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error(`snapshot root must be a real directory: ${root}`);
  }
  const entries = new Map<string, SnapshotEntry>();
  visit(root);
  return entries;

  function visit(directory: string) {
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name);
      const metadata = lstatSync(absolute);
      const portable = relative(root, absolute).split(sep).join("/");
      if (metadata.isSymbolicLink()) {
        throw new Error(`import tree contains a symlink: ${portable}`);
      }
      if (metadata.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!metadata.isFile()) {
        throw new Error(`import tree contains a non-file entry: ${portable}`);
      }
      entries.set(portable, {
        executable: (metadata.mode & 0o111) !== 0,
        sha256: sha256(readFileSync(absolute)),
      });
    }
  }
}

function digestTree(entries: Map<string, SnapshotEntry>): string {
  const digest = createHash("sha256");
  for (const [path, entry] of [...entries].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    digest.update(path);
    digest.update("\0");
    digest.update(entry.executable ? "x" : "-");
    digest.update("\0");
    digest.update(entry.sha256);
    digest.update("\0");
  }
  return digest.digest("hex");
}

function digestOverlay(
  raw: Map<string, SnapshotEntry>,
  adapted: Map<string, SnapshotEntry>,
): { sha256: string; changedFiles: number } {
  const paths = [...new Set([...raw.keys(), ...adapted.keys()])].sort();
  const digest = createHash("sha256");
  let changedFiles = 0;
  for (const path of paths) {
    const before = raw.get(path);
    const after = adapted.get(path);
    if (
      before?.executable === after?.executable &&
      before?.sha256 === after?.sha256
    ) {
      continue;
    }
    changedFiles += 1;
    digest.update(path);
    digest.update("\0");
    digest.update(entryLock(before));
    digest.update("\0");
    digest.update(entryLock(after));
    digest.update("\0");
  }
  return { sha256: digest.digest("hex"), changedFiles };
}

function entryLock(entry: SnapshotEntry | undefined): string {
  if (!entry) return "missing";
  return `${entry.executable ? "x" : "-"}:${entry.sha256}`;
}

function assertNullSafeConditionWaitContract(root: string, label: string) {
  const readContract = (relativePath: string) =>
    readFileSync(join(root, relativePath), "utf8");
  const common = readContract("runtime/source/lab/common.sh");
  const commonContracts = [
    "wait_condition() {",
    "(.status.conditions? // [])[]?",
    "(((.items // []) | length) > 0)",
    "all((.items // [])[]; has_true_condition($condition))",
    '[ -n "$crd" ] && wait_condition "" "crd/$crd" Established 180',
  ];
  for (const contract of commonContracts) {
    if (!common.includes(contract)) {
      throw new Error(
        `${label} is missing null-safe condition contract: ${contract}`,
      );
    }
  }

  const expectedCalls = new Map<string, string[]>([
    [
      "scripts/catch-up-01.sh",
      [
        'source "$REPO_ROOT/lab/common.sh"',
        'wait_condition "" nodes Ready 300',
      ],
    ],
    [
      "scripts/catch-up-03.sh",
      [
        'wait_condition "" crd/clusters.postgresql.cnpg.io Established 180',
        "wait_condition demo cluster/app-db Ready 420",
      ],
    ],
    [
      "scripts/catch-up-04.sh",
      [
        'wait_condition "" xrd/workshopdatabases.platform.cloudbox.io Established 180',
        "wait_condition demo workshopdatabase/my-db Ready 600",
      ],
    ],
    [
      "scripts/catch-up-06.sh",
      ["wait_condition demo ksvc/hello Ready 300"],
    ],
    [
      "scripts/catch-up-08.sh",
      ["wait_condition demo workshopdatabase/console-db Ready 600"],
    ],
    [
      "scripts/catch-up-09.sh",
      [
        "wait_condition pipeline broker/default Ready 300",
        "wait_condition pipeline ksvc/uploader Ready 300",
        "wait_condition pipeline ksvc/resizer Ready 300",
        "wait_condition pipeline trigger/resize-on-upload Ready 300",
        "wait_condition pipeline job/create-images-bucket Complete 300",
      ],
    ],
  ]);
  const directConditionWait =
    /kubectl(?:\s+-n\s+\S+)?\s+wait\s+--for=condition=/u;
  for (
    const name of readdirSync(join(root, "scripts"))
      .filter((candidate) => /^catch-up-[0-9]{2}\.sh$/u.test(candidate))
      .sort()
  ) {
    if (directConditionWait.test(readContract(`scripts/${name}`))) {
      throw new Error(
        `${label} retains a direct kubectl condition wait in scripts/${name}`,
      );
    }
  }
  for (const [relativePath, calls] of expectedCalls) {
    const script = readContract(relativePath);
    for (const call of calls) {
      if (!script.includes(call)) {
        throw new Error(
          `${label} is missing ${call} in ${relativePath}`,
        );
      }
    }
  }

  const cnpgRestore = readContract(
    "runtime/source/lab/05-debug-with-ai/faults/02-db-stuck/fix.sh",
  );
  if (
    directConditionWait.test(cnpgRestore) ||
    !cnpgRestore.includes('source "$DIR/../../../common.sh"') ||
    !cnpgRestore.includes(
      "wait_condition faultlab-02 cluster/orders-db Ready 300",
    )
  ) {
    throw new Error(`${label} retains an unsafe CNPG fault restore wait`);
  }
}

function assertModule07VerifierContract(root: string, label: string) {
  const verifier = readFileSync(
    join(root, "runtime/source/lab/07-ci/verify.sh"),
    "utf8",
  );
  const wrapper = readFileSync(join(root, "scripts/verify-07.sh"), "utf8");
  for (const contract of [
    "ZOT_READY=0",
    "TEMPLATE_READY=0",
    "WORKFLOW_READY=0",
    "IMAGE_READY=0",
    "http://localhost:30500/v2/hello-site/tags/list",
    'any((.tags // [])[]?; . == "v1")',
    "--for=condition=Available deploy/hello-site --timeout=180s",
    '[[ "$BODY" == *"hello-site"* ]]',
  ]) {
    if (!verifier.includes(contract)) {
      throw new Error(
        `${label} is missing module 07 stabilization contract: ${contract}`,
      );
    }
  }
  for (const unstable of [
    "http://localhost:30500/v2/_catalog",
    "| grep -q '=Succeeded'",
    "| grep -q 'hello-site'",
    "--for=condition=Available deploy/hello-site --timeout=10s",
  ]) {
    if (verifier.includes(unstable)) {
      throw new Error(
        `${label} retains unstable module 07 verifier text: ${unstable}`,
      );
    }
  }
  for (const diagnostic of [
    "awk '/FAIL:/{ line=$0 } END{ print line }'",
    "INTAR_FAIL %.72s",
  ]) {
    if (!wrapper.includes(diagnostic)) {
      throw new Error(
        `${label} is missing bounded verifier diagnostics: ${diagnostic}`,
      );
    }
  }
}

function assertModule09OutcomeContract(root: string, label: string) {
  const catchUp = readFileSync(
    join(root, "scripts/catch-up-09.sh"),
    "utf8",
  );
  const verifier = readFileSync(
    join(root, "scripts/verify-09.sh"),
    "utf8",
  );
  for (const contract of [
    "module09_trace_ready=0",
    "module09_gallery_ready=0",
    "module09_deadline=$((SECONDS + 60))",
    "for module09_attempt in $(seq 1 12)",
    "module 09 connected upload trace did not converge within 60s",
    "Cloudbox gallery did not converge on a non-empty canonical /__intar-s3/ object within 60s",
    "https://wa-workshop-probe\\.intar\\.app/__intar-s3/",
    'module09_gallery_path="${module09_gallery_url#https://wa-workshop-probe.intar.app}"',
    "module09_gallery_hard_failure=1",
  ]) {
    if (!verifier.includes(contract)) {
      throw new Error(
        `${label} is missing module 09 convergence contract: ${contract}`,
      );
    }
  }
  for (const contract of [
    "trap 'rm -f \"$TMP_PNG\"' EXIT",
    "module09_attempt % 6 == 0",
    "module09_deadline=$((SECONDS + 300))",
    "module 09 connected upload trace did not converge within 300s",
    "Cloudbox gallery did not converge on a non-empty canonical /__intar-s3/ object within 300s",
    "http://localhost:30600/gallery/upload 2>/dev/null || true",
    "trap - EXIT",
  ]) {
    if (!catchUp.includes(contract)) {
      throw new Error(
        `${label} is missing trusted module 09 convergence behavior: ${contract}`,
      );
    }
  }
  for (const unsafe of [
    "Nothing here yet",
    "contained objects without a canonical",
  ]) {
    if (verifier.includes(unsafe)) {
      throw new Error(
        `${label} retains unsafe module 09 verifier behavior: ${unsafe}`,
      );
    }
  }
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
