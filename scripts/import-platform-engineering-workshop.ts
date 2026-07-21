#!/usr/bin/env bun

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

const PINNED_REVISION = "1b6fad43551a720b143d7a52799f81c4c89455cb";
const PINNED_MODULE_07_BUSYBOX_SOURCE =
  "docker.io/library/busybox:1.37.0";
const sourceRoot = resolve(process.argv[2] ?? "");
const outputRoot = resolve("workshops/platform-engineering");

if (!process.argv[2]) {
  throw new Error(
    "usage: bun scripts/import-platform-engineering-workshop.ts /path/to/pinned/source",
  );
}
if (existsSync(outputRoot)) {
  throw new Error(
    `${outputRoot} already exists; move it aside before regenerating the pinned import`,
  );
}

const revision = Bun.spawnSync([
  "git",
  "-C",
  sourceRoot,
  "rev-parse",
  "HEAD",
]).stdout
  .toString()
  .trim();
if (revision !== PINNED_REVISION) {
  throw new Error(
    `source checkout is ${revision || "unknown"}; expected ${PINNED_REVISION}`,
  );
}
const sourceStatus = Bun.spawnSync([
  "git",
  "-C",
  sourceRoot,
  "status",
  "--porcelain=v1",
  "--untracked-files=all",
]).stdout
  .toString()
  .trim();
if (sourceStatus) {
  throw new Error(
    "pinned source checkout has local changes; import from a clean checkout so offline adaptations cannot silently drift",
  );
}
const module07Post = readFileSync(
  join(sourceRoot, "solutions/module-07/post.sh"),
  "utf8",
);
const busyboxSourceOccurrences = module07Post.split(
  PINNED_MODULE_07_BUSYBOX_SOURCE,
).length - 1;
if (busyboxSourceOccurrences !== 1) {
  throw new Error(
    "pinned module-07 post-step no longer has exactly one expected external BusyBox source; review the offline Intar adaptation before importing",
  );
}

const pageOrder = [
  "why",
  "what",
  "stack",
  "how",
  "module-00",
  "module-01",
  "module-02",
  "module-03",
  "module-04",
  "module-05",
  "module-06",
  "module-07",
  "module-08",
  "module-09",
  "module-10",
  "principles",
  "closing",
] as const;

type NativeLayout =
  | "cover"
  | "default"
  | "section"
  | "statement"
  | "break"
  | "closing";

interface ImportedSlide {
  id: string;
  source: string;
  content: string;
  notes: string;
  layout: NativeLayout;
}

interface ModuleDefinition {
  id: string;
  directory: string;
  tier: "gate" | "core" | "stretch";
  outcome: string;
  dependencies: string[];
  probe: string;
}

const modules: ModuleDefinition[] = [
  {
    id: "00",
    directory: "00-setup",
    tier: "gate",
    outcome:
      "Prove the pinned toolchain, offline image cache, and learner workspace are ready.",
    dependencies: [],
    probe: "module-00-workspace-ready",
  },
  {
    id: "01",
    directory: "01-cluster",
    tier: "core",
    outcome:
      "Run a two-node Talos Kubernetes cluster with Cilium eBPF networking and no kube-proxy.",
    dependencies: ["00"],
    probe: "module-01-talos-cilium-ready",
  },
  {
    id: "02",
    directory: "02-gitops",
    tier: "core",
    outcome:
      "Push a commit to the in-cluster Gitea server and watch Argo CD reconcile it.",
    dependencies: ["01"],
    probe: "module-02-gitops-reconciled",
  },
  {
    id: "03",
    directory: "03-data",
    tier: "core",
    outcome:
      "Provision PostgreSQL and S3-compatible object storage as platform services.",
    dependencies: ["02"],
    probe: "module-03-data-services-ready",
  },
  {
    id: "04",
    directory: "04-self-service",
    tier: "core",
    outcome:
      "Turn one Crossplane claim into a database and bucket through a self-service API.",
    dependencies: ["03"],
    probe: "module-04-crossplane-composed",
  },
  {
    id: "05",
    directory: "05-debug-with-ai",
    tier: "core",
    outcome:
      "Diagnose a seeded fault and prove the repair against live cluster state.",
    dependencies: ["04"],
    probe: "module-05-debugging-verified",
  },
  {
    id: "06",
    directory: "06-serverless",
    tier: "stretch",
    outcome:
      "Cold-start a Knative service from zero and observe it scale back to zero.",
    dependencies: ["05"],
    probe: "module-06-knative-scale-to-zero",
  },
  {
    id: "07",
    directory: "07-ci",
    tier: "stretch",
    outcome:
      "Build an image inside the cluster with Argo Workflows and BuildKit, push it to Zot, and run it.",
    dependencies: ["05"],
    probe: "module-07-in-cluster-build-published",
  },
  {
    id: "08",
    directory: "08-portal",
    tier: "stretch",
    outcome:
      "Create a database through the readable Cloudbox Console developer portal.",
    dependencies: ["05"],
    probe: "module-08-cloudbox-console-ready",
  },
  {
    id: "09",
    directory: "09-capstone",
    tier: "stretch",
    outcome:
      "Upload a picture and trace its event-driven resize, metadata, and storage pipeline end to end.",
    dependencies: ["06", "08"],
    probe: "module-09-picture-pipeline-complete",
  },
  {
    id: "10",
    directory: "10-day2-ops",
    tier: "stretch",
    outcome:
      "Recover a broken release with a durable Git revert and verify stable day-two operation.",
    dependencies: ["02"],
    probe: "module-10-day-two-recovery-stable",
  },
];

