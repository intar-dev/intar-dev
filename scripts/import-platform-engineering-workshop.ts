#!/usr/bin/env bun

import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const PINNED_REVISION = "1b6fad43551a720b143d7a52799f81c4c89455cb";
const OMITTED_RUNTIME_IMAGES = new Set([
  "docker.io/kindest/node:v1.36.1@sha256:3489c7674813ba5d8b1a9977baea8a6e553784dab7b84759d1014dbd78f7ebd5",
  "docker.io/library/registry:3.1.1",
]);
const ADDITIONAL_RUNTIME_IMAGE_SOURCES = new Set([
  "ghcr.io/crossplane-contrib/function-patch-and-transform:v0.10.7",
  "public.ecr.aws/docker/library/golang:1.25-alpine",
]);
const sourceRoot = resolve(process.argv[2] ?? "");
const outputRoot = resolve(process.argv[3] ?? "workshops/platform-engineering");

if (!process.argv[2]) {
  throw new Error(
    "usage: bun scripts/import-platform-engineering-workshop.ts /path/to/pinned/source [output]",
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
    "pinned source checkout has local changes; import from a clean checkout so direct-cloud adaptations cannot silently drift",
  );
}
const imageMappings = loadImageMappings();
const upstreamExternalImages = resolveUpstreamImageInventory();

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
      "Prove the Debian 13 workspace, pinned toolchain, outbound registry path, and digest-pinned image contract are ready.",
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
  "runtime/source",
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

writeRuntimeSource();

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
  return replaceRuntimeImageReferences(adaptExternalRuntimeNarrative(value
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
    .replace(/mise x crane@0\.21\.7 -- crane/g, "crane")
    .replace(/<\/?[A-Za-z!?][^>\n]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&rarr;/g, "→")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .concat("\n")));
}