const moduleHintPaths = new Map<string, string[]>();
const moduleExplainBacks = new Map<string, string>();
const bundledAssets = new Set<string>();
const bundledAssetSources = new Map<string, string>();

mkdirSync(outputRoot, { recursive: true });
for (const directory of [
  "assets/console",
  "assets/modules",
  "content",
  "facilitator",
  "hints",
  "scripts",
  "slides",
  "slides/notes",
]) {
  mkdirSync(join(outputRoot, directory), { recursive: true });
}

const slides = importSlides();
if (slides.length !== 85) {
  throw new Error(`pinned deck produced ${slides.length} slides; expected 85`);
}

for (const slide of slides) {
  writeText(`slides/${slide.id}.md`, slide.content);
  writeText(`slides/notes/${slide.id}.md`, slide.notes);
}

for (const name of [
  "applications-dark.png",
  "buckets-dark.png",
  "builds-dark.png",
  "components-dark.png",
  "database-dark.png",
  "mobile-nav.png",
  "monitoring-dark.png",
  "services-dark.png",
  "streams-dark.png",
]) {
  copyFileSync(
    join(sourceRoot, "slides", "public", "console", name),
    join(outputRoot, "assets", "console", name),
  );
  bundledAssets.add(`assets/console/${name}`);
}
copyFileSync(join(sourceRoot, "LICENSE"), join(outputRoot, "LICENSE"));

for (const module of modules) {
  importModule(module, slides);
}

writeText("SOURCE.md", sourceNotice());
writeText("workshop.hcl", renderManifest(slides));

process.stdout.write(
  `Imported ${slides.length} slides and ${modules.length} modules from ${PINNED_REVISION}\n`,
);

function importSlides(): ImportedSlide[] {
  const imported: Omit<ImportedSlide, "id">[] = [];
  const rootParts = read("slides/slides.md").split(/^---\s*$/m);
  const cover = rootParts[2];
  if (!cover) throw new Error("the pinned deck cover could not be found");
  imported.push(buildSlide("cover", cover, "cover"));

  for (const page of pageOrder) {
    imported.push(...parseSlidevPage(page, read(`slides/pages/${page}.md`)));
  }

  return imported.map((slide, index) => ({
    ...slide,
    id: `slide-${String(index + 1).padStart(3, "0")}`,
  }));
}

function parseSlidevPage(
  source: string,
  raw: string,
): Omit<ImportedSlide, "id">[] {
  const result: Omit<ImportedSlide, "id">[] = [];
  let layout: NativeLayout = "default";
  for (const rawPart of raw.split(/^---\s*$/m)) {
    const part = rawPart.trim();
    if (!part) continue;
    if (isSlideFrontmatter(part)) {
      layout = mapLayout(part.match(/^layout:\s*([^\s]+)\s*$/m)?.[1]);
      continue;
    }
    result.push(buildSlide(source, part, layout));
    layout = "default";
  }
  return result;
}

function isSlideFrontmatter(value: string): boolean {
  if (/^src:\s*/m.test(value)) return true;
  if (!/^(layout|class|transition|clicks):/m.test(value)) return false;
  return value
    .split("\n")
    .filter((line) => line.trim())
    .every((line) => /^[a-zA-Z][\w-]*\s*:/.test(line));
}

function mapLayout(layout: string | undefined): NativeLayout {
  switch (layout) {
    case "cover":
      return "cover";
    case "section":
      return "section";
    case "fact":
    case "center":
      return "statement";
    default:
      return "default";
  }
}

function buildSlide(
  source: string,
  raw: string,
  requestedLayout: NativeLayout,
): Omit<ImportedSlide, "id"> {
  const noteBlocks = [...raw.matchAll(/<!--([\s\S]*?)-->/g)].map(
    (match) => match[1] ?? "",
  );
  const body = sanitizeMarkdown(raw.replace(/<!--[\s\S]*?-->/g, ""));
  const notes = sanitizeMarkdown(noteBlocks.join("\n\n"));
  const title = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  let layout = requestedLayout;
  if (title?.replace(/[*_]/g, "").toLowerCase() === "break") layout = "break";
  if (source === "closing" && /thank you/i.test(title ?? "")) layout = "closing";
  return {
    source,
    content: body || "_Visual interlude from the source presentation._\n",
    notes: notes || "_No presenter notes were attached to this source slide._\n",
    layout,
  };
}

function sanitizeMarkdown(value: string): string {
  return value
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .replace(
      /<img\s+[^>]*src=["']([^"']+)["'][^>]*alt=["']([^"']*)["'][^>]*\/?\s*>/gi,
      (_match, source: string, alt: string) =>
        `![${alt}](${normalizeImageSource(source)})`,
    )
    .replace(
      /<Logo\s+([^>]+)\/?\s*>/gi,
      (_match, attributes: string) => {
        const label =
          attributes.match(/label=["']([^"']+)["']/i)?.[1] ??
          attributes.match(/text=["']([^"']+)["']/i)?.[1] ??
          attributes.match(/name=["']([^"']+)["']/i)?.[1] ??
          "platform component";
        return `**${label}**`;
      },
    )
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<strong>/gi, "**")
    .replace(/<\/strong>/gi, "**")
    .replace(/<b>/gi, "**")
    .replace(/<\/b>/gi, "**")
    .replace(/<em>/gi, "*")
    .replace(/<\/em>/gi, "*")
    .replace(/<code>/gi, "`")
    .replace(/<\/code>/gi, "`")
    .replace(/::right::/g, "\n")
    .replace(/```mermaid\s*\{[^}]*\}/g, "```mermaid")
    .replace(/mise x crane@0\.21\.7 -- crane/g, "MISE_OFFLINE=1 crane")
    .replace(/<\/?[A-Za-z!?][^>\n]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&rarr;/g, "→")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .concat("\n");
}

function normalizeImageSource(source: string): string {
  if (source.startsWith("/console/")) {
    return `../assets/console/${basename(source)}`;
  }
  return source;
}