function adaptExternalRuntimeNarrative(value: string): string {
  return value
    .replace(
      /\.\/scripts\/dev-setup\.sh[\s\S]*?\.\/scripts\/install\.sh --check/gu,
      "the Intar checkpoint bootstrap installs the pinned tools and validates every external image manifest",
    )
    .replace(
      /cloudbox-init\.sh pre-pulled all pinned images into a local registry mirror/gi,
      "the Intar checkpoint bootstrap validates every pinned image against its external registry",
    )
    .replace(
      /cloudbox-init(?:\.sh)?\s*(?:→|->)\s*local mirror/gi,
      "signed checkpoint bundle + external digest pulls",
    )
    .replace(/local registry mirror/gi, "reviewed external registry set")
    .replace(/local mirror/gi, "external registry")
    .replace(/cloudbox-mirror/gi, "external registry preflight")
    .replace(/(?:\.\/scripts\/)?cloudbox-init(?:\.sh)?(?:\s+--[^\s`]+)*/gi, "the Intar checkpoint bootstrap")
    .replace(/\.\/scripts\/install\.sh --check/g, "cd lab/00-setup && ./verify.sh")
    .replace(
      /curl -s http:\/\/localhost:5001\/v2\/_catalog(?:\s*\|\s*jq(?:\s+\.)?)?/g,
      "sed '/^#/d;/^$/d' scripts/images.lock",
    )
    .replace(/pre-?pulled\s*(?:&|and)\s*offline/gi, "digest-pinned external pulls")
    .replace(/offline image cache/gi, "digest-pinned external image inventory")
    .replace(/local image cache/gi, "digest-pinned external image inventory")
    .replace(/fully offline/gi, "dependent on digest-pinned external pulls")
    .replace(/runs? offline/gi, "uses controlled registry egress")
    .replace(/stays? offline/gi, "stays digest-pinned")
    .replace(/\boffline\b/gi, "digest-pinned")
    .replace(/never touches the internet/gi, "uses only declared external registries")
    .replace(/no internet needed/gi, "external image egress is required")
    .replace(
      /a floating tag silently defeats a pre-pulled cache/gi,
      "a floating tag defeats reproducible external pulls",
    )
    .replace(
      /pre-pulled\s*&amp;\s*digest-pinned/gi,
      "Externally pulled &amp; digest-pinned",
    )
    .replace(
      /nothing is fetched at the venue — no CDN, no Grafana plugin download, no Docker Hub live pull\./gi,
      "Learner servers pull only declared manifests by digest over Hetzner egress; no OCI layer ships inside the checkpoint bundle.",
    )
    .replace(
      /every image pre-pulled, every version pinned/gi,
      "Every image externally pulled by digest",
    )
    .replace(
      /nothing downloads at runtime — by design/gi,
      "Learner VMs pull through controlled registry egress",
    );
}

function moduleContent(module: ModuleDefinition, readme: string): string {
  if (module.id === "00") return renderModule00Content();
  const content = sanitizeMarkdown(
    readme.replace(/<details[^>]*>[\s\S]*?<\/details>/gi, ""),
  );
  if (module.id !== "10") return content;
  return content
    .replace(
      /## Escalate to the agent:[^\n]*/u,
      "## Optional agent-assisted investigation on the CX43 path",
    )
    .replace(
      /### Enable Kagent and point it at your platform[\s\S]*?(?=### Beat 2:)/u,
      `### Use the hosted-model path

CX43 has 16 GiB RAM, so Intar intentionally omits the source workshop's
host-side Ollama beat. Enable Kagent through the GitOps catalog as described,
then replace its default ModelConfig with the hosted provider configuration in
Beat 2 before opening an investigation. The human-only fault diagnosis and
verification path above remains complete and needs no model or API key.

`,
    );
}

function renderModule00Content(): string {
  return `# Module 00 — Workspace and registry pre-flight

## The goal

Prove that this learner's Debian 13 server has the pinned toolchain, a usable
Docker daemon, enough CPU and memory, and an HTTPS path to every declared
external registry. Intar performs the slow installation and manifest checks
while applying checkpoint 00; no laptop setup or local image mirror is used.

## The task

From \`/opt/platform-engineering-workshop\`:

\`\`\`bash
cd lab/00-setup
./verify.sh
\`\`\`

If it fails, keep the complete output and request help. A missing tool, an
unreachable registry, or an undersized Docker runtime is a provisioning
failure—not something the learner should repair by installing unpinned
software. The facilitator can recreate the workspace from checkpoint 00.

## Check your work

The verifier checks Debian 13 on x86-64, Docker, at least four CPUs and 15 GiB
of usable memory, the pinned CLI set, the signed source installation, and the
registry-preflight marker written only after every digest in
\`scripts/images.lock\` was resolved over HTTPS.

## Explain-back

Tell your neighbor why a content-addressed image reference prevents tag drift,
and why it still does not remove the workshop's dependency on working DNS,
TLS, registry availability, and provider rate limits.
`;
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
    moduleContent(module, readme),
    module,
    sourceDirectory,
  );
  writeText(
    `content/module-${module.id}.md`,
    `${content}\n> Run the pinned manual verifier at \`/opt/platform-engineering-workshop/lab/${module.directory}/verify.sh\`. Layered hints and the solution are released separately by Intar.\n`,
  );

  const hintBodies = module.id === "00"
    ? [
        {
          title: "Registry or tool preflight failed",
          body: "Copy the full verifier output into the help request. Do not install ad-hoc packages or replace a digest with a tag; checkpoint 00 must be reproducible.",
        },
        {
          title: "Docker reports too little CPU or memory",
          body: "This is a provider sizing or guest-runtime failure. The Platform Engineering revision requires at least 4 CPUs and 16 GiB RAM and is pinned to CX43 for Hetzner sessions.",
        },
        {
          title: "DNS, TLS, or registry access changed after provisioning",
          body: "The checkpoint marker proves the initial gate passed, but external registries can later fail or rate-limit requests. Ask the facilitator to inspect current egress before restoring the workspace.",
        },
      ]
    : details.length
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

  const solve = module.id === "00"
    ? "cd /opt/platform-engineering-workshop/lab/00-setup\n./verify.sh"
    : adaptExternalRuntimeNarrative(
      replaceRuntimeImageReferences(read(`lab/${module.directory}/solve.sh`)),
    )
      .replaceAll("mise x crane@0.21.7 -- crane", "crane")
      .replaceAll("<", "&lt;");
  writeText(
    `content/module-${module.id}-solution.md`,
    `# Canonical solution for module ${module.id}\n\nThis is adapted from the pinned upstream \`solve.sh\` for Intar's digest-pinned external runtime. Reveal it only after the learner has chosen to see the solution.\n\n\`\`\`bash\n${solve.trim()}\n\`\`\`\n`,
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
    renderCatchUpScript(module),
  );

  moduleHintPaths.set(module.id, hintPaths);
  moduleExplainBacks.set(
    module.id,
    module.id === "00"
      ? "Explain why digest pins prevent tag drift but still require DNS, TLS, HTTPS, and registry-availability preflight."
      : extractExplainBack(readme),
  );
}

function renderVerifyScript(module: ModuleDefinition): string {
  const module00Prelude =
    module.id === "00" ? "readonly expected_crane_version=0.21.7\n" : "";
  const module00Check =
    module.id === "00"
      ? `if (( status == 0 )); then
  crane_version="$(crane version 2>&1 || true)"
  if [[ "\${crane_version}" != *"\${expected_crane_version}"* ]]; then
    printf 'expected preinstalled crane %s, got: %s\\n' "\${expected_crane_version}" "\${crane_version}" >&2
    status=1
  fi
fi
`
      : "";
  const workspaceAppCheck = renderWorkspaceAppProbe(module.id);
  return `#!/usr/bin/env bash
set -uo pipefail
${module00Prelude}verifier=/opt/platform-engineering-workshop/lab/${module.directory}/verify.sh
set +e
output="$(${"${verifier}"} 2>&1)"
status=$?
set -e
printf '%s\\n' "${"${output}"}"
${module00Check}${workspaceAppCheck}if (( status == 0 )); then
  printf 'INTAR_PROBE ${module.probe} pass\\n'
else
  printf 'INTAR_PROBE ${module.probe} fail\\n'
fi
exit "${"${status}"}"
`;
}

function renderWorkspaceAppProbe(moduleId: string): string {
  switch (moduleId) {
    case "02":
      return `if (( status == 0 )); then
  public_host=wa-workshop-probe.intar.app
  if ! gitea_page="$(curl -fsS --max-time 15 \\
    -H "Host: \${public_host}" \\
    -H "X-Forwarded-Host: \${public_host}" \\
    -H 'X-Forwarded-Proto: https' \\
    -H 'X-Forwarded-Port: 443' \\
    "http://localhost:30300/cloudbox/platform")"; then
    printf 'Gitea did not answer through the declared workspace-app port\\n' >&2
    status=1
  elif [[ "\${gitea_page}" == *"gitea-http.gitea.svc.cluster.local"* ||
          "\${gitea_page}" == *"localhost:30300"* ||
          "\${gitea_page}" != *"\${public_host}"* ]]; then
    printf 'Gitea did not derive its public URL from %s\\n' "\${public_host}" >&2
    status=1
  fi
fi
`;
    case "03":
      return `if (( status == 0 )); then
  public_host=wa-workshop-probe.intar.app
  if ! rustfs_probe_dir="$(mktemp -d)"; then
    printf 'could not create temporary directory for RustFS workspace-app probe\\n' >&2
    status=1
  else
    rustfs_console_body="\${rustfs_probe_dir}/console.html"
    rustfs_console_headers="\${rustfs_probe_dir}/console.headers"
    rustfs_asset_body="\${rustfs_probe_dir}/asset"
    cleanup_rustfs_probe() {
      rm -f \\
        "\${rustfs_console_body}" \\
        "\${rustfs_console_headers}" \\
        "\${rustfs_asset_body}"
      rmdir "\${rustfs_probe_dir}" 2>/dev/null || true
    }
    trap cleanup_rustfs_probe EXIT

    rustfs_forwarded_curl() {
      curl -sS --max-time 15 \\
        -H "Host: \${public_host}" \\
        -H "X-Forwarded-Host: \${public_host}" \\
        -H 'X-Forwarded-Proto: https' \\
        -H 'X-Forwarded-Port: 443' \\
        "$@"
    }

    rustfs_console_path=/
    if ! rustfs_console_meta="$(rustfs_forwarded_curl \\
      --dump-header "\${rustfs_console_headers}" \\
      --output "\${rustfs_console_body}" \\
      --write-out '%{http_code}\\n%{content_type}' \\
      http://localhost:30901/)"; then
      printf 'RustFS console is not reachable on declared workspace-app port 30901\\n' >&2
      status=1
    else
      rustfs_console_status="\${rustfs_console_meta%%$'\\n'*}"
      rustfs_console_type="\${rustfs_console_meta#*$'\\n'}"
      if [[ "\${rustfs_console_status}" == 3* ]]; then
        rustfs_redirect_location="$(
          awk '
            tolower(substr($0, 1, 9)) == "location:" {
              count += 1
              sub(/^[^:]*:[[:space:]]*/, "")
              sub(/[[:space:]]+$/, "")
              location = $0
            }
            END {
              if (count == 1) print location
            }
          ' "\${rustfs_console_headers}"
        )"
        if [[ -z "\${rustfs_redirect_location}" ||
              "\${rustfs_redirect_location}" == *" "* ||
              "\${rustfs_redirect_location}" == *$'\\t'* ||
              "\${rustfs_redirect_location}" == *\\\\* ]]; then
          printf 'RustFS console returned an unsafe, missing, or duplicate redirect location\\n' >&2
          status=1
        elif [[ "\${rustfs_redirect_location}" == "https://\${public_host}" ]]; then
          rustfs_console_path=/
        elif [[ "\${rustfs_redirect_location}" == "https://\${public_host}/"* ]]; then
          rustfs_console_path="/\${rustfs_redirect_location#https://\${public_host}/}"
        elif [[ "\${rustfs_redirect_location}" == "//\${public_host}" ]]; then
          rustfs_console_path=/
        elif [[ "\${rustfs_redirect_location}" == "//\${public_host}/"* ]]; then
          rustfs_console_path="/\${rustfs_redirect_location#//\${public_host}/}"
        elif [[ "\${rustfs_redirect_location}" == //* ||
                "\${rustfs_redirect_location}" == http://* ||
                "\${rustfs_redirect_location}" == https://* ||
                "\${rustfs_redirect_location}" =~ ^[A-Za-z][A-Za-z0-9+.-]*: ]]; then
          printf 'RustFS console referenced a cross-origin redirect: %s\\n' \\
            "\${rustfs_redirect_location}" >&2
          status=1
        elif [[ "\${rustfs_redirect_location}" == /* ]]; then
          rustfs_console_path="\${rustfs_redirect_location}"
        else
          rustfs_console_path="/\${rustfs_redirect_location#./}"
        fi

        if (( status == 0 )); then
          if ! rustfs_console_meta="$(rustfs_forwarded_curl \\
            --output "\${rustfs_console_body}" \\
            --write-out '%{http_code}\\n%{content_type}' \\
            "http://localhost:30901\${rustfs_console_path}")"; then
            printf 'RustFS console redirect target is not reachable through workspace-app headers\\n' >&2
            status=1
          else
            rustfs_console_status="\${rustfs_console_meta%%$'\\n'*}"
            rustfs_console_type="\${rustfs_console_meta#*$'\\n'}"
            if [[ "\${rustfs_console_status}" != 2* ]]; then
              printf 'RustFS console redirect target returned HTTP %s instead of 2xx\\n' \\
                "\${rustfs_console_status}" >&2
              status=1
            fi
          fi
        fi
      elif [[ "\${rustfs_console_status}" != 2* ]]; then
        printf 'RustFS console returned HTTP %s instead of 2xx or a safe same-origin redirect\\n' \\
          "\${rustfs_console_status}" >&2
        status=1
      fi
    fi

    if (( status == 0 )); then
      if [[ ! -s "\${rustfs_console_body}" ]] ||
         ! grep -Eiq '<(!doctype[[:space:]]+html|html)([[:space:]>])' \\
           "\${rustfs_console_body}" ||
         [[ "\${rustfs_console_type,,}" != text/html* ]]; then
        printf 'RustFS console did not return non-empty HTML (content-type: %s)\\n' \\
          "\${rustfs_console_type:-missing}" >&2
        status=1
      fi
    fi

    if (( status == 0 )); then
      rustfs_asset_ref="$(
        sed -nE \\
          "s@.*(src|href)[[:space:]]*=[[:space:]]*['\\"]([^'\\"]+\\\\.(js|css)(\\\\?[^'\\"]*)?)['\\"].*@\\\\2@p" \\
          "\${rustfs_console_body}" |
          sed -n '1p'
      )"
      if [[ -z "\${rustfs_asset_ref}" ]]; then
        printf 'RustFS console HTML did not reference a JavaScript or CSS asset\\n' >&2
        status=1
      elif [[ "\${rustfs_asset_ref}" == "https://\${public_host}/"* ]]; then
        rustfs_asset_path="/\${rustfs_asset_ref#https://\${public_host}/}"
      elif [[ "\${rustfs_asset_ref}" == "//\${public_host}/"* ]]; then
        rustfs_asset_path="/\${rustfs_asset_ref#//\${public_host}/}"
      elif [[ "\${rustfs_asset_ref}" == http://* ||
              "\${rustfs_asset_ref}" == https://* ||
              "\${rustfs_asset_ref}" == //* ||
              "\${rustfs_asset_ref}" =~ ^[A-Za-z][A-Za-z0-9+.-]*: ||
              "\${rustfs_asset_ref}" == *" "* ||
              "\${rustfs_asset_ref}" == *$'\\t'* ||
              "\${rustfs_asset_ref}" == *\\\\* ]]; then
        printf 'RustFS console referenced a cross-origin asset: %s\\n' \\
          "\${rustfs_asset_ref}" >&2
        status=1
      elif [[ "\${rustfs_asset_ref}" == /* ]]; then
        rustfs_asset_path="\${rustfs_asset_ref}"
      else
        rustfs_console_file_path="\${rustfs_console_path%%[?#]*}"
        rustfs_console_dir="\${rustfs_console_file_path%/*}/"
        rustfs_asset_path="\${rustfs_console_dir}\${rustfs_asset_ref#./}"
      fi
    fi

    if (( status == 0 )); then
      if ! rustfs_asset_meta="$(rustfs_forwarded_curl \\
        --output "\${rustfs_asset_body}" \\
        --write-out '%{http_code}\\n%{content_type}' \\
        "http://localhost:30901\${rustfs_asset_path}")"; then
        printf 'RustFS console asset is not reachable through the workspace-app headers: %s\\n' \\
          "\${rustfs_asset_ref}" >&2
        status=1
      else
        rustfs_asset_status="\${rustfs_asset_meta%%$'\\n'*}"
        rustfs_asset_type="\${rustfs_asset_meta#*$'\\n'}"
        if [[ "\${rustfs_asset_status}" != 2* ]]; then
          printf 'RustFS console asset returned HTTP %s: %s\\n' \\
            "\${rustfs_asset_status}" "\${rustfs_asset_ref}" >&2
          status=1
        elif [[ ! -s "\${rustfs_asset_body}" ||
                "\${rustfs_asset_type,,}" == text/html* ]]; then
          printf 'RustFS console asset is empty or returned HTML (content-type: %s): %s\\n' \\
            "\${rustfs_asset_type:-missing}" "\${rustfs_asset_ref}" >&2
          status=1
        fi
      fi
    fi

    cleanup_rustfs_probe
    trap - EXIT
  fi
fi
`;
    case "06":
      return `if (( status == 0 )); then
  public_host=wa-workshop-probe.intar.app
  upstream_host=hello.demo.127.0.0.1.sslip.io
  if ! knative_page="$(curl -fsS --max-time 60 \\
    -H "Host: \${upstream_host}" \\
    -H "X-Forwarded-Host: \${public_host}" \\
    -H 'X-Forwarded-Proto: https' \\
    -H 'X-Forwarded-Port: 443' \\
    http://localhost:31080/)"; then
    printf 'Knative did not answer through the declared upstream-host contract\\n' >&2
    status=1
  elif [[ "\${knative_page,,}" != *"hello"* ]]; then
    printf 'Knative upstream host did not route to demo/hello\\n' >&2
    status=1
  fi
fi
`;
    default:
      return "";
  }
}

function renderCatchUpScript(module: ModuleDefinition): string {
  if (module.id === "00") {
    return `#!/usr/bin/env bash
set -euo pipefail

readonly workshop_root=/opt/platform-engineering-workshop
cd "\${workshop_root}"
test -f /var/lib/intar-workshop/registry-preflight.ok
docker info >/dev/null
for tool in talosctl kubectl helm crane cilium jq git curl; do
  command -v "\${tool}" >/dev/null
done
exec ./lab/00-setup/verify.sh
`;
  }

  let script = replaceRuntimeImageReferences(
    read(`lab/${module.directory}/solve.sh`),
  )
    .replaceAll("mise x crane@0.21.7 -- crane", "crane")
    .replace(
      /^LAB_DIR=.*$/m,
      `LAB_DIR="/opt/platform-engineering-workshop/lab/${module.directory}"`,
    )
    .replace(
      /^REPO_ROOT=.*$/m,
      'REPO_ROOT="/opt/platform-engineering-workshop"',
    )
    .replace(
      /^DIR=.*$/m,
      `DIR="/opt/platform-engineering-workshop/lab/${module.directory}"`,
    );
  script = script.replace(
    /^#![^\n]*\n/u,
    `#!/usr/bin/env bash\n# Trusted checkpoint reconstruction adapted from pinned module ${module.id}.\n`,
  );
  script = adaptExternalRuntimeNarrative(script);
  if (/\/solutions(?:\/|\b)/u.test(script)) {
    throw new Error(
      `module ${module.id} catch-up still references upstream solutions`,
    );
  }
  return script;
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
    ["gitea", "Gitea", 30300, "02", null],
    ["argocd", "Argo CD", 30080, "02", null],
    ["rustfs", "RustFS", 30901, "03", null],
    ["knative", "Knative", 31080, "06", "hello.demo.127.0.0.1.sslip.io"],
    ["zot", "Zot Registry", 30500, "07", null],
    ["cloudbox", "Cloudbox Console", 30600, "08", null],
    ["grafana", "Grafana", 30030, "09", null],
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

  vm "learner" {
    image       = "platform-engineering-workshop-debian13-1b6fad4"
    cpu_millis  = 4000
    memory_mib  = 16384
    disk_mib    = 65536
  }

  provider "hetzner_cloud" {
    vm_id        = "learner"
    server_type  = "cx43"
    system_image = "debian-13"
  }

`;
  for (const [id, label, port, releaseModule, upstreamHost] of applications) {
    result += `  application ${quote(id)} {
    label          = ${quote(label)}
    vm             = "learner"
    port           = ${port}
    protocol       = "http"
${upstreamHost ? `    upstream_host  = ${quote(upstreamHost)}\n` : ""}    release_module = ${quote(releaseModule)}
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

The signed checkpoint bundle reconstructs a clean Debian 13 server. It installs
the learner-safe pinned repository at \`/opt/platform-engineering-workshop\`,
installs the pinned toolchain, and pulls container images from external
registries only by reviewed SHA-256 digest. No OCI layer, solution tree,
facilitator material, or presenter notes enter the reconstruction bundle. DNS,
TLS, and HTTPS registry checks are a mandatory checkpoint-00 gate. Stargate
reaches declared guest applications by SSH direct forwarding; no application
port is exposed directly on the Hetzner server.

The upstream custom Grafana image was not publicly pullable while this lock was
created. The direct-cloud adaptation therefore pins stock Grafana and uses its
built-in Prometheus, Loki, and Jaeger datasources. The lock resolver must replace
that reviewed fallback with the custom image digest before native Victoria
plugins can be claimed.

The source importer intentionally converts Slidev HTML/Vue presentation syntax
to Intar's finite native Markdown layouts and separates every HTML speaker-note
comment into its corresponding presenter-notes file. The generated deck must
remain exactly 85 slides. CI regenerates the raw import from the pinned commit
and locks both trees plus their explicit Intar-adaptation delta; an intentional
source or adaptation change must update that reviewed lock.
`;
}

function loadImageMappings(): Map<string, string> {
  const lockPath = join(import.meta.dir, "platform-engineering-images.lock");
  const mappings = new Map<string, string>();
  for (const [index, raw] of readFileSync(lockPath, "utf8").split(/\r?\n/u).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const fields = line.split("\t");
    if (fields.length !== 2 || !fields[0] || !fields[1]) {
      throw new Error(`invalid image lock line ${index + 1}`);
    }
    const [source, target] = fields as [string, string];
    assertDigestPinnedImage(target, `image lock line ${index + 1}`);
    if (mappings.has(source)) {
      throw new Error(`duplicate image lock source ${source}`);
    }
    mappings.set(source, target);
  }
  return mappings;
}

function resolveUpstreamImageInventory(): string[] {
  const seenSources = new Set<string>();
  const resolved = new Set<string>();
  for (const raw of read("scripts/images.txt").split(/\r?\n/u)) {
    const line = raw.replace(/\s+#.*$/u, "").trim();
    if (!line || line.startsWith("#") || /^\[[^\]]+\]$/u.test(line)) continue;
    seenSources.add(line);
    const target = line.includes("@sha256:")
      ? line
      : imageMappings.get(line);
    if (!target) {
      throw new Error(
        `tag-only upstream image ${line} has no reviewed digest in platform-engineering-images.lock`,
      );
    }
    const canonical = canonicalizeDigestReferences(target);
    assertDigestPinnedImage(canonical, line);
    if (!OMITTED_RUNTIME_IMAGES.has(line)) resolved.add(canonical);
  }
  for (const source of imageMappings.keys()) {
    if (!seenSources.has(source) && !ADDITIONAL_RUNTIME_IMAGE_SOURCES.has(source)) {
      throw new Error(`reviewed image lock source is absent upstream: ${source}`);
    }
    if (ADDITIONAL_RUNTIME_IMAGE_SOURCES.has(source)) {
      const target = imageMappings.get(source);
      if (!target) throw new Error(`additional runtime image ${source} has no digest`);
      resolved.add(canonicalizeDigestReferences(target));
    }
  }
  return [...resolved].sort();
}

function assertDigestPinnedImage(value: string, label: string) {
  if (!/^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} does not resolve to a canonical digest-pinned image`);
  }
}

function replaceRuntimeImageReferences(value: string): string {
  let result = canonicalizeDigestReferences(value);
  const entries = [...imageMappings.entries()].sort(
    ([left], [right]) => right.length - left.length,
  );
  for (const [source, target] of entries) {
    result = replaceStandaloneImageReference(result, source, target);
    if (source.startsWith("docker.io/")) {
      const withoutRegistry = source.slice("docker.io/".length);
      result = replaceStandaloneImageReference(result, withoutRegistry, target);
      if (withoutRegistry.startsWith("library/")) {
        result = replaceStandaloneImageReference(
          result,
          withoutRegistry.slice("library/".length),
          target,
        );
      }
    }
  }
  return result;
}

function canonicalizeDigestReferences(value: string): string {
  return value.replace(
    /([a-z0-9][a-z0-9.-]*(?::[0-9]+)?\/[a-z0-9._/-]+):[^@\s"'<>]+(@sha256:[a-f0-9]{64})/gu,
    "$1$2",
  );
}

function replaceStandaloneImageReference(
  value: string,
  source: string,
  target: string,
): string {
  const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return value.replace(
    new RegExp(`(?<![A-Za-z0-9._/@:-])${escaped}(?![A-Za-z0-9._/@:-])`, "gu"),
    target,
  );
}

function writeRuntimeSource() {
  writeText(
    "runtime/runtime.json",
    JSON.stringify(
      {
        schema_version: 1,
        install_root: "/opt/platform-engineering-workshop",
      },
      null,
      2,
    ),
  );
  writeExecutable("runtime/bootstrap.sh", renderRuntimeBootstrap());

  for (const relative of ["mise.toml", "apps", "gitops", "lab", "scripts"]) {
    copyRuntimePath(relative);
  }
  const externalImages = new Set(upstreamExternalImages);
  for (const image of collectRuntimeDigestReferences()) externalImages.add(image);
  const lockedImages = [...externalImages].sort();
  const imageLock =
    `# External OCI manifests. Every runtime pull is content-addressed.\n${lockedImages.join("\n")}`;
  writeText("runtime/images.lock", imageLock);
  writeText("runtime/source/scripts/images.lock", imageLock);
}

function collectRuntimeDigestReferences(): string[] {
  const registries = "(?:docker\\.io|ghcr\\.io|quay\\.io|registry\\.k8s\\.io|gcr\\.io|public\\.ecr\\.aws|xpkg\\.crossplane\\.io|docker\\.gitea\\.com)";
  const pattern = new RegExp(
    `${registries}/[a-z0-9._/-]+@sha256:[a-f0-9]{64}`,
    "gu",
  );
  const images = new Set<string>();
  const visit = (root: string, relativePath = "") => {
    const path = join(root, relativePath);
    const metadata = lstatSync(path);
    if (metadata.isDirectory()) {
      for (const child of readdirSync(path).sort()) visit(root, join(relativePath, child));
      return;
    }
    if (!metadata.isFile()) return;
    const bytes = readFileSync(path);
    if (bytes.includes(0)) return;
    for (const reference of bytes.toString("utf8").matchAll(pattern)) {
      const image = reference[0];
      assertDigestPinnedImage(image, relativePath);
      images.add(image);
    }
  };
  visit(join(outputRoot, "runtime", "source"));
  visit(join(outputRoot, "scripts"));
  return [...images].sort();
}

function copyRuntimePath(relativePath: string) {
  if (!runtimePathIncluded(relativePath)) return;
  const source = join(sourceRoot, relativePath);
  const metadata = lstatSync(source);
  if (metadata.isSymbolicLink()) {
    throw new Error(`runtime source contains a symlink: ${relativePath}`);
  }
  if (metadata.isDirectory()) {
    for (const child of readdirSync(source).sort()) {
      copyRuntimePath(join(relativePath, child));
    }
    return;
  }
  if (!metadata.isFile()) {
    throw new Error(`runtime source is not a regular file: ${relativePath}`);
  }

  const target = join(outputRoot, "runtime/source", relativePath);
  mkdirSync(dirname(target), { recursive: true });
  const raw = readFileSync(source);
  const isText = !raw.includes(0);
  if (!isText) {
    copyFileSync(source, target);
  } else {
    let content = adaptRuntimeSourceText(
      replaceRuntimeImageReferences(raw.toString("utf8")),
    );
    if (relativePath === "mise.toml") {
      content = renderRuntimeMiseConfig();
    } else if (relativePath.startsWith("lab/05-debug-with-ai/faults/01-web-down/")) {
      content = adaptDigestPinnedFault01(relativePath, content);
    } else if (relativePath === "lab/00-setup/verify.sh") {
      content = renderRuntimeModule00Verifier();
    } else if (relativePath === "scripts/create-cluster.sh") {
      content = adaptCreateClusterForExternalRegistries(
        adaptTalosSystemImagePins(content),
      );
    } else if (relativePath === "scripts/versions.env") {
      content = adaptRuntimeVersions(content);
    } else if (relativePath === "scripts/lib.sh") {
      content = adaptRuntimeLibrary(content);
    } else if (relativePath === "scripts/destroy-cluster.sh") {
      content = adaptDestroyCluster(content);
    } else if (relativePath === "scripts/bootstrap-gitops.sh") {
      content = adaptGiteaDigestValues(content);
    } else if (relativePath === "scripts/seed-gitea.sh") {
      content = adaptSeedGiteaForSealedCheckpoints(content);
    } else if (relativePath === "gitops/components/rustfs/service-nodeport.yaml") {
      content = adaptRustfsWorkspaceAppService(content);
    } else if (relativePath === "gitops/components/grafana/grafana.yaml") {
      content = adaptStockGrafana(content);
    } else if (relativePath === "lab/07-ci/app/Dockerfile") {
      content = adaptLearnerBuiltImageDockerfile(content);
    }
    writeFileSync(target, `${content.replace(/(?:\r?\n)+$/u, "")}\n`);
  }
  chmodSync(target, metadata.mode & 0o111 ? 0o755 : 0o644);
}

function runtimePathIncluded(relativePath: string): boolean {
  const normalized = relativePath.split(sep).join("/");
  const components = normalized.split("/");
  if (components.some((part) => [".git", "solutions", "slides", ".github", "node_modules"].includes(part))) {
    return false;
  }
  if (components[0] === "apps" && components[1] !== "demo-app") return false;
  const name = components.at(-1) ?? "";
  if (name === "solve.sh" || name === "README.md" || name === "VENDOR.md") return false;
  if (normalized.startsWith("scripts/")) {
    const excluded = new Set([
      "scripts/catch-up.sh",
      "scripts/check-consistency.sh",
      "scripts/cloudbox-init.sh",
      "scripts/dev-setup.sh",
      "scripts/images.txt",
      "scripts/install.sh",
      "scripts/kind-fallback.sh",
      "scripts/screenshots.sh",
    ]);
    if (excluded.has(normalized)) return false;
  }
  return normalized === "mise.toml" ||
    ["apps", "gitops", "lab", "scripts"].includes(components[0] ?? "");
}

function adaptRuntimeSourceText(value: string): string {
  return value
    .replace(/(?:\.\/)?scripts\/cloudbox-init\.sh(?:\s+--[a-z-]+)*/g, "the Intar checkpoint bootstrap")
    .replace(/solutions\/module-[0-9]{2}(?:\/[A-Za-z0-9._/-]+)?/g, "canonical module state")
    .replace(/the workshop's offline cache/gi, "the workshop's digest-pinned external image contract")
    .replace(/pre-pulled by `the Intar checkpoint bootstrap`/gi, "declared in the signed external image lock");
}

function renderRuntimeBootstrap(): string {
  const talosImage = imageMappings.get("ghcr.io/siderolabs/talos:v1.13.6");
  if (!talosImage) throw new Error("Talos runtime digest is missing");
  return `#!/usr/bin/env bash
set -euo pipefail

readonly root="\${INTAR_WORKSHOP_INSTALL_ROOT:?missing install root}"
readonly image_lock="\${INTAR_WORKSHOP_IMAGE_LOCK:?missing image lock}"
readonly mise_version=v2026.7.3
readonly mise_sha256=06088e84e4514b59fd2b6b17927bcc37aa0ab10020a270868871fb010b92069b

[[ "$(id -u)" == 0 ]] || { echo "runtime bootstrap requires root" >&2; exit 1; }
[[ "$(uname -m)" == x86_64 ]] || { echo "runtime requires x86_64" >&2; exit 1; }
. /etc/os-release
[[ "\${ID}" == debian && "\${VERSION_ID}" == 13 ]] || {
  echo "runtime requires Debian 13" >&2
  exit 1
}

preflight_https() {
  local host="$1" status
  # Docker Hub's canonical image host redirects /v2/ to the marketing site.
  # Probe the registry endpoint that containerd and Docker actually use.
  if [[ "\${host}" == docker.io ]]; then
    host=registry-1.docker.io
  fi
  getent ahosts "\${host}" >/dev/null || { echo "DNS failed for \${host}" >&2; return 1; }
  status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    --connect-timeout 10 --max-time 20 --proto '=https' --proto-redir '=https' \
    --tlsv1.2 "https://\${host}/v2/")" || return 1
  case "\${status}" in 200|401|403) ;; *) echo "HTTPS registry preflight for \${host} returned \${status}" >&2; return 1;; esac
}

mapfile -t registries < <(sed 's/#.*//' "\${image_lock}" | awk 'NF {sub(/\\/.*/, "", $1); print $1}' | sort -u)
for registry in "\${registries[@]}"; do
  preflight_https "\${registry}"
done
for host in deb.debian.org security.debian.org github.com; do
  getent ahosts "\${host}" >/dev/null
  curl --fail --silent --show-error --head --max-time 20 --proto '=https' \
    --proto-redir '=https' --tlsv1.2 "https://\${host}/" >/dev/null
done

export DEBIAN_FRONTEND=noninteractive
sed -i -e 's|http://deb.debian.org|https://deb.debian.org|g' \
  -e 's|http://security.debian.org|https://security.debian.org|g' \
  /etc/apt/sources.list /etc/apt/sources.list.d/*.sources 2>/dev/null || true
apt-get update
apt-get install --yes --no-install-recommends ca-certificates curl docker-cli docker.io git jq xz-utils
systemctl enable --now docker

mise_tmp="$(mktemp)"
trap 'rm -f "\${mise_tmp}"' EXIT
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  --tlsv1.2 "https://github.com/jdx/mise/releases/download/\${mise_version}/mise-\${mise_version}-linux-x64" \
  --output "\${mise_tmp}"
printf '%s  %s\n' "\${mise_sha256}" "\${mise_tmp}" | sha256sum --check --status
install --owner=root --group=root --mode=0755 "\${mise_tmp}" /usr/local/bin/mise

export MISE_DATA_DIR=/opt/intar-mise
export MISE_CACHE_DIR=/var/cache/intar-mise
export MISE_YES=1
cd "\${root}"
mise trust "\${root}/mise.toml"
mise install
for tool in talosctl kubectl helm crane cilium jq; do
  target="$(mise which "\${tool}")"
  ln -sfn "\${target}" "/usr/local/bin/\${tool}"
done

# Validate every immutable manifest before any checkpoint catch-up starts.
while IFS= read -r image; do
  image="\${image%%#*}"
  image="\${image//[[:space:]]/}"
  [[ -z "\${image}" ]] && continue
  [[ "\${image}" =~ @sha256:[a-f0-9]{64}$ ]] || { echo "tag-only image: \${image}" >&2; exit 1; }
  crane manifest "\${image}" >/dev/null
done < "\${image_lock}"

# Only the Talos node container lives in the host Docker content store. Talos'
# inner containerd pulls the remaining digest-pinned workloads from upstream.
docker pull ${talosImage}

if [[ ! -d .git ]]; then
  git init --initial-branch=main --quiet
  printf '.intar-runtime-owner\n' >> .git/info/exclude
  git add -A
  git -c user.name=Intar -c user.email=workshop@intar.dev \
    commit --quiet -m 'Pinned learner source ${PINNED_REVISION}'
fi
mkdir -p /var/lib/intar-workshop
printf '%s\n' "$(date -u +%FT%TZ)" > /var/lib/intar-workshop/registry-preflight.ok
`;
}

function renderRuntimeMiseConfig(): string {
  return `[tools]
"aqua:siderolabs/talos" = "1.13.6"
kubectl = "1.36.2"
helm = "3.21.3"
crane = "0.21.7"
"aqua:cilium/cilium-cli" = "0.19.5"
jq = "1.8.2"

[tasks."cluster:create"]
description = "Create the Talos-in-Docker cluster and install Cilium"
run = "./scripts/create-cluster.sh"

[tasks."cluster:destroy"]
description = "Destroy the Talos-in-Docker cluster"
run = "./scripts/destroy-cluster.sh"

[tasks."gitops:bootstrap"]
description = "Install Gitea and Argo CD"
run = "./scripts/bootstrap-gitops.sh"

[tasks."gitops:seed"]
description = "Push the learner repository to in-cluster Gitea"
run = "./scripts/seed-gitea.sh"

[tasks.status]
description = "Show cluster and platform status"
run = [
  "kubectl get nodes -o wide",
  "kubectl get applications -n argocd 2>/dev/null || true",
  "kubectl get pods -A",
]
`;
}

function renderRuntimeModule00Verifier(): string {
  return `#!/usr/bin/env bash
set -euo pipefail
failed=0
check() { if "$@"; then printf 'PASS %s\n' "$*"; else printf 'FAIL %s\n' "$*" >&2; failed=1; fi; }
check test "$(uname -m)" = x86_64
check grep -q '^VERSION_ID="\\?13"\\?$' /etc/os-release
check docker info
check test "$(docker info --format '{{.NCPU}}')" -ge 4
check test "$(( $(docker info --format '{{.MemTotal}}') / 1024 / 1024 ))" -ge 15000
check test -f /var/lib/intar-workshop/registry-preflight.ok
while IFS= read -r image; do
  image="\${image%%#*}"; image="\${image//[[:space:]]/}"; [[ -z "\${image}" ]] && continue
  [[ "\${image}" =~ @sha256:[a-f0-9]{64}$ ]] || { echo "FAIL tag-only image \${image}" >&2; failed=1; }
done < /opt/platform-engineering-workshop/scripts/images.lock
for tool in talosctl kubectl helm crane cilium jq git curl; do
  command -v "\${tool}" >/dev/null || { echo "FAIL missing \${tool}" >&2; failed=1; }
done
exit "\${failed}"
`;
}

function adaptSeedGiteaForSealedCheckpoints(value: string): string {
  const anchor = `# --- 3. Push -----------------------------------------------------------------------
cd "\${REPO_ROOT}"
`;
  const replacement = `# --- 3. Push -----------------------------------------------------------------------
cd "\${REPO_ROOT}"
# Canonical KVM checkpoints deliberately omit source-control metadata because
# Git objects can retain removed author-only files. Recreate a fresh repository
# from the already filtered participant tree when a learner reaches module 02.
# Direct-cloud reconstruction already creates this same curated repository in
# bootstrap.sh, so this branch is idempotent across both runtime providers.
if [[ ! -d .git ]]; then
  git init --initial-branch=main --quiet
  printf '.intar-runtime-owner\\n' >> .git/info/exclude
  git add -A
  git -c user.name=Intar -c user.email=workshop@intar.dev \\
    commit --quiet -m 'Pinned learner source ${PINNED_REVISION}'
fi
`;
  const adapted = value.replace(anchor, replacement);
  if (adapted === value) {
    throw new Error("Gitea seed push anchor changed upstream");
  }
  return adapted;
}

function adaptTalosSystemImagePins(value: string): string {
  const pin = (source: string) => imageMappings.get(source) ??
    (() => { throw new Error(`missing system image pin for ${source}`); })();
  const clusterImages = `cluster:
  apiServer:
    image: ${pin("registry.k8s.io/kube-apiserver:v1.36.2")}
  controllerManager:
    image: ${pin("registry.k8s.io/kube-controller-manager:v1.36.2")}
  scheduler:
    image: ${pin("registry.k8s.io/kube-scheduler:v1.36.2")}
  coreDNS:
    image: ${pin("registry.k8s.io/coredns/coredns:v1.14.2")}
  network:`;
  const adapted = value.replace("cluster:\n  network:", clusterImages);
  if (adapted === value) throw new Error("Talos machine patch anchor changed upstream");
  const withKubeletImages = adapted.replace(
    "  kubelet:\n    extraMounts:",
    `  kubelet:\n    image: ${pin("ghcr.io/siderolabs/kubelet:v1.36.2")}\n    extraArgs:\n      pod-infra-container-image: ${pin("registry.k8s.io/pause:3.10.1")}\n    extraMounts:`,
  );
  const withControlPlaneEtcd = withKubeletImages.replace(
    `patches=(--config-patch "\${CNI_PATCH}")`,
    `# Talos rejects cluster.etcd configuration on worker machine configs, so
# keep its digest pin in a control-plane-only patch.
CONTROL_PLANE_PATCH="$(cat <<'EOF'
cluster:
  etcd:
    image: ${pin("registry.k8s.io/etcd:v3.6.12")}
EOF
)"

patches=(
  --config-patch "\${CNI_PATCH}"
  --config-patch-controlplanes "\${CONTROL_PLANE_PATCH}"
)`,
  );
  if (withControlPlaneEtcd === withKubeletImages) {
    throw new Error("Talos role-specific patch anchor changed upstream");
  }
  return withControlPlaneEtcd;
}

function adaptCreateClusterForExternalRegistries(value: string): string {
  const withoutMirror = value.replace(
    /# Registry mirrors:[\s\S]*?\n# --- 1\. Create the cluster/u,
    `# The direct-cloud runtime intentionally has no local registry mirror.
# Talos containerd resolves every external workload from its digest-pinned
# manifest reference. Checkpoint 00 has already gated DNS, TLS, HTTPS, and
# registry manifest availability for the full signed image lock.
info "Using digest-pinned external registries; no local mirror is configured"

# --- 1. Create the cluster`,
  );
  if (withoutMirror === value) {
    throw new Error("Talos registry-mirror block changed upstream");
  }
  const adapted = withoutMirror
    .replace(
      /\n#\s+2\. Points the nodes'[\s\S]*?\n#\s+3\. Installs Cilium/u,
      "\n#   2. Pulls every Talos/Kubernetes workload from a reviewed external digest\n#   3. Installs Cilium",
    )
    .replace(
      /# Environment overrides:[\s\S]*?# ={10,}/u,
      "# External image access is fixed by the signed runtime bundle; there is no mirror override.\n# =============================================================================",
    )
    .replace(
      "${NODEPORT_RUSTFS_S3}:${NODEPORT_RUSTFS_S3}/tcp,${NODEPORT_GRAFANA}",
      "${NODEPORT_RUSTFS_S3}:${NODEPORT_RUSTFS_S3}/tcp,${NODEPORT_RUSTFS_CONSOLE}:${NODEPORT_RUSTFS_CONSOLE}/tcp,${NODEPORT_GRAFANA}",
    );
  if (
    !adapted.includes(
      "${NODEPORT_RUSTFS_CONSOLE}:${NODEPORT_RUSTFS_CONSOLE}/tcp",
    )
  ) {
    throw new Error(
      "Talos RustFS console exposed-port anchor changed upstream",
    );
  }
  return adapted;
}

function adaptRuntimeVersions(value: string): string {
  const talosImage = imageMappings.get("ghcr.io/siderolabs/talos:v1.13.6");
  if (!talosImage) throw new Error("Talos runtime digest is missing");
  const adapted = value
    .replace(/^TALOS_IMAGE=.*$/mu, `TALOS_IMAGE="${talosImage}"`)
    .replace(
      'NODEPORT_RUSTFS_S3="30900"',
      'NODEPORT_RUSTFS_S3="30900"\nNODEPORT_RUSTFS_CONSOLE="30901"',
    )
    .replace(
      /# Host-side Ollama model .*\n# see GitHub issues/u,
      "# Optional host-side Ollama model used only by the source workshop's high-memory path;\n# see GitHub issues",
    )
    .replace(
      /# --- Image pre-pull mirror \(created by .*?\) -+/u,
      "# --- Legacy mirror constants (unused by the Intar direct-cloud path) -------",
    )
    .replace(/\n# --- kind fallback[\s\S]*?(?=\n# --- CNI)/u, "")
    .replace(
      /\n# --- Legacy mirror constants[\s\S]*?(?=\n# --- Published minimum spec)/u,
      "",
    )
    .replace(
      /Tool versions \(talosctl, kubectl, helm, kind, crane, cilium-cli, jq, node\)/u,
      "Tool versions (talosctl, kubectl, helm, crane, cilium-cli, jq)",
    );
  if (
    !adapted.includes(`TALOS_IMAGE="${talosImage}"`) ||
    !adapted.includes('NODEPORT_RUSTFS_CONSOLE="30901"')
  ) {
    throw new Error(
      "runtime versions are missing image or RustFS console pins",
    );
  }
  return adapted;
}

function adaptRuntimeLibrary(value: string): string {
  const adapted = value
    .replace(
      /# Provides: colored[^\n]*\n# confirm, detect_arch, is_wsl2, mirror_running, mirror_host_endpoint —\n# and sources versions\.env/u,
      "# Provides: logging, command guards, rollout waits, Docker readiness,\n# Gitea authentication, and sources versions.env",
    )
    .replace(
      /# mirror_running[\s\S]*?(?=# git_as_gitea_admin)/u,
      "",
    )
    .replace(
      /have "\$1" \|\| die "'\$1' not found\. \$\{2:-[^}]+\}"/u,
      () => `have "$1" || die "'$1' not found. \${2:-request a checkpoint-00 restore; do not install an unpinned replacement.}"`,
    );
  if (adapted.includes("mirror_host_endpoint") || adapted.includes("strip_registry()")) {
    throw new Error("runtime helper still contains legacy mirror functions");
  }
  return adapted;
}

function adaptDestroyCluster(value: string): string {
  const adapted = value
    .replace(
      /# Destroys the Talos docker cluster[\s\S]*?# ={10,}/u,
      "# Destroys the Talos Docker cluster and removes its kubeconfig entries.\n# The Intar direct-cloud runtime has no local image mirror to preserve.\n# =============================================================================",
    )
    .replace(/\nPURGE_MIRROR="false"\n\[\[[^\n]+\n/u, "\n")
    .replace(/\n# --- Mirror -+[\s\S]*?(?=\necho\n)/u, "\n");
  if (adapted.includes("PURGE_MIRROR") || adapted.includes("MIRROR_NAME")) {
    throw new Error("destroy-cluster still contains legacy mirror cleanup");
  }
  return adapted;
}

function adaptLearnerBuiltImageDockerfile(value: string): string {
  const expected = "FROM zot.zot.svc.cluster.local:5000/library/busybox:1.37.0";
  if (!value.includes(expected)) {
    throw new Error("module 07 learner-built image base changed upstream");
  }
  if (value.includes("zot.zot.svc.cluster.local:5000/docker.io/")) {
    throw new Error("external image pin was incorrectly nested below Zot");
  }
  return value
    .replace(
      /# The base image comes from YOUR in-cluster Zot registry — seed it first[\s\S]*?# your own registry — fully offline\./u,
      "# The base is copied from its reviewed external digest into learner-owned Zot\n# before this build. The resulting learner artifact is intentionally addressed\n# by its local workshop tag; no mutable external tag is pulled.",
    );
}

function adaptDigestPinnedFault01(relativePath: string, value: string): string {
  const busybox = imageMappings.get("docker.io/library/busybox:1.37.0");
  if (!busybox) throw new Error("BusyBox runtime digest is missing");
  if (relativePath.endsWith("issue.yaml")) {
    const adapted = value.replace(
      /image: docker\.io\/library\/busybox:1\.37\.00/u,
      `image: ${busybox}\n          imagePullPolicy: Never`,
    );
    if (adapted === value) throw new Error("fault 01 issue image anchor changed upstream");
    return adapted;
  }
  if (relativePath.endsWith("fix.yaml")) {
    const adapted = value
      .replace(
        /# was: busybox:1\.37\.00[^\n]*/u,
        "# was: imagePullPolicy Never, which forbade the required external digest pull",
      )
      .replace(
        new RegExp(`image: ${busybox.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u"),
        `image: ${busybox}\n          imagePullPolicy: IfNotPresent`,
      );
    if (!adapted.includes("imagePullPolicy: IfNotPresent")) {
      throw new Error("fault 01 fix image anchor changed upstream");
    }
    return adapted;
  }
  if (relativePath.endsWith("description.md")) {
    return `# Fault 01 — spoiler

**Symptom:** the \`web\` pod in \`faultlab-01\` remains in
\`ErrImageNeverPull\` even though its image is pinned to the reviewed BusyBox
digest.

**Root cause:** the Deployment sets \`imagePullPolicy: Never\`. A fresh Talos
node has not imported that digest into its own containerd store, so kubelet is
explicitly forbidden from retrieving it from the external registry.

Follow \`kubectl get pods\` with \`kubectl describe pod\`; the Event text names
the policy failure. Fix the Deployment source by changing the policy to
\`IfNotPresent\` while keeping the exact digest. This retains the workshop's
immutable external-image contract and teaches the same Events-first diagnostic
path without introducing a floating or misspelled tag.
`;
  }
  return value;
}

function adaptGiteaDigestValues(value: string): string {
  const image = imageMappings.get("docker.gitea.com/gitea:1.26.1-rootless");
  if (!image) throw new Error("Gitea image pin is missing");
  const digest = image.split("@", 2)[1];
  const pinned = value.replace(
    "image:\n  rootless: true",
    `image:\n  registry: docker.gitea.com\n  repository: gitea\n  tag: \"\"\n  digest: ${digest}\n  rootless: true`,
  );
  if (pinned === value) throw new Error("Gitea values anchor changed upstream");
  const adapted = pinned.replace(
    `    server:
      DOMAIN: gitea-http.gitea.svc.cluster.local
      ROOT_URL: \${GITEA_CLUSTER_URL}/`,
    `    server:
      DOMAIN: localhost
      ROOT_URL: http://localhost:\${NODEPORT_GITEA}/
      LOCAL_ROOT_URL: \${GITEA_CLUSTER_URL}/
      PUBLIC_URL_DETECTION: auto`,
  );
  if (adapted === pinned) {
    throw new Error("Gitea dynamic public URL anchor changed upstream");
  }
  return adapted;
}

function adaptRustfsWorkspaceAppService(value: string): string {
  const expected = `  ports:
    - name: endpoint
      port: 9000
      targetPort: 9000
      nodePort: 30900`;
  const replacement = `${expected}
    - name: console
      port: 9001
      targetPort: 9001
      nodePort: 30901`;
  const adapted = value.replace(expected, replacement);
  if (adapted === value) {
    throw new Error("RustFS NodePort service anchor changed upstream");
  }
  return adapted;
}

function adaptStockGrafana(value: string): string {
  const adapted = value
    .replaceAll("type: victoriametrics-metrics-datasource", "type: prometheus")
    .replaceAll("type: victoriametrics-logs-datasource", "type: loki")
    .replace(
      "url: http://victoria-logs.observability.svc.cluster.local:9428",
      "url: http://victoria-logs.observability.svc.cluster.local:9428/select/logsql/query",
    )
    .replace(/\n\s*- name: GF_PATHS_PLUGINS\n\s*value: \/opt\/grafana-plugins/u, "");
  if (adapted.includes("victoriametrics-metrics-datasource") ||
      adapted.includes("victoriametrics-logs-datasource") ||
      adapted.includes("GF_PATHS_PLUGINS")) {
    throw new Error("stock Grafana adaptation is incomplete");
  }
  return adapted;
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