function importModule(module: ModuleDefinition, allSlides: ImportedSlide[]) {
  const readme = read(`lab/${module.directory}/README.md`);
  const details = extractDetails(readme);
  const sourceDirectory = join(sourceRoot, "lab", module.directory);
  const content = bundleModuleImages(
    sanitizeMarkdown(
      readme.replace(/<details[^>]*>[\s\S]*?<\/details>/gi, ""),
    ),
    module,
    sourceDirectory,
  );
  writeText(
    `content/module-${module.id}.md`,
    `${content}\n> Run the pinned manual verifier at \`/opt/platform-engineering-workshop/lab/${module.directory}/verify.sh\`. Layered hints and the solution are released separately by Intar.\n`,
  );

  const hintBodies = details.length
    ? details
    : [
        {
          title: "Where to start",
          body: "Re-read the outcome, then run the manual verifier and investigate its first failing check.",
        },
      ];
  const hintPaths: string[] = [];
  hintBodies.forEach((hint, index) => {
    const relative = `hints/module-${module.id}-${String(index + 1).padStart(2, "0")}.md`;
    hintPaths.push(relative);
    writeText(
      relative,
      `# ${hint.title}\n\n${bundleModuleImages(
        sanitizeMarkdown(hint.body),
        module,
        sourceDirectory,
      )}`,
    );
  });

  const solve = read(`lab/${module.directory}/solve.sh`)
    .replaceAll("mise x crane@0.21.7 -- crane", "MISE_OFFLINE=1 crane")
    .replaceAll("<", "&lt;");
  writeText(
    `content/module-${module.id}-solution.md`,
    `# Canonical solution for module ${module.id}\n\nThis is adapted verbatim from the pinned upstream \`solve.sh\`. Reveal it only after the learner has chosen to see the solution.\n\n\`\`\`bash\n${solve.trim()}\n\`\`\`\n`,
  );

  const moduleNotes = allSlides
    .filter((slide) => slide.source === `module-${module.id}`)
    .map((slide) => slide.notes)
    .join("\n\n---\n\n");
  writeText(
    `facilitator/module-${module.id}.md`,
    `# Facilitator notes — module ${module.id}\n\n${moduleNotes || "Use the outcome and verifier as the facilitation contract."}\n`,
  );

  writeExecutable(
    `scripts/verify-${module.id}.sh`,
    renderVerifyScript(module),
  );
  writeExecutable(
    `scripts/catch-up-${module.id}.sh`,
    renderCatchUpScript(module.id),
  );

  moduleHintPaths.set(module.id, hintPaths);
  moduleExplainBacks.set(module.id, extractExplainBack(readme));
}

function renderVerifyScript(module: ModuleDefinition): string {
  const module00Prelude = module.id === "00"
    ? "export MISE_OFFLINE=1\nreadonly expected_crane_version=0.21.7\n"
    : "";
  const module00Check = module.id === "00"
    ? `if (( status == 0 )); then
  crane_version="$(crane version 2>&1 || true)"
  if [[ "\${crane_version}" != *"\${expected_crane_version}"* ]]; then
    printf 'expected preinstalled crane %s, got: %s\\n' "\${expected_crane_version}" "\${crane_version}" >&2
    status=1
  fi
fi
`
    : "";
  return `#!/usr/bin/env bash
set -uo pipefail
${module00Prelude}verifier=/opt/platform-engineering-workshop/lab/${module.directory}/verify.sh
set +e
output="$(${"${verifier}"} 2>&1)"
status=$?
set -e
printf '%s\\n' "${"${output}"}"
${module00Check}if (( status == 0 )); then
  printf 'INTAR_PROBE ${module.probe} pass\\n'
else
  printf 'INTAR_PROBE ${module.probe} fail\\n'
fi
exit "${"${status}"}"
`;
}

function renderCatchUpScript(moduleId: string): string {
  if (moduleId === "00") {
    return `#!/usr/bin/env bash
set -euo pipefail

# Upstream's generic catch-up starts at module 02 because it reconciles
# cumulative GitOps application state. Module 00 is instead the immutable
# image preflight: the dedicated Intar base already contains the pinned tools,
# participant repository, local registry, and offline image cache.
readonly workshop_root=/opt/platform-engineering-workshop
cd "\${workshop_root}"
export MISE_OFFLINE=1

# Do not install or pull during publication. A missing prerequisite means the
# dedicated base image is invalid and must fail atomically before checkpoint 00
# can be published.
./scripts/install.sh --check
readonly expected_crane_version=0.21.7
readonly crane_version="$(crane version 2>&1 || true)"
[[ "\${crane_version}" == *"\${expected_crane_version}"* ]] || {
  printf 'expected preinstalled crane %s, got: %s\\n' "\${expected_crane_version}" "\${crane_version}" >&2
  exit 1
}
`;
  }
  if (moduleId === "01") {
    return `#!/usr/bin/env bash
set -euo pipefail

# Upstream's generic catch-up requires solutions/module-NN/apps and therefore
# intentionally cannot represent module 01. The pinned module-01 solve
# contract is to create the Talos-in-Docker cluster, then wait for both nodes.
readonly workshop_root=/opt/platform-engineering-workshop
cd "\${workshop_root}"

# create-cluster.sh rejects an existing cluster. Keep canonical publication
# idempotent for a healthy resumed build without destroying state in place.
if [[ -n "$(docker ps -aq --filter 'label=talos.cluster.name=cloudbox' 2>/dev/null)" ]]; then
  echo "cloudbox cluster already exists; checking readiness"
else
  ./scripts/create-cluster.sh
fi

exec kubectl wait --for=condition=Ready nodes --all --timeout=300s
`;
  }
  if (moduleId === "07") {
    return `#!/usr/bin/env bash
set -euo pipefail

readonly workshop_root=/opt/platform-engineering-workshop
readonly generic_catch_up="\${workshop_root}/scripts/catch-up.sh"
readonly upstream_post="\${workshop_root}/solutions/module-07/post.sh"
cd "\${workshop_root}"
export MISE_OFFLINE=1

# The pinned upstream post-step copies BusyBox from an external registry. The
# Intar publication contract is fully offline, so let the generic helper apply
# the cumulative GitOps state while temporarily suppressing that post-step.
[[ -x "\${generic_catch_up}" ]] || { echo "missing generic catch-up helper" >&2; exit 1; }
[[ -x "\${upstream_post}" ]] || { echo "missing module-07 post-step" >&2; exit 1; }
readonly upstream_post_mode="$(stat -c '%a' "\${upstream_post}")"
restore_upstream_post() {
  chmod "\${upstream_post_mode}" "\${upstream_post}"
}
trap restore_upstream_post EXIT
chmod a-x "\${upstream_post}"
"\${generic_catch_up}" 07
restore_upstream_post
trap - EXIT

# Preserve the pinned imperative contract, but seed Zot exclusively from the
# guest-local registry populated in checkpoint 00. Missing cache content is a
# publication failure; the builder must never fall back to conference Wi-Fi.
"\${workshop_root}/solutions/module-03/post.sh"
if curl -fsS --max-time 5 http://localhost:30500/v2/_catalog 2>/dev/null | grep -q hello-site; then
  echo "hello-site already in Zot; skipping build"
  exit 0
fi
crane manifest --insecure \\
  localhost:5001/library/busybox:1.37.0 >/dev/null
crane copy --insecure \\
  localhost:5001/library/busybox:1.37.0 localhost:30500/library/busybox:1.37.0

workflow_name="$(kubectl create -f "\${workshop_root}/lab/07-ci/workflow-run.yaml" -o jsonpath='{.metadata.name}')"
echo "submitted build workflow: \${workflow_name}"
waited=0
while true; do
  phase="$(kubectl -n builds get workflow "\${workflow_name}" -o jsonpath='{.status.phase}' 2>/dev/null || true)"
  case "\${phase}" in
    Succeeded)
      echo "build succeeded"
      break
      ;;
    Failed|Error)
      echo "build workflow \${phase}" >&2
      exit 1
      ;;
  esac
  if (( waited >= 900 )); then
    echo "build timed out" >&2
    exit 1
  fi
  sleep 15
  waited=$((waited + 15))
done

kubectl -n demo delete pods -l app=hello-site --ignore-not-found
kubectl -n demo rollout status deploy/hello-site --timeout=300s || true
`;
  }
  return `#!/usr/bin/env bash
set -euo pipefail
exec /opt/platform-engineering-workshop/scripts/catch-up.sh ${moduleId}
`;
}

function extractDetails(raw: string): Array<{ title: string; body: string }> {
  return [...raw.matchAll(/<details[^>]*>\s*<summary[^>]*>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi)].map(
    (match) => ({
      title: sanitizeMarkdown(match[1] ?? "Hint").trim(),
      body: match[2] ?? "",
    }),
  );
}

function extractExplainBack(raw: string): string {
  const section = raw.match(/## Explain-back\s+([\s\S]*?)(?=\n## |$)/i)?.[1] ??
    "Explain the evidence that proves this module's outcome.";
  const prompt = sanitizeMarkdown(section)
    .replace(/^\*\*Prompt:?\*\*\s*/i, "")
    .split("\n\n")[0]
    ?.trim();
  return prompt || "Explain the evidence that proves this module's outcome.";
}

function bundleModuleImages(
  markdown: string,
  module: ModuleDefinition,
  sourceDirectory: string,
): string {
  return markdown.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(\s+["'][^"']*["'])?\)/g,
    (original, alt: string, reference: string, title: string | undefined) => {
      if (
        reference.startsWith("data:") ||
        reference.startsWith("http://") ||
        reference.startsWith("https://") ||
        reference.startsWith("/") ||
        reference.startsWith("#")
      ) {
        throw new Error(
          `module ${module.id} contains an image that cannot be bundled: ${reference}`,
        );
      }

      const source = resolve(sourceDirectory, reference);
      const sourceRelative = relative(sourceRoot, source);
      if (
        sourceRelative === "" ||
        sourceRelative.startsWith(`..${sep}`) ||
        sourceRelative === ".." ||
        isAbsolute(sourceRelative) ||
        !existsSync(source)
      ) {
        throw new Error(
          `module ${module.id} image escapes or is missing from the pinned source: ${reference}`,
        );
      }

      const assetPath = `assets/modules/${module.id}/${basename(source)}`;
      const previousSource = bundledAssetSources.get(assetPath);
      if (previousSource && previousSource !== source) {
        throw new Error(
          `module ${module.id} maps multiple images to ${assetPath}; rename the source assets`,
        );
      }
      if (!previousSource) {
        const target = join(outputRoot, assetPath);
        mkdirSync(resolve(target, ".."), { recursive: true });
        copyFileSync(source, target);
        bundledAssetSources.set(assetPath, source);
        bundledAssets.add(assetPath);
      }
      return `![${alt}](../${assetPath}${title ?? ""})`;
    },
  );
}

function renderManifest(allSlides: ImportedSlide[]): string {
  const applications = [
    ["gitea", "Gitea", 30300, "02"],
    ["argocd", "Argo CD", 30080, "02"],
    ["rustfs", "RustFS", 30901, "03"],
    ["knative", "Knative", 31081, "06"],
    ["zot", "Zot Registry", 30500, "07"],
    ["cloudbox", "Cloudbox Console", 30600, "08"],
    ["grafana", "Grafana", 30030, "09"],
  ] as const;
  const assets = [...bundledAssets].sort();

  const slideIds = (source: string) =>
    allSlides.filter((slide) => slide.source === source).map((slide) => slide.id);
  const withoutBreak = (source: string) =>
    allSlides
      .filter((slide) => slide.source === source && slide.layout !== "break")
      .map((slide) => slide.id);
  const breakSlide = (source: string) =>
    allSlides.find((slide) => slide.source === source && slide.layout === "break")
      ?.id;

  const openingSlides = [
    ...slideIds("cover"),
    ...slideIds("why"),
    ...slideIds("what"),
    ...slideIds("stack"),
    ...slideIds("how"),
  ];
  const closingSlides = [...slideIds("principles"), ...slideIds("closing")];
  const breakOne = breakSlide("module-03");
  const breakTwo = breakSlide("module-05");
  if (!breakOne || !breakTwo) throw new Error("source break slides were not found");

  let result = `workshop "platform-engineering-workshop" {
  format_version = 1
  title          = "Cloud on Your Terms — Platform Engineering Workshop"
  summary        = "Build and operate a sovereign cloud-native platform in one persistent Intar workspace."
  prerequisites  = ["Comfort with a terminal", "Basic Kubernetes concepts"]
  attribution    = "Adapted from randax/Platform-Engineering-Workshop at ${PINNED_REVISION}, Apache-2.0: https://github.com/randax/Platform-Engineering-Workshop/tree/${PINNED_REVISION}"
  default_lobby_minutes = 30
}

workspace {
  lease_grace_minutes = 60
  initial_checkpoint  = "checkpoint-00"

  vm "workspace" {
    image        = "platform-engineering-workshop-debian13-1b6fad4"
    vcpu_millis = 4000
    memory_mib   = 16384
    disk_gib     = 100
  }

`;
  for (const [id, label, port, releaseModule] of applications) {
    result += `  application ${quote(id)} {
    label          = ${quote(label)}
    vm             = "workspace"
    port           = ${port}
    protocol       = "http"
    release_module = ${quote(releaseModule)}
  }

`;
  }
  result += `}

`;

  for (const module of modules) {
    result += `module ${quote(module.id)} {
  tier              = ${quote(module.tier)}
  outcome           = ${quote(module.outcome)}
  depends_on        = ${array(module.dependencies)}
  content           = "content/module-${module.id}.md"
  facilitator_notes = "facilitator/module-${module.id}.md"
  hints             = ${array(moduleHintPaths.get(module.id) ?? [])}
  solution          = "content/module-${module.id}-solution.md"
  explain_back      = ${quote(moduleExplainBacks.get(module.id) ?? "Explain the outcome.")}
  verify_script     = "scripts/verify-${module.id}.sh"
  catch_up_script   = "scripts/catch-up-${module.id}.sh"
  checkpoint        = "checkpoint-${module.id}"
  probes            = [${quote(module.probe)}]
}

`;
  }

  result += agenda(
    "preflight",
    "lab",
    30,
    slideIds("module-00"),
    "00",
    "automatic",
    false,
  );
  result += agenda("opening", "briefing", 15, openingSlides);
  for (const id of ["01", "02"] as const) {
    result += agenda(
      `module-${id}`,
      "lab",
      35,
      slideIds(`module-${id}`),
      id,
    );
  }
  result += agenda("module-03", "lab", 35, withoutBreak("module-03"), "03");
  result += agenda("break-1", "break", 10, [breakOne]);
  result += agenda("module-04", "lab", 35, slideIds("module-04"), "04");
  result += agenda("module-05", "lab", 25, withoutBreak("module-05"), "05");
  result += agenda("break-2", "break", 10, [breakTwo]);
  for (const id of ["06", "07", "08", "09", "10"] as const) {
    result += agenda(
      `module-${id}-pool`,
      "lab",
      0,
      slideIds(`module-${id}`),
      id,
      "pool",
      false,
    );
  }
  result += agenda(
    "stretch-tinker",
    "tinker",
    30,
    ["06", "07", "08", "09", "10"].flatMap((id) =>
      slideIds(`module-${id}`),
    ),
  );
  result += agenda("closing", "retro", 10, closingSlides);

  result += `presentation {
  assets = ${array(assets)}

`;
  for (const slide of allSlides) {
    result += `  slide ${quote(slide.id)} {
    content         = "slides/${slide.id}.md"
    presenter_notes = "slides/notes/${slide.id}.md"
    layout          = ${quote(slide.layout)}
  }

`;
  }
  result += `}
`;
  return result;
}

function agenda(
  id: string,
  kind: string,
  duration: number,
  slideIds: string[],
  module?: string,
  release = "facilitator",
  scheduled = true,
): string {
  return `agenda ${quote(id)} {
  kind             = ${quote(kind)}
  duration_minutes = ${duration}
  scheduled        = ${scheduled}
${module ? `  module           = ${quote(module)}\n` : ""}  slides           = ${array(slideIds)}
  release          = ${quote(release)}
}

`;
}

function sourceNotice(): string {
  return `# Source and image contract

This workshop is a native Intar port of
https://github.com/randax/Platform-Engineering-Workshop pinned at
\`${PINNED_REVISION}\`. The upstream work is Apache-2.0 licensed; the complete
license text is retained in \`LICENSE\` and is included in the deterministic
bundle.

The dedicated Debian 13 guest image must contain the pinned repository at
\`/opt/platform-engineering-workshop\`, the pinned toolchain, and all
non-optional container images. It must also provide loopback browser adapters
for the RustFS console on port 30901 and the workshop's fixed Knative service on
port 31081. These adapters do not publish host ports; Stargate reaches them via
SSH direct forwarding.

The source importer intentionally converts Slidev HTML/Vue presentation syntax
to Intar's finite native Markdown layouts and separates every HTML speaker-note
comment into its corresponding presenter-notes file. The generated deck must
remain exactly 85 slides. CI regenerates the raw import from the pinned commit
and locks both trees plus their explicit Intar-adaptation delta; an intentional
source or adaptation change must update that reviewed lock.
`;
}

function read(relative: string): string {
  return readFileSync(join(sourceRoot, relative), "utf8");
}

function writeText(relative: string, content: string) {
  const target = join(outputRoot, relative);
  mkdirSync(resolve(target, ".."), { recursive: true });
  writeFileSync(target, `${content.replace(/(?:\r?\n)+$/u, "")}\n`);
}

function writeExecutable(relative: string, content: string) {
  writeText(relative, content);
  chmodSync(join(outputRoot, relative), 0o755);
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function array(values: readonly string[]): string {
  return `[${values.map(quote).join(", ")}]`;
}
