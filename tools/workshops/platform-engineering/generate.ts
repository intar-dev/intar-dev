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
import { loadSourceLock } from "./lock";
import { assertPinnedSource } from "./normalize";

const sourceLock = loadSourceLock();
const PINNED_REVISION = sourceLock.revision;
const CONTENT_LOCK_ROOT = resolve(
  import.meta.dir,
  "../../../content/workshops/platform-engineering/locks",
);
const OMITTED_RUNTIME_IMAGES = new Set([
  "docker.io/kindest/node:v1.36.1@sha256:3489c7674813ba5d8b1a9977baea8a6e553784dab7b84759d1014dbd78f7ebd5",
  "docker.io/library/registry:3.1.1",
]);
const ADDITIONAL_RUNTIME_IMAGE_SOURCES = new Set([
  "ghcr.io/crossplane-contrib/function-patch-and-transform:v0.10.7",
  "public.ecr.aws/docker/library/golang:1.25-alpine",
]);
const TALOS_KUBERNETES_IMAGE_SOURCES = new Set([
  "ghcr.io/siderolabs/kubelet:v1.36.2",
  "registry.k8s.io/kube-apiserver:v1.36.2",
  "registry.k8s.io/kube-controller-manager:v1.36.2",
  "registry.k8s.io/kube-scheduler:v1.36.2",
]);
const REVIEWED_MISE_LOCK = join(CONTENT_LOCK_ROOT, "mise.lock");
const sourceRoot = resolve(process.argv[2] ?? "");
const outputRoot = resolve(process.argv[3] ?? ".work/workshops/platform-engineering");

if (!process.argv[2]) {
  throw new Error(
    "usage: bun tools/workshops/platform-engineering/generate.ts /path/to/pinned/source [output]",
  );
}
if (existsSync(outputRoot)) {
  throw new Error(
    `${outputRoot} already exists; move it aside before regenerating the pinned import`,
  );
}

assertPinnedSource(sourceRoot, sourceLock);
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
  return replaceRuntimeImageReferences(
    adaptDirectCloudLearnerRuntimeNarrative(
      adaptWorkspaceAppNarrative(
        adaptExternalRuntimeNarrative(
          value
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
            .concat("\n"),
        ),
      ),
    ),
  );
}

function adaptExternalRuntimeNarrative(value: string): string {
  return value
    .replace(
      /\*\*VictoriaLogs\*\* \(Loki API\)/g,
      "**VictoriaLogs** (LogsQL through its native datasource)",
    )
    .replace(
      /fronted by \*\*Grafana\*\* with \*built-in\* datasources — no plugins to fetch, so it stays offline\./g,
      "fronted by **Grafana** with built-in Prometheus and Jaeger datasources plus a checksum-pinned signed VictoriaLogs plugin.",
    )
    .replace(
      /Grafana wiring them as Prometheus\/Loki\/Jaeger datasources/g,
      "Grafana wiring them as Prometheus/native VictoriaLogs/Jaeger datasources",
    )
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
      "Learner servers pull only declared manifests by digest over provider egress; no OCI layer ships inside the checkpoint bundle.",
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

function adaptWorkspaceAppNarrative(value: string): string {
  return value
    .replace(
      /Gitea: http:\/\/localhost:30300 — log in as/g,
      "Gitea: under **Workspace applications** in the Intar workshop room, open **Gitea** and log in as",
    )
    .replace(
      /ArgoCD: http:\/\/localhost:30080 — username/g,
      "Argo CD: from the same **Workspace applications** list, open **Argo CD**; username",
    )
    .replace(
      /front door: the \*\*Cloudbox Console\*\* at\nhttp:\/\/localhost:30600, showing/g,
      "front door: the **Cloudbox Console**. Open it under **Workspace applications** in\nthe Intar workshop room; it shows",
    )
    .replace(
      /Open \*\*http:\/\/localhost:30600\*\* and explore/g,
      "Under **Workspace applications** in the Intar workshop room, open **Cloudbox Console** and explore",
    )
    .replace(
      /open \*\*http:\/\/localhost:30600\/gallery\*\* and upload any JPEG\/PNG/g,
      "under **Workspace applications** in the Intar workshop room, open **Cloudbox Console**, go to **Gallery**, and upload any JPEG/PNG",
    )
    .replace(
      /in Grafana at \*\*http:\/\/localhost:30030\*\* → Explore/g,
      "in **Grafana** under **Workspace applications** in the Intar workshop room → Explore",
    )
    .replace(
      /Then open Grafana at \*\*http:\/\/localhost:30030\*\* \(NodePort — no port-forward needed\) →/g,
      "Then open **Grafana** under **Workspace applications** in the Intar workshop room →",
    )
    .replace(
      /^open http:\/\/localhost:30600\s+# explore, then: Databases → New database\n\s+# name: console-db, size: small → Create$/gm,
      "# In the Intar workshop room: Workspace applications → Cloudbox Console → Databases\n# New database → name: console-db, size: small → Create",
    )
    .replace(
      /^# → http:\/\/localhost:30600\/gallery — upload a photo, watch 0 → 1 → 0 twice$/gm,
      "# In Intar: Workspace applications → Cloudbox Console → Gallery; upload a photo and watch 0 → 1 → 0 twice",
    )
    .replace(
      /^# enable portal\.yaml → open http:\/\/localhost:30600$/gm,
      "# enable portal.yaml → in Intar, open Workspace applications → Cloudbox Console",
    )
    .replace(
      /In the lab they'll poke both UIs: Gitea at localhost:30300 \(gitea_admin \/ cloudbox123\), ArgoCD at localhost:30080 \(admin, password fetched from the cluster — that's hint 1\)\./g,
      "In the lab they'll open Gitea (gitea_admin / cloudbox123) and Argo CD (admin, password fetched from the cluster — that's hint 1) under Workspace applications in the Intar room.",
    )
    .replace(
      /find the upload's trace in Grafana at http:\/\/localhost:30030 → Explore/g,
      "open Grafana under Workspace applications in the Intar room and find the upload's trace under Explore",
    )
    .replace(
      /upload at localhost:30600\/gallery/g,
      "open Cloudbox Console under Workspace applications in the Intar room and upload in Gallery",
    )
    .replace(
      /The loop to show: guest sign-in at :30700 → catalog entities fed from Gitea → run a software template → chase the result through Gitea \(:30300, a new repo appeared\) → ArgoCD \(:30080, a new Application\) → pods running\./g,
      "Use the bundled screenshots to trace Backstage's conceptual loop: catalog entity → software template → new Gitea repository → ArgoCD Application → running workload. Backstage is not a declared Intar workspace application in this revision.",
    )
    .replace(
      `# Your progress, live

- Cloudbox Console → **Workshop** page
- One row per module, inferred from cluster
- It reads live state — no self-reporting
- \`http://localhost:30600/workshop\` (after module 02)
`,
      `# Your progress, live

- Intar workshop room → **Agenda** → **Live verification**
- One row per module, combining verifier results and live probe health
- Verification latches; later regressions remain visible
- Available from lobby check-in through the archived session
`,
    )
    .replace(
      /Once the platform's portal is running \(it arrives via the catalog; you'll meet it properly in module 08\), its Workshop page shows a checklist of all ten modules — each row inferred from your live cluster state: nodes ready, kube-proxy absent, Gitea healthy, a CNPG cluster in demo, WorkshopDatabases present, thumbnails in the images bucket, and so on\.\n\nTwo honest caveats to mention: it's a hint, not a judge — verify\.sh in each lab folder is the authoritative check; and module 05 \(fault-fixing\) can't be inferred from end-state at all\./g,
      "In the Intar workshop room, **Agenda** includes **Live verification** for every module. It shows technical verification separately from current probe health, caught-up state, and explain-back. Verification latches once achieved, while a later regression remains visible instead of erasing completion.\n\nThe manual `verify.sh` in each lab folder remains useful for detailed diagnostics; Intar records the named deterministic probe result as the session progress contract.",
    );
}

function adaptDirectCloudLearnerRuntimeNarrative(value: string): string {
  const awsCliImage = imageMappings.get(
    "public.ecr.aws/aws-cli/aws-cli:2.27.49",
  );
  if (!awsCliImage) {
    throw new Error("AWS CLI image is missing from the reviewed runtime image lock");
  }
  return value
    .replace(
      /called \*\*cloudbox\*\* runs on your\nlaptop:/g,
      "called **cloudbox** runs inside your dedicated Intar\nlearner VM:",
    )
    .replace(
      /it fits in Docker on your laptop\./g,
      "it runs as Docker containers inside that learner VM.",
    )
    .replace(
      /…on a laptopthe thinnest viable one/g,
      "…on one learner VM — the thinnest viable one",
    )
    .replace(
      /Cilium tradeoff to name honestly: eBPF wants a modern kernel — Docker Desktop macOS ships 6\.10, WSL2 6\.6, both fine; the risk platform is exotic Linux firewalld\/nftables setups\. We keep kube-proxy-free for the wow factor but the fallback keeps kube-proxy to remove a nested-cgroup variable — robustness vs\. wow is a real dial here\./g,
      "Cilium tradeoff to name honestly: eBPF and Talos-in-Docker need the dedicated Debian 13 guest kernel to expose the required nesting, cgroup, and BPF capabilities. Publication cold-boots every checkpoint on the pinned provider type; a kernel mismatch blocks the revision instead of silently switching to a kind fallback.",
    )
    .replace(
      `The cluster is cattle: \`./scripts/destroy-cluster.sh && ./scripts/create-cluster.sh\` is
always safe and takes ~5 minutes (images are already local). If Talos-in-Docker fights
your machine specifically, \`./scripts/kind-fallback.sh\` gives you a kind+Cilium cluster —
you lose the Talos exploration but every later module works the same.`,
      `The Talos cluster is cattle: \`./scripts/destroy-cluster.sh && ./scripts/create-cluster.sh\`
recreates it from the pinned configuration. Re-creation may need the declared external
registries. If Talos-in-Docker or the guest kernel misbehaves, use **Need help** in Intar;
the facilitator can restore the canonical checkpoint instead of switching runtimes.`,
    )
    .replace(
      `This is the safety net, not the plan — the prework email asked everyone to do this at home. The next 15 minutes exist for those who didn't, and for machines that changed since.`,
      "The lobby gate is part of the plan: each checked-in learner receives a dedicated Intar workspace. Use these 15 minutes to prove that checkpoint 00 finished and the pinned runtime is healthy before the core workshop starts.",
    )
    .replace(
      `While the room runs checks, the presenters circulate. Anyone whose laptop fundamentally can't run it goes straight to a lifeboat (pair up, or devcontainer/Codespaces) — do NOT let anyone burn 45 minutes fighting their Docker install.`,
      "While Intar provisions and checks the learner VMs, presenters watch the roster and help queue. A failed workspace is a provider or bootstrap problem: inspect its named probes, then restore checkpoint 00 or recreate it through Intar instead of repairing it manually.",
    )
    .replace(
      `The digest-pinned rule isn't just conference pragmatism — it's the first platform-engineering lesson of the day. If your platform can't stand up without reaching the internet, it isn't your platform; it's a client of someone else's.`,
      "The digest-pinned rule is the first platform-engineering lesson of the day: external dependencies must be explicit, immutable, and observable. Digest pins prevent tag drift; they do not pretend DNS, TLS, registries, or provider egress have disappeared.",
    )
    .replace(
      `Concretely: the Intar checkpoint bootstrap validates every pinned image against its external registry; the git server will live in-cluster; ArgoCD never points at GitHub. Once images are pulled, the whole workshop works in airplane mode.`,
      "Concretely: the Intar checkpoint bootstrap validates every pinned image against its external registry; the git server then lives in-cluster and Argo CD never points at GitHub. Uncached or restored generations still require working registry egress, and the browser session still requires Intar connectivity.",
    )
    .replace(
      `Hardware honesty, one more time: 16 GB RAM minimum with at least 10 GB allocatable to Docker; 32 GB is comfortable. The full platform idles around 8 GB inside the cluster. On 16 GB machines: close the Electron zoo. macOS: OrbStack or Docker Desktop with a raised memory limit. WSL2: raise it in .wslconfig — and WSL2 is our least-tested platform, so lifeboats apply.`,
      "Capacity honesty: this revision offers one exact VM per learner: Hetzner CPX42 with 16 GiB RAM and a 160 GiB system disk, exceeding the workshop's 32 GiB disk requirement. That leaves headroom for the roughly 7.5–8 GiB in-cluster workload plus Talos, Docker, and the operating system. Intar blocks provisioning if the pinned profile, price, quota, or required location is unavailable; it never resizes or substitutes the profile silently. A later immutable revision can add a separately certified GCP profile.",
    )
    .replace(
      `Set the timer visibly. The task: run the pre-flight, fix what it flags (most common: Docker not running, or Docker memory limit below 10 GB), and run the module's verify.sh.`,
      "Set the timer visibly. The task: check in, wait for the Intar workspace to become ready, open its terminal, and run the module verifier. Treat Docker, resource, registry, or agent failures as provisioning failures.",
    )
    .replace(
      /Already green because you did the prework\? Perfect — you have 15 minutes of head start:/g,
      "Already green when the lobby opens? Perfect — use the remaining preflight time to",
    )
    .replace(
      `Triage guidance for presenters/helpers: image pulls not done is the only unfixable-in-room problem (bandwidth) — those people pair up or go to Codespaces immediately. Everything else (memory limits, missing tools) is a 2-minute fix.`,
      "Triage guidance for presenters/helpers: use the facilitator roster, named probe state, and help queue. Registry, quota, location, guest-kernel, or bootstrap failures belong in the Intar recovery path; do not move learners to an untracked runtime.",
    )
    .replace(
      `When ~90% of the room is green, move on — stragglers keep pulling in the background and module 01 doesn't need the images immediately.`,
      "Move on only when the facilitator preflight shows enough ready seats for the room. Keep late workspaces visible in the lobby and use checkpoint recovery for learners who join after the release.",
    )
    .replace(
      `# You leave with Bruktby's cloud —
and it's **yours**

Still running tomorrow. No account. No bill. No permission.`,
      `# You build Bruktby's cloud —
inside your **own workspace**

Dedicated learner VM. Your connected cloud project. Measured cost. Verified teardown.`,
    )
    .replace(
      /"At the end of these four hours, your laptop is running the complete cloud platform Bruktby moved to — Kubernetes, GitOps, a managed database, S3-compatible storage, a self-service API, serverless, a portal — with their photo pipeline live on top of it\. And when you close the lid and go home, it's still yours\. No trial account, no free tier, no vendor\."/g,
      '"During these four hours, each dedicated learner VM runs the complete cloud platform Bruktby moved to — Kubernetes, GitOps, a managed database, S3-compatible storage, a self-service API, serverless, a portal — with their photo pipeline live on top. Intar tracks the provider estimate and deletes every learner resource when the session ends."',
    )
    .replace(
      `-  green sticky — "I'm fine"
-  red sticky — "come by, please"
- Helpers roam; no hand-raising needed
- Pairing is encouraged — arguably better
- Laptop says no? Devcontainer lifeboat`,
      `- Intar check-in shows that you're present
- **Need help** puts you in the facilitator queue
- You decide whether to grant browser-terminal assistance
- Pairing and explain-backs are encouraged
- Provisioning failure? Restore or recreate through Intar`,
    )
    .replace(
      /The sticky-note protocol means nobody sits blocked with a hand in the air: red sticky up, keep poking at something else, a helper finds you\./g,
      "The Intar help queue means nobody sits blocked with a hand in the air: choose **Need help**, keep investigating, and a helper can claim the request.",
    )
    .replace(
      /Pairing: the whole workshop works as a pair on one machine — you'll talk through more and type less\. If your pre-flight fails, pair up or use the devcontainer: the repo ships a \.devcontainer that runs identical content in GitHub Codespaces \(4 cores \/ 16 GB machine\)\. Acknowledge the irony out loud — the lifeboat for the sovereignty workshop is Microsoft's cloud, which is exactly why it's the lifeboat and not the boat\./g,
      "Pairing is encouraged for discussion, but every enrolled participant keeps an independently tracked Intar workspace. If preflight fails, use the provider recovery path so progress, cost, routes, and teardown remain auditable.",
    )
    .replace(
      `# GO — Module 00

**Outcome:** your laptop is provably ready.`,
      `# GO — Module 00

**Outcome:** your dedicated Intar workspace is provably ready.`,
    )
    .replace(
      /15 min · red sticky if anything is/g,
      "15 min · choose **Need help** if anything is",
    )
    .replace(
      `    **Fits a 16 GB laptop**

    In-cluster total ≈ 7.5–8 GB; ≥10 GB to Docker. Every pick optimises for this ceiling.
    the constraint that shaped the whole stack`,
      `    **Fits one 16 GiB learner VM**

    In-cluster total ≈ 7.5–8 GiB, leaving headroom for Talos, Docker, and Debian.
    the 4 vCPU / 16 GiB runtime constraint that shaped the whole stack`,
    )
    .replace(
      /scripts\/images\.txt · check-consistency\.sh enforces it/g,
      "runtime/images.lock · Intar publish validation enforces it",
    )
    .replace(
      `    **docker** Your laptop · Docker — still yours when the lid closes`,
      "    **docker** Your learner VM · Docker — live until verified teardown",
    )
    .replace(
      /The same diagram from the first ten minutes — but now every box on it is running on the laptops in this room\./g,
      "The same diagram from the first ten minutes — but now every box is running inside the dedicated learner VMs for this session.",
    )
    .replace(
      /Then the sovereignty callback: no account was created today\. No bill will arrive\. Nothing phones home\. When the laptop lid closes, the cloud goes to sleep — and it wakes up still yours\./g,
      "Then the ownership callback: the learner VM is billed directly to the organization's selected BYOK cloud project. Intar shows a native-currency provider estimate rather than an invoice, external digest pulls are explicit, and session teardown must leave zero instances, disks, addresses, routes, keys, grants, operations, or slots.",
    )
    .replace(
      /\*\*Your laptop\. Your cloud\. Your terms\.\*\*/g,
      "**Every layer understood. Your platform. Your terms.**",
    )
    .replace(
      /"The cluster on your laptop is not a demo — it's yours\. Keep it\. Break it\. Rebuild it with catch-up\."/g,
      '"The platform you built is not a slideware demo. Break it, explain it, and rebuild it from a canonical checkpoint while the session is live."',
    )
    .replace(
      /when you run this at home/g,
      "when you build from the source in your own environment",
    )
    .replace(
      /Presenter prep during this break: pre-enable backstage\.yaml from the catalog on the projector cluster NOW — its first boot is slow \(~2 GB image \+ a CNPG database\) and module 08's demo needs it warm\./g,
      "Presenter prep during this break: keep Backstage disabled. Module 08 uses bundled screenshots for the comparison because Backstage is not a declared Intar workspace application in this revision.",
    )
    .replace(
      /Next slide: we look at Backstage live, so this isn't a straw man\./g,
      "Next slide: use the bundled Backstage screenshots to make the comparison concrete without provisioning an undeclared application.",
    )
    .replace(
      /Presenter demo, ~5 minutes, on the projector cluster \(backstage\.yaml was pre-enabled during the second break — first boot is slow: ~2 GB CNOE image plus a CNPG database, which is precisely why this is a demo and not the hands-on\)\./g,
      "Facilitator comparison, ~5 minutes, using the bundled Backstage screenshots. Do not enable backstage.yaml in the hosted session: it has no declared Intar workspace route.",
    )
    .replace(
      /backstage\.yaml stays in the catalog — anyone with RAM to spare can run this exact loop at home\. That's the fair test of the build-vs-buy slide\./g,
      "Keep backstage.yaml disabled in hosted sessions. The pinned source remains available for a separately sized, explicitly routed workshop revision.",
    )
    .replace(
      `# Interlude: Backstage, live

Presenter demo · ~5 min · watch the projector

- Catalog → template → new Gitea repo
- → ArgoCD app → running pods
- The template's glue is the real work
- \`backstage.yaml\` stays in the catalog — try at home`,
      `# Interlude: Backstage, unpacked

Facilitator comparison · ~5 min · bundled screenshots

- Catalog → template → new Gitea repo
- → Argo CD app → running pods
- The template's glue is the real work
- Source retained; hosted runtime intentionally disabled`,
    )
    .replace(
      /Later, in module 08, they'll see Backstage's software templates doing a fancier version of exactly this\./g,
      "Later, module 08 uses bundled Backstage screenshots to compare its software-template model with this loop.",
    )
    .replace(
      `We'll keep it on the projector between modules as the room's shared progress board. It's also a nice teaser: the page itself is ~100 lines of Go reading the Kubernetes API — you'll read its source in module 08.

Now — let's make sure everyone's laptop is ready. Module 00.`,
      "Keep the synchronized Intar projector view visible between modules. Now use the lobby preflight to make sure every checked-in learner workspace is ready for module 00.",
    )
    .replace(
      /Every hop of git → build → push → deploy happens inside the laptop's cluster — zero external services\./g,
      "Every git → build → push → deploy hop stays inside the learner VM. External registries supply only the digest-pinned base images declared by the revision.",
    )
    .replace(
      /Zero external services touched — git, build, registry, deploy all happen on your\nlaptop's cloud\./g,
      "Git, build, the learner registry, and deployment all stay inside the learner VM; only declared digest-pinned base images come from external registries.",
    )
    .replace(
      /the whole build-and-ship pipeline, running inside your own cluster with zero external services\./g,
      "the whole build-and-ship data path running inside your own cluster, with declared base-image pulls from external registries.",
    )
    .replace(
      /Zero external services touched — git, build, registry, deploy all happen on your/g,
      "The build-and-deploy data path stays inside your",
    )
    .replace(
      / — zero external services\./g,
      "; the build-and-deploy data path stays inside the learner VM.",
    )
    .replace(
      /with zero external services\./g,
      "with its build-and-deploy data path inside the learner VM.",
    )
    .replace(
      /The platform does not depend on GitHub, on the venue WiFi, or on anyone's SaaS\./g,
      "The platform's Git state does not depend on GitHub or another hosted Git SaaS.",
    )
    .replace(
      /Your platform does not depend on GitHub, on the venue WiFi, or on anyone's SaaS\./g,
      "The platform's Git state does not depend on GitHub or another hosted Git SaaS.",
    )
    .replace(
      /your platform doesn't depend on GitHub, on the venue WiFi,\nor on anyone's SaaS\./g,
      "the GitOps loop does not depend on GitHub or a hosted Git SaaS; Intar connectivity\nand registry egress remain explicit.",
    )
    .replace(
      /nothing tied to GitHub or the venue WiFi/g,
      "nothing tied to a hosted Git SaaS",
    )
    .replace(
      /It also means the workshop survives conference WiFi\./g,
      "Registry egress and the Intar browser control plane remain explicit external dependencies.",
    )
    .replace(
      /Nothing depends on GitHub or the venue WiFi\./g,
      "The GitOps loop does not depend on GitHub; Intar connectivity and registry egress remain explicit.",
    )
    .replace(
      /generate a \*\*presigned URL\*\*\. Open it in your browser\. That URL is you handing a\n\s+download link to someone with zero AWS involved\./g,
      "generate a **presigned URL**, save it, and prove it with `curl --fail` from the same\n   learner terminal. The S3 API NodePort is guest-local and intentionally not exposed as a\n   workspace application. In the browser, open **RustFS** under **Workspace applications**\n   to inspect the bucket and object.",
    )
    .replace(
      `aws --endpoint-url http://localhost:30900 s3 presign s3://app-assets/hello.txt --expires-in 3600
# open the printed URL in your browser`,
      `PRESIGNED_URL="$(aws --endpoint-url http://localhost:30900 s3 presign s3://app-assets/hello.txt --expires-in 3600)"
curl --fail --show-error "$PRESIGNED_URL"
# Browser proof uses Workspace applications → RustFS; the S3 API URL is guest-local.`,
    )
    .replace(
      `export AWS_ACCESS_KEY_ID=cloudbox AWS_SECRET_ACCESS_KEY=cloudbox123 AWS_REGION=us-east-1
aws --endpoint-url http://localhost:30900 s3 mb s3://app-assets
echo "hello from my own cloud" > /tmp/hello.txt
aws --endpoint-url http://localhost:30900 s3 cp /tmp/hello.txt s3://app-assets/
PRESIGNED_URL="$(aws --endpoint-url http://localhost:30900 s3 presign s3://app-assets/hello.txt --expires-in 3600)"
curl --fail --show-error "$PRESIGNED_URL"
# Browser proof uses Workspace applications → RustFS; the S3 API URL is guest-local.`,
      `aws_s3() {
  docker run --rm --network host -i \\
    -e AWS_ACCESS_KEY_ID=cloudbox \\
    -e AWS_SECRET_ACCESS_KEY=cloudbox123 \\
    -e AWS_REGION=us-east-1 \\
    ${awsCliImage} \\
    --endpoint-url http://localhost:30900 "$@"
}
aws_s3 s3 mb s3://app-assets 2>/dev/null || true
printf 'hello from my own cloud\\n' | aws_s3 s3 cp - s3://app-assets/hello.txt
PRESIGNED_URL="$(aws_s3 s3 presign s3://app-assets/hello.txt --expires-in 3600)"
curl --fail --show-error "$PRESIGNED_URL"
# Browser proof uses Workspace applications → RustFS; the S3 API URL is guest-local.`,
    )
    .replace(
      /Same story for object storage: S3 is an API, and RustFS implements it — buckets, multipart, presigned URLs\. In the lab they'll create a bucket, upload a file, and generate a presigned URL that works in their browser: handing someone a download link with zero AWS involved\./g,
      "Same story for object storage: S3 is an API, and RustFS implements it — buckets, multipart, presigned URLs. In the lab they create a bucket and upload a file, then verify a guest-local presigned URL with `curl` in the learner terminal. Browser inspection uses the separately authorized **RustFS** workspace application.",
    )
    .replace(
      /3\. RustFS speaks S3 on NodePort 30900 \(access key cloudbox \/ secret cloudbox123\): create a bucket, upload a file, generate a presigned URL, open it in the browser\./g,
      "3. RustFS speaks S3 on guest-local NodePort 30900 (access key cloudbox / secret cloudbox123): create a bucket, upload a file, generate a presigned URL, and verify it with `curl` in the learner terminal. Use **Workspace applications → RustFS** for browser inspection.",
    )
    .replace(
      /Wins to celebrate: the psql prompt \(module win #1\) and a presigned URL opening in a browser \(win #2 — "you just handed out a download link with zero AWS"\)\./g,
      "Wins to celebrate: the psql prompt (module win #1) and a presigned URL returning the uploaded object inside the learner terminal (win #2). Then use the authorized RustFS application to show that the same object exists in the browser.",
    )
    .replace(
      /Presigned URL failures are usually a clock-skew or wrong-endpoint issue; hints cover both\./g,
      "Presigned URL failures are usually clock-skew or wrong-endpoint issues; the check must run in the learner terminal because port 30900 is guest-local.",
    )
    .replace(
      /\*\*Outcome:\*\* `psql` into your own DBaaS; a presigned URL that works\./g,
      "**Outcome:** `psql` into your own DBaaS; a presigned download verified in the learner terminal.",
    )
    .replace(
      /While people are away, this is a good moment to bring the Cloudbox Console's Workshop page up on the projector — by now most rows for 00–03 should be turning green across the room\.\n\nHelpers: sweep for red stickies during the break; break time is catch-up time for anyone behind, and catch-up\.sh 3 gets them fully current in ~2 minutes\./g,
      "Keep the projector on Intar's synchronized break timer. On the private facilitator screen, open the roster-by-module live-verification view and check modules 00–03 without exposing participant identities.\n\nHelpers: watch Intar's **Need help** queue. Claim unresolved requests and, when a learner needs canonical recovery, use the module-03 catch-up checkpoint through Intar rather than running hidden catch-up material in their terminal.",
    )
    .replace(
      /Presenter demo first \(~5 min\): enable both catalog apps on the projector cluster, submit the build workflow, follow it to Succeeded, then prove the artifact is real by querying Zot's OCI API \(\/v2\/ endpoints on NodePort 30500\) — and run the freshly built image via GitOps\./g,
      "Presenter demo first (~5 min): use a facilitator workspace only when that facilitator is explicitly enrolled with a workspace; otherwise use a consenting participant's shared workspace. Enable both catalog apps, submit the build workflow, follow it to Succeeded, then prove the artifact through Zot's guest-local OCI API and run the freshly built image via GitOps.",
    )
    .replace(
      /Presenter-demo-first module: rootless BuildKit on Talos is pioneer territory \(nobody has published this combo\), so the front of the room shows the golden path, and the lab stays available for the brave and for home\./g,
      "Presenter-demo-first module: rootless BuildKit on Talos is pioneer territory, so the front of the room shows the golden path and the lab remains available in the released stretch pool.",
    )
    .replace(
      /"Your registry\. Your build\. No Docker Hub, no GitHub Actions, no external anything\."/g,
      '"Your registry and your build output stay here. Digest-pinned base images still arrive through the declared external registries."',
    )
    .replace(
      /The task: enable portal\.yaml \(lands in ns portal in seconds — one small Go binary\), explore the Console at :30600, and for each page answer "which Kubernetes API is this\?"/g,
      'The task: enable portal.yaml (lands in ns portal in seconds — one small Go binary), open **Cloudbox Console** under **Workspace applications**, and for each page answer "which Kubernetes API is this?"',
    )
    .replace(
      /Also point out the Workshop page they've been watching all day lives in this same binary \(workshop\.go\) — a checklist inferred from live cluster state, ~100 lines\./g,
      "Open the Console's Workshop page now. It becomes available with module 08 and summarizes live cluster state; compare it with Intar's native verification view used earlier. The page is implemented in `workshop.go` in roughly 100 lines.",
    )
    .replace(
      /the Workshop page you've been watching all day is ~100 of them/g,
      "the Workshop page you will open in module 08 is roughly 100 of them",
    )
    .replace(
      /You'll build a container INSIDE your cluster with Argo Workflows \+ BuildKit and push it to your own Zot registry — no Docker Hub, no cloud build minutes\./g,
      "You'll build a container inside your cluster with Argo Workflows + BuildKit and push it to your own Zot registry. The build runs on the learner VM and pulls only the revision's digest-pinned external base images.",
    )
    .replace(
      /Everything on this second table is for the fast 20% and for your couch tonight — it's all public and nothing later depends on it\./g,
      "Everything on this second table is a dependency-aware stretch pool. Nothing later depends on completing every stretch module.",
    )
    .replace(
      /No account\. No bill\. No permission\./g,
      "Dedicated VM. Provider-billed. Deleted at teardown.",
    )
    .replace(
      /\n\s+it — then go run your cloud on your terms\./g,
      "\nStar it — then go run your cloud on your terms.",
    )
    .replace(/\blaptop's\b/gi, "learner VM's")
    .replace(/\blaptops\b/gi, "learner VMs")
    .replace(/\blaptop\b/gi, "learner VM");
}

function adaptTrustedScriptNarrative(
  moduleId: string,
  value: string,
): string {
  if (moduleId === "03") {
    const awsCliImage = imageMappings.get(
      "public.ecr.aws/aws-cli/aws-cli:2.27.49",
    );
    if (!awsCliImage) {
      throw new Error("AWS CLI image is missing from the reviewed runtime image lock");
    }
    const sourceBlock = /# 3\. Bucket \+ object \+ presigned URL\.[\s\S]*?\nfi/u;
    if ((value.match(new RegExp(sourceBlock.source, "gu")) ?? []).length !== 1) {
      throw new Error(
        "module 03 trusted presigned-download anchor changed upstream",
      );
    }
    return value.replace(
      sourceBlock,
      `# 3. Bucket + object + a guest-local presigned download.
aws_s3() {
  docker run --rm --network host -i \\
    -e AWS_ACCESS_KEY_ID=cloudbox \\
    -e AWS_SECRET_ACCESS_KEY=cloudbox123 \\
    -e AWS_REGION=us-east-1 \\
    ${awsCliImage} \\
    --endpoint-url http://localhost:30900 "$@"
}
aws_s3 s3 mb s3://app-assets 2>/dev/null || true
printf 'hello from my own cloud\\n' |
  aws_s3 s3 cp - s3://app-assets/hello.txt
PRESIGNED_URL="$(aws_s3 s3 presign s3://app-assets/hello.txt --expires-in 3600)"
curl --fail --show-error --output /dev/null "$PRESIGNED_URL"
printf 'Presigned object download verified inside the learner VM.\\n'`,
    );
  }
  if (moduleId === "08") {
    return value
      .replace(
        'echo "Cloudbox Console is up: http://localhost:30600"',
        'echo "Cloudbox Console is ready; open it under Workspace applications in the Intar room."',
      )
      .replace(
        'echo "console-db is Ready — see it on http://localhost:30600/databases"',
        'echo "console-db is Ready — see it in Cloudbox Console under Databases."',
      );
  }
  if (moduleId === "09") {
    return value.replace(
      'echo "thumbnail produced after ~${WAITED}s — see http://localhost:30600/gallery"',
      'echo "thumbnail produced after ~${WAITED}s — see it in Cloudbox Console under Gallery."',
    );
  }
  return value;
}

function moduleContent(module: ModuleDefinition, readme: string): string {
  if (module.id === "00") return renderModule00Content();
  let content = sanitizeMarkdown(
    readme.replace(/<details[^>]*>[\s\S]*?<\/details>/gi, ""),
  );
  if (module.id === "08") {
    content = content.replace(
      /> \*\*Presenter demo \(~5 min\):\*\*[\s\S]*?> attendees with RAM to spare can run the same loop at home\.\n/u,
      `> **Facilitator discussion (~5 min):** Compare the readable Cloudbox Console with
> Backstage's catalog and software-template model. Backstage remains source material in
> this workshop revision but is not a declared Intar workspace application, so do not
> enable its optional catalog item during the hosted session. Use the bundled screenshots
> and trace the same template → Gitea → ArgoCD → workload loop conceptually.
`,
    );
  }
  if (module.id !== "10") return content;
  return content
    .replace(
      /## Escalate to the agent:[^\n]*/u,
      "## Optional agent-assisted investigation on a 16 GiB runtime profile",
    )
    .replace(
      /### Enable Kagent and point it at your platform[\s\S]*?(?=### Beat 2:)/u,
      `### Use the hosted-model path

The certified CPX42 profile has 16 GiB RAM, so Intar intentionally omits the
source workshop's host-side Ollama beat. Enable Kagent through the GitOps catalog as described,
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
          body: "This is a provider sizing or guest-runtime failure. The first Platform Engineering production revision requires at least 4 vCPU, 16 GiB RAM, and 32 GiB disk and pins CPX42 for Hetzner sessions. A later immutable revision can add a separately certified GCP profile.",
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
    : adaptTrustedScriptNarrative(
      module.id,
      adaptExternalRuntimeNarrative(
        replaceRuntimeImageReferences(read(`lab/${module.directory}/solve.sh`)),
      ).replaceAll("mise x crane@0.21.7 -- crane", "crane"),
    ).replaceAll("<", "&lt;");
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
  last_failure="$(
    awk '/FAIL:/{ line=$0 } END{ print line }' <<<"${"${output}"}"
  )"
  if [[ -n "\${last_failure}" ]]; then
    last_failure="\${last_failure#*FAIL: }"
    printf 'INTAR_FAIL %.72s\\n' "\${last_failure}" >&2
  fi
fi
exit "${"${status}"}"
`;
}

function renderModule09OutcomePoll(reupload: boolean): string {
  const timeoutSeconds = reupload ? 300 : 60;
  const maxAttempts = reupload ? 60 : 12;
  const trustedReupload = reupload
    ? `  if (( module09_attempt % 6 == 0 )); then
    curl -fsS --max-time 15 --output /dev/null \\
      -F "file=@\${TMP_PNG};type=image/png;filename=solve-test.png" \\
      http://localhost:30600/gallery/upload 2>/dev/null || true
  fi
`
    : "";
  return `module09_trace_ready=0
module09_gallery_ready=0
module09_gallery_hard_failure=0
module09_outcome_status=0
module09_public_host=wa-workshop-probe.intar.app
module09_deadline=$((SECONDS + ${timeoutSeconds}))
module09_gallery_last_state=not_checked

module09_portal_curl() {
  # Cloudbox deliberately gives its RustFS gallery listing 15 seconds. Keep
  # the caller above that bound so it can return a useful fragment instead of
  # being cancelled by the proof harness first.
  curl -sS --max-time 20 \\
    -H "Host: \${module09_public_host}" \\
    -H "X-Forwarded-Host: \${module09_public_host}" \\
    -H 'X-Forwarded-Proto: https' \\
    -H 'X-Forwarded-Port: 443' \\
    "$@"
}

for module09_attempt in $(seq 1 ${maxAttempts}); do
  if (( SECONDS >= module09_deadline )); then
    break
  fi
  if (( module09_trace_ready == 0 )); then
    module09_connected_trace="$(
      curl -fsS --max-time 5 \\
        'http://localhost:30030/api/datasources/proxy/uid/victoriatraces/api/traces?service=cloudbox-portal&limit=20' \\
        2>/dev/null || true
    )"
    if jq -e \\
      'any(.data[]?;
        ([.processes[]?.serviceName] | unique) as $services |
        (["cloudbox-portal", "cloudbox-uploader", "cloudbox-resizer"] -
          $services | length == 0))' \\
      <<<"\${module09_connected_trace}" >/dev/null 2>&1; then
      module09_trace_ready=1
    fi
  fi

  if (( module09_gallery_ready == 0 )); then
    module09_gallery_page="$(
      module09_portal_curl --fail \\
        http://localhost:30600/gallery/grid 2>/dev/null || true
    )"
    if [[ -z "\${module09_gallery_page}" ]]; then
      module09_gallery_last_state='grid request returned no body'
    elif [[ "\${module09_gallery_page}" == *"S3 error:"* ]]; then
      module09_gallery_last_state='grid reported an S3 error'
    else
      module09_gallery_last_state='grid rendered without a canonical object URL'
    fi
    if [[ "\${module09_gallery_page}" == *"localhost:"* ]]; then
      printf 'Cloudbox gallery exposed a localhost URL through the workspace-app route\\n' >&2
      module09_gallery_hard_failure=1
      module09_outcome_status=1
      break
    fi
    module09_gallery_url=$(
      printf '%s\\n' "\${module09_gallery_page}" |
        grep -Eo 'https://wa-workshop-probe\\.intar\\.app/__intar-s3/[^"<[:space:]]+' |
        sed 's/&amp;/\\&/g' |
        sed -n '1p' || true
    )
    if [[ -n "\${module09_gallery_url}" ]]; then
      module09_gallery_last_state='canonical object fetch failed or was empty'
      module09_gallery_path="\${module09_gallery_url#https://wa-workshop-probe.intar.app}"
      module09_gallery_file="$(mktemp)"
      if module09_portal_curl --fail \\
        --output "\${module09_gallery_file}" \\
        "http://localhost:30600\${module09_gallery_path}" \\
        2>/dev/null &&
          [[ -s "\${module09_gallery_file}" ]]; then
        module09_gallery_ready=1
        module09_gallery_last_state=ready
      fi
      rm -f "\${module09_gallery_file}"
    fi
  fi

  if (( module09_trace_ready == 1 && module09_gallery_ready == 1 )); then
    break
  fi
  if (( SECONDS >= module09_deadline )); then
    break
  fi
${trustedReupload}  if (( SECONDS >= module09_deadline )); then
    break
  fi
  sleep 5
done

if (( module09_trace_ready == 0 && module09_gallery_hard_failure == 0 )); then
  printf 'module 09 connected upload trace did not converge within ${timeoutSeconds}s\\n' >&2
  module09_outcome_status=1
fi
if (( module09_gallery_ready == 0 && module09_gallery_hard_failure == 0 )); then
  printf 'Cloudbox gallery did not converge on a non-empty canonical /__intar-s3/ object within ${timeoutSeconds}s (%s)\\n' \\
    "\${module09_gallery_last_state}" >&2
  module09_outcome_status=1
fi
`;
}

function renderWorkspaceAppProbe(moduleId: string): string {
  const awsCliImage = imageMappings.get(
    "public.ecr.aws/aws-cli/aws-cli:2.27.49",
  );
  if (!awsCliImage) {
    throw new Error("AWS CLI image is missing from the reviewed runtime image lock");
  }
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
  rustfs_aws() {
    docker run --rm --network host -i \\
      -e AWS_ACCESS_KEY_ID=cloudbox \\
      -e AWS_SECRET_ACCESS_KEY=cloudbox123 \\
      -e AWS_REGION=us-east-1 \\
      -e AWS_PAGER= \\
      "${awsCliImage}" \\
      --endpoint-url http://localhost:30900 "$@"
  }

  if ! rustfs_object_key="$(rustfs_aws s3api list-objects-v2 \\
    --bucket app-assets \\
    --max-items 1 \\
    --query 'Contents[0].Key' \\
    --output text)"; then
    printf 'RustFS could not list an object for presigned-download verification\\n' >&2
    status=1
  elif [[ -z "\${rustfs_object_key}" ||
          "\${rustfs_object_key}" == "None" ||
          "\${rustfs_object_key}" == *$'\\n'* ]]; then
    printf 'RustFS returned no deterministic object key for presigned-download verification\\n' >&2
    status=1
  elif ! rustfs_presigned_url="$(rustfs_aws s3 presign \\
    "s3://app-assets/\${rustfs_object_key}" \\
    --expires-in 300)"; then
    printf 'RustFS could not generate a presigned download URL\\n' >&2
    status=1
  elif [[ "\${rustfs_presigned_url}" != http://localhost:30900/* ||
          "\${rustfs_presigned_url}" == *" "* ||
          "\${rustfs_presigned_url}" == *$'\\t'* ||
          "\${rustfs_presigned_url}" == *$'\\n'* ]]; then
    printf 'RustFS generated an unsafe or non-local presigned URL\\n' >&2
    status=1
  elif ! curl -fsS --max-time 15 --output /dev/null \\
    "\${rustfs_presigned_url}"; then
    printf 'RustFS presigned download failed inside the learner VM\\n' >&2
    status=1
  fi
fi

if (( status == 0 )); then
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
        -H 'User-Agent: Mozilla/5.0 (compatible; Intar-Workspace-App-Probe/1.0)' \\
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
    case "08":
      return `if (( status == 0 )); then
  public_host=wa-workshop-probe.intar.app

  portal_workspace_app_curl() {
    curl -sS --max-time 15 \\
      -H "Host: \${public_host}" \\
      -H "X-Forwarded-Host: \${public_host}" \\
      -H 'X-Forwarded-Proto: https' \\
      -H 'X-Forwarded-Port: 443' \\
      "$@"
  }

  if ! portal_status="$(portal_workspace_app_curl \\
    --output /dev/null \\
    --write-out '%{http_code}' \\
    http://localhost:30600/)"; then
    printf 'Cloudbox Console did not answer through the canonical workspace-app Host\\n' >&2
    status=1
  elif [[ "\${portal_status}" != "200" ]]; then
    printf 'Cloudbox Console returned HTTP %s for canonical workspace-app Host %s\\n' \\
      "\${portal_status}" "\${public_host}" >&2
    status=1
  fi

  if (( status == 0 )); then
    invalid_public_host=wa-workshop-probe.intar.app.attacker.invalid
    if ! invalid_host_status="$(curl -sS --max-time 15 \\
      --output /dev/null \\
      --write-out '%{http_code}' \\
      -H "Host: \${invalid_public_host}" \\
      -H "X-Forwarded-Host: \${public_host}" \\
      -H 'X-Forwarded-Proto: https' \\
      -H 'X-Forwarded-Port: 443' \\
      http://localhost:30600/)"; then
      printf 'Cloudbox Console invalid-Host probe did not complete\\n' >&2
      status=1
    elif [[ "\${invalid_host_status}" != "400" ]]; then
      printf 'Cloudbox Console accepted invalid Host %s with HTTP %s\\n' \\
        "\${invalid_public_host}" "\${invalid_host_status}" >&2
      status=1
    fi
  fi

  if (( status == 0 )); then
    if ! s3_put_status="$(portal_workspace_app_curl \\
      --output /dev/null \\
      --write-out '%{http_code}' \\
      -X PUT \\
      http://localhost:30600/__intar-s3/probe)"; then
      printf 'Cloudbox S3 unsafe-method probe did not complete\\n' >&2
      status=1
    elif [[ "\${s3_put_status}" != "405" ]]; then
      printf 'Cloudbox same-origin S3 adapter accepted PUT (HTTP %s)\\n' \\
        "\${s3_put_status}" >&2
      status=1
    fi
  fi

  if (( status == 0 )); then
    if ! s3_head_status="$(portal_workspace_app_curl \\
      --head \\
      --output /dev/null \\
      --write-out '%{http_code}' \\
      http://localhost:30600/__intar-s3/app-assets/hello.txt)"; then
      printf 'Cloudbox S3 HEAD probe did not reach the workspace-app adapter\\n' >&2
      status=1
    elif [[ "\${s3_head_status}" != 2* &&
            "\${s3_head_status}" != "403" ]]; then
      printf 'Cloudbox S3 HEAD path returned HTTP %s instead of RustFS 2xx/403\\n' \\
        "\${s3_head_status}" >&2
      status=1
    fi
  fi

  if (( status == 0 )); then
    if ! grafana_launcher="$(portal_workspace_app_curl \\
      --fail \\
      http://localhost:30600/__intar-grafana)"; then
      printf 'Cloudbox Grafana launcher did not answer through the workspace-app adapter\\n' >&2
      status=1
    elif [[ "\${grafana_launcher}" != *"Workspace applications"* ||
            "\${grafana_launcher}" != *"Grafana"* ||
            "\${grafana_launcher}" == *"localhost"* ]]; then
      printf 'Cloudbox Grafana launcher did not provide safe Intar navigation\\n' >&2
      status=1
    fi
  fi
fi
`;
    case "09":
      return `if (( status == 0 )); then
  observability_status=0

  for app in victoria-metrics victoria-logs victoria-traces grafana otel-collector; do
    app_state=
    for attempt in $(seq 1 36); do
      app_state="$(kubectl -n argocd get application "\${app}" \\
        -o jsonpath='{.status.sync.status} {.status.health.status}' 2>/dev/null || true)"
      if [[ "\${app_state##* }" == "Healthy" ]]; then
        break
      fi
      if [[ -z "\${app_state}" && "\${attempt}" -ge 2 ]]; then
        break
      fi
      sleep 5
    done
    if [[ "\${app_state##* }" != "Healthy" ]]; then
      printf 'observability app %s is not Healthy (state: %s)\\n' \\
        "\${app}" "\${app_state:-missing}" >&2
      observability_status=1
    fi
  done

  for workload in \\
    deployment/victoria-metrics \\
    deployment/victoria-logs \\
    deployment/victoria-traces \\
    deployment/grafana \\
    deployment/otel-collector-gateway \\
    daemonset/otel-collector-agent; do
    if ! kubectl -n observability rollout status "\${workload}" \\
      --timeout=180s >/dev/null 2>&1; then
      printf 'observability workload %s is not ready\\n' "\${workload}" >&2
      observability_status=1
    fi
  done

  for backend in victoria-metrics victoria-logs victoria-traces; do
    if ! kubectl get --request-timeout=15s \\
      --raw="/api/v1/namespaces/observability/services/\${backend}:http/proxy/health" \\
      >/dev/null 2>&1; then
      printf 'observability backend %s did not pass its service health check\\n' \\
        "\${backend}" >&2
      observability_status=1
    fi
  done

  grafana_node_port="$(
    kubectl -n observability get service grafana-nodeport \\
      -o jsonpath='{.spec.ports[?(@.name=="http")].nodePort}' 2>/dev/null || true
  )"
  if [[ "\${grafana_node_port}" != "30030" ]]; then
    printf 'Grafana NodePort is %s instead of 30030\\n' \\
      "\${grafana_node_port:-missing}" >&2
    observability_status=1
  fi

  if ! grafana_health="$(
    curl -fsS --max-time 15 http://localhost:30030/api/health
  )"; then
    printf 'Grafana did not answer through the declared workspace-app port 30030\\n' >&2
    observability_status=1
  elif ! jq -e '.database == "ok"' <<<"\${grafana_health}" >/dev/null; then
    printf 'Grafana API health did not report database=ok: %s\\n' \\
      "\${grafana_health}" >&2
    observability_status=1
  fi

  check_grafana_datasource() {
    local name="$1" url="$2" filter="$3" response
    if ! response="$(curl -fsS --max-time 15 "\${url}")"; then
      printf 'Grafana datasource %s is not queryable through the workspace-app port\\n' \\
        "\${name}" >&2
      observability_status=1
    elif ! jq -e "\${filter}" <<<"\${response}" >/dev/null; then
      printf 'Grafana datasource %s returned an unexpected response: %s\\n' \\
        "\${name}" "\${response}" >&2
      observability_status=1
    fi
  }

  check_grafana_datasource \\
    VictoriaMetrics \\
    'http://localhost:30030/api/datasources/proxy/uid/victoriametrics/api/v1/query?query=up' \\
    '.status == "success"'
  check_grafana_datasource \\
    VictoriaLogs \\
    'http://localhost:30030/api/datasources/uid/victorialogs/health' \\
    '((.status // "") | ascii_downcase) == "ok"'

${renderModule09OutcomePoll(false)}
  if (( module09_outcome_status != 0 )); then
    observability_status=1
  fi

  if ! gallery_s3_head_status="$(module09_portal_curl \\
    --head \\
    --output /dev/null \\
    --write-out '%{http_code}' \\
    http://localhost:30600/__intar-s3/app-assets/hello.txt)"; then
    printf 'Cloudbox S3 HEAD probe did not reach the workspace-app adapter\\n' >&2
    observability_status=1
  elif [[ "\${gallery_s3_head_status}" != 2* &&
          "\${gallery_s3_head_status}" != "403" ]]; then
    printf 'Cloudbox S3 HEAD path returned HTTP %s instead of RustFS 2xx/403\\n' \\
      "\${gallery_s3_head_status}" >&2
    observability_status=1
  fi

  if (( observability_status != 0 )); then
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
  if (module.id === "09") {
    script = adaptModule09ObservabilityCatchUp(script);
  }
  if (module.id === "10") {
    script = adaptModule10DayTwoCatchUp(script);
  }
  script = adaptTrustedConditionWaits(module.id, script);
  script = adaptTrustedScriptNarrative(module.id, script);
  if (/\/solutions(?:\/|\b)/u.test(script)) {
    throw new Error(
      `module ${module.id} catch-up still references upstream solutions`,
    );
  }
  return script;
}

function adaptTrustedConditionWaits(moduleId: string, value: string): string {
  let adapted = value;
  const replaceOnce = (
    anchor: string,
    replacement: string,
    label: string,
  ) => {
    const occurrences = adapted.split(anchor).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `module ${moduleId} ${label} anchor occurred ${occurrences} times upstream`,
      );
    }
    adapted = adapted.replace(anchor, () => replacement);
  };

  switch (moduleId) {
    case "01":
      replaceOnce(
        `REPO_ROOT="/opt/platform-engineering-workshop"

# Idempotent:`,
        `REPO_ROOT="/opt/platform-engineering-workshop"
# shellcheck source=../common.sh
source "$REPO_ROOT/lab/common.sh"

# Idempotent:`,
        "common helper",
      );
      replaceOnce(
        "kubectl wait --for=condition=Ready nodes --all --timeout=300s",
        'wait_condition "" nodes Ready 300',
        "all-nodes readiness",
      );
      break;
    case "03":
      replaceOnce(
        "kubectl wait --for=condition=Established crd/clusters.postgresql.cnpg.io --timeout=180s",
        'wait_condition "" crd/clusters.postgresql.cnpg.io Established 180',
        "CNPG CRD readiness",
      );
      replaceOnce(
        "kubectl -n demo wait --for=condition=Ready cluster/app-db --timeout=420s",
        "wait_condition demo cluster/app-db Ready 420",
        "app database readiness",
      );
      break;
    case "04":
      replaceOnce(
        `# platform-api is the app that ships the XRD — wait for ArgoCD to sync it FIRST,
# otherwise \`kubectl wait --for=condition=Established\` below hits the XRD before
# it exists and fails IMMEDIATELY with NotFound (the --timeout only applies once
# the object exists, not while waiting for it to appear). Then poll until the
# API server actually serves the XRD, closing the gap between "ArgoCD applied
# it" and "it's queryable", before waiting on the Established condition.
wait_app platform-api
for _ in $(seq 1 60); do
  kubectl get xrd/workshopdatabases.platform.cloudbox.io >/dev/null 2>&1 && break
  sleep 2
done
kubectl wait --for=condition=Established \\
  xrd/workshopdatabases.platform.cloudbox.io --timeout=180s`,
        `# platform-api is the app that ships the XRD. The null-safe condition
# helper treats both a not-yet-served XRD and an initial null conditions field as
# pending, closing the gap between "ArgoCD applied it" and "it's Established".
wait_app platform-api
wait_condition "" xrd/workshopdatabases.platform.cloudbox.io Established 180`,
        "XRD readiness",
      );
      replaceOnce(
        `kubectl -n demo wait --for=condition=Ready \\
  workshopdatabase/my-db --timeout=600s`,
        "wait_condition demo workshopdatabase/my-db Ready 600",
        "workshop database readiness",
      );
      break;
    case "06":
      replaceOnce(
        "kubectl -n demo wait --for=condition=Ready ksvc/hello --timeout=300s",
        "wait_condition demo ksvc/hello Ready 300",
        "Knative service readiness",
      );
      break;
    case "08":
      replaceOnce(
        "kubectl -n demo wait --for=condition=Ready workshopdatabase/console-db --timeout=600s",
        "wait_condition demo workshopdatabase/console-db Ready 600",
        "console database readiness",
      );
      break;
    case "09":
      replaceOnce(
        "kubectl -n pipeline wait --for=condition=Ready broker/default --timeout=300s",
        "wait_condition pipeline broker/default Ready 300",
        "broker readiness",
      );
      replaceOnce(
        "kubectl -n pipeline wait --for=condition=Ready ksvc/uploader ksvc/resizer --timeout=300s",
        `wait_condition pipeline ksvc/uploader Ready 300
wait_condition pipeline ksvc/resizer Ready 300`,
        "subscriber readiness",
      );
      replaceOnce(
        "kubectl -n pipeline wait --for=condition=Ready trigger/resize-on-upload --timeout=300s",
        "wait_condition pipeline trigger/resize-on-upload Ready 300",
        "trigger readiness",
      );
      replaceOnce(
        "kubectl -n pipeline wait --for=condition=Complete job/create-images-bucket --timeout=300s",
        "wait_condition pipeline job/create-images-bucket Complete 300",
        "bucket job completion",
      );
      break;
  }

  return adapted;
}

function adaptModule09ObservabilityCatchUp(value: string): string {
  let adapted = value;
  const replaceOnce = (
    anchor: string,
    replacement: string,
    label: string,
  ) => {
    const occurrences = adapted.split(anchor).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `module 09 ${label} anchor occurred ${occurrences} times upstream`,
      );
    }
    adapted = adapted.replace(anchor, () => replacement);
  };

  replaceOnce(
    `# Module 09 — full solution: enable eventing + the picture pipeline, then
# upload a tiny test PNG through the portal (plain curl — the gallery form is
# just a multipart POST) so the outcome check in verify.sh is unconditional.`,
    `# Module 09 — full solution: enable eventing, the picture pipeline, and the
# complete observability capability, then upload a tiny test PNG through the
# portal so the trace and image outcome checks are unconditional.`,
    "description",
  );
  replaceOnce(
    `enable_catalog "$CLONE" knative-serving.yaml portal.yaml knative-eventing.yaml picture-pipeline.yaml
gitops_push "$CLONE" "module 09: knative-eventing + picture pipeline"`,
    `enable_catalog "$CLONE" \\
  knative-serving.yaml portal.yaml knative-eventing.yaml picture-pipeline.yaml \\
  victoria-metrics.yaml victoria-logs.yaml victoria-traces.yaml grafana.yaml \\
  otel-collector.yaml
gitops_push "$CLONE" "module 09: eventing, picture pipeline, and observability"`,
    "catalog push",
  );
  replaceOnce(
    `wait_exists pipeline job/create-images-bucket
kubectl -n pipeline wait --for=condition=Complete job/create-images-bucket --timeout=300s

# Wait for the portal UI (the upload path goes browser → portal → uploader).`,
    `wait_exists pipeline job/create-images-bucket
kubectl -n pipeline wait --for=condition=Complete job/create-images-bucket --timeout=300s

# The three storage backends and Grafana are ArgoCD wave 0. The collector is
# wave 1, so prove the whole first wave before waiting for its two workloads.
wait_app victoria-metrics 600
wait_app victoria-logs 600
wait_app victoria-traces 600
wait_app grafana 600

wait_exists observability service/victoria-metrics 600
wait_exists observability deployment/victoria-metrics 600
kubectl -n observability rollout status deployment/victoria-metrics --timeout=600s
wait_exists observability service/victoria-logs 600
wait_exists observability deployment/victoria-logs 600
kubectl -n observability rollout status deployment/victoria-logs --timeout=600s
wait_exists observability service/victoria-traces 600
wait_exists observability deployment/victoria-traces 600
kubectl -n observability rollout status deployment/victoria-traces --timeout=600s
wait_exists observability service/grafana-nodeport 600
wait_exists observability deployment/grafana 600
kubectl -n observability rollout status deployment/grafana --timeout=600s

wait_app otel-collector 600
wait_exists observability service/otel-collector 600
wait_exists observability deployment/otel-collector-gateway 600
wait_exists observability daemonset/otel-collector-agent 600
kubectl -n observability rollout status deployment/otel-collector-gateway --timeout=600s
kubectl -n observability rollout status daemonset/otel-collector-agent --timeout=600s

# Rollout readiness proves the pod's /api/health probe. Also prove the declared
# browser-facing NodePort before creating the fresh trace used by verification.
WAITED=0
until grafana_health="$(curl -fsS --max-time 5 http://localhost:30030/api/health 2>/dev/null)" &&
      jq -e '.database == "ok"' <<<"$grafana_health" >/dev/null 2>&1; do
  [ "$WAITED" -ge 300 ] && { echo "timed out waiting for Grafana on :30030" >&2; exit 1; }
  sleep 10; WAITED=$((WAITED + 10))
done

# Wait for the portal UI (the upload path goes browser → portal → uploader).`,
    "observability readiness",
  );
  replaceOnce(
    `TMP_PNG="$(mktemp).png"
# shellcheck disable=SC2015  # macOS base64 wants -D on older releases`,
    `TMP_PNG="$(mktemp).png"
trap 'rm -f "$TMP_PNG"' EXIT
# shellcheck disable=SC2015  # macOS base64 wants -D on older releases`,
    "temporary upload cleanup",
  );
  replaceOnce(
    `  http://localhost:30600/gallery/upload
rm -f "$TMP_PNG"

# The resizer scales from zero to process the event — poll S3 for its output.`,
    `  http://localhost:30600/gallery/upload

# The resizer scales from zero to process the event — poll S3 for its output.`,
    "retain upload fixture for convergence retries",
  );
  replaceOnce(
    `echo "thumbnail produced after ~\${WAITED}s — see http://localhost:30600/gallery"`,
    `echo "thumbnail produced after ~\${WAITED}s — see it in Cloudbox Console under Gallery."

# The first upload can beat trace indexing or a freshly ready portal S3 client.
# Re-drive only from this trusted catch-up while polling the exact final
# outcomes. The participant verifier remains side-effect-free.
${renderModule09OutcomePoll(true)}
if (( module09_outcome_status != 0 )); then
  exit 1
fi
rm -f "$TMP_PNG"
trap - EXIT`,
    "trace and gallery convergence",
  );

  return adapted;
}

function adaptModule10DayTwoCatchUp(value: string): string {
  const anchor = `DIR="/opt/platform-engineering-workshop/lab/10-day2-ops"

exec "$DIR/restore.sh" all`;
  const replacement = `DIR="/opt/platform-engineering-workshop/lab/10-day2-ops"
REPO_ROOT="/opt/platform-engineering-workshop"
# shellcheck source=../common.sh
source "$REPO_ROOT/lab/common.sh"

# A normal cumulative run reaches module 10 without injecting a day-two fault.
# Revert any fault that does exist, then make the clean demo-web baseline an
# explicit part of the canonical checkpoint instead of relying on inject.sh's
# learner-only first-run setup path.
"$DIR/restore.sh" all

CLONE="$(gitops_clone)"
TMP_PARENT="$(dirname "$CLONE")"
trap 'rm -rf "$TMP_PARENT"' EXIT
COMPONENT_PATH="gitops/components/demo/demo-web.yaml"
BASELINE_SRC="$DIR/baseline/demo-web.yaml"

mkdir -p "$(dirname "$CLONE/$COMPONENT_PATH")"
# Only the absent baseline is a normal cumulative state. Known injected faults
# were reverted above; preserve any other drift so the verifier reports it.
if [[ ! -f "$CLONE/$COMPONENT_PATH" ]]; then
  cp "$BASELINE_SRC" "$CLONE/$COMPONENT_PATH"
  git -C "$CLONE" add "$COMPONENT_PATH"
  if ! git -C "$CLONE" diff --cached --quiet -- "$COMPONENT_PATH"; then
    git -C "$CLONE" -c user.name="cloudbox" -c user.email="cloudbox@localhost" \\
      commit -q -m "module 10: restore demo-web baseline"
    git -C "$CLONE" push -q origin main
  fi
fi

argocd_refresh demo
wait_exists demo deployment/demo-web 300
kubectl -n demo rollout status deployment/demo-web --timeout=300s`;
  const occurrences = value.split(anchor).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `module 10 cumulative baseline anchor occurred ${occurrences} times upstream`,
    );
  }
  return value.replace(anchor, () => replacement);
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
  format_version = 2
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
    cpu_millis  = 4000
    memory_mib  = 16384
    disk_mib    = 32768
  }

  runtime_profile "hetzner-cpx42" {
    provider      = "hetzner_cloud"
    vm_id         = "learner"
    machine_type  = "cpx42"
    system_image  = "debian-13"
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
port is exposed directly on the learner server.

The upstream custom Grafana image was not publicly pullable while this lock was
created. The direct-cloud adaptation therefore pins stock Grafana, uses its
built-in Prometheus and Jaeger datasources, and installs the signed VictoriaLogs
datasource plugin from its exact release archive after verifying the reviewed
SHA-256 digest. Plugin retrieval fails closed if the archive or digest changes.

The source importer intentionally converts Slidev HTML/Vue presentation syntax
to Intar's finite native Markdown layouts and separates every HTML speaker-note
comment into its corresponding presenter-notes file. The generated deck must
remain exactly 85 slides. CI regenerates the raw import from the pinned commit
and locks both trees plus their explicit Intar-adaptation delta; an intentional
source or adaptation change must update that reviewed lock.
`;
}

function loadImageMappings(): Map<string, string> {
  const lockPath = join(CONTENT_LOCK_ROOT, "images.lock");
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
    if (
      TALOS_KUBERNETES_IMAGE_SOURCES.has(source) &&
      !target.startsWith(`${source}@sha256:`)
    ) {
      throw new Error(
        `Talos Kubernetes image ${source} must retain its version tag before the digest`,
      );
    }
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
        `tag-only upstream image ${line} has no reviewed digest in images.lock`,
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
    /(([a-z0-9][a-z0-9.-]*(?::[0-9]+)?\/[a-z0-9._/-]+):[^@\s"'<>]+)(@sha256:[a-f0-9]{64})/gu,
    (
      reference: string,
      taggedReference: string,
      repository: string,
      digest: string,
    ) => TALOS_KUBERNETES_IMAGE_SOURCES.has(taggedReference)
      ? reference
      : `${repository}${digest}`,
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
  writeText(
    "runtime/source/mise.lock",
    readFileSync(REVIEWED_MISE_LOCK, "utf8"),
  );
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
    `${registries}/[a-z0-9._/-]+(?::[a-z0-9._-]+)?@sha256:[a-f0-9]{64}`,
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
    } else if (relativePath === "lab/common.sh") {
      content = adaptRuntimeLabCommon(content);
    } else if (
      relativePath ===
      "lab/05-debug-with-ai/faults/02-db-stuck/fix.sh"
    ) {
      content = adaptRuntimeCnpgFaultRestore(content);
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
    } else if (
      relativePath ===
      "gitops/components/local-path-provisioner/local-path-storage.yaml"
    ) {
      content = adaptContainerizedTalosLocalStorage(content);
    } else if (relativePath === "scripts/seed-gitea.sh") {
      content = adaptSeedGiteaForSealedCheckpoints(content);
    } else if (relativePath === "lab/07-ci/verify.sh") {
      content = adaptModule07Verifier(content);
    } else if (relativePath === "gitops/components/rustfs/service-nodeport.yaml") {
      content = adaptRustfsWorkspaceAppService(content);
    } else if (relativePath === "gitops/components/portal/portal.yaml") {
      content = adaptPortalWorkspaceAppService(content);
    } else if (
      relativePath ===
      "gitops/components/picture-pipeline/picture-pipeline.yaml"
    ) {
      content = adaptPicturePipelineTelemetry(content);
    } else if (
      relativePath === "gitops/catalog/victoria-logs.yaml" ||
      relativePath === "gitops/components/victoria-logs/victoria-logs.yaml"
    ) {
      content = adaptVictoriaLogsNarrative(relativePath, content);
    } else if (relativePath === "gitops/catalog/grafana.yaml") {
      content = adaptGrafanaCatalog(content);
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
    .replace(/pre-pulled by `the Intar checkpoint bootstrap`/gi, "declared in the signed external image lock")
    .replace(
      /open http:\/\/localhost:30080 or:/g,
      "open Argo CD under Workspace applications in the Intar room or:",
    )
    .replace(
      /check http:\/\/localhost:30080 and the module hints/g,
      "open Argo CD under Workspace applications in the Intar room; consult the module hints",
    )
    .replace(
      /[Cc]heck http:\/\/localhost:30080/g,
      "Open Argo CD under Workspace applications in the Intar room",
    )
    .replace(
      'ok "Gitea answers on http://localhost:30300"',
      'ok "Gitea answers on its declared workspace-app port 30300"',
    )
    .replace(
      /create 'console-db' via the console's New database form \(http:\/\/localhost:30600\/databases\)/g,
      "create 'console-db' from Cloudbox Console's New database form in Intar",
    )
    .replace(
      /upload a photo at http:\/\/localhost:30600\/gallery/g,
      "upload a photo from Cloudbox Console's Gallery in Intar",
    )
    .replace(
      /UI: http:\/\/localhost:30600\./g,
      "UI: declared as the Cloudbox Console workspace application.",
    )
    .replace(
      /Browser: http:\/\/localhost:30030\.?/g,
      "Browser: declared as the Grafana workspace application.",
    )
    .replace(
      /# http:\/\/localhost:30500, in-cluster/g,
      "# Browser UI: declared as the Zot workspace application; in-cluster",
    )
    .replace(
      /UI: http:\/\/localhost:30700/g,
      "not exposed as an Intar workspace application in v1",
    )
    .replace(
      /# browser reaches it without a port-forward: http:\/\/localhost:30030/g,
      "# Intar reaches this declared workspace application without a public guest port",
    )
    .replace(
      /# Enable with:\s+cp gitops\/catalog\/backstage\.yaml gitops\/apps\/ && git add \. && git commit -m 'enable backstage' && git push/g,
      "# Hosted Intar sessions: keep this disabled; no Backstage workspace application route is declared.",
    )
    .replace(
      "# NOTE: this image is linux/amd64 only — Apple Silicon runs it under\n          # emulation (works on Docker Desktop/OrbStack, slower startup).",
      "# NOTE: this image is linux/amd64. The workshop revision requires an\n          # x86 learner runtime, but Backstage remains disabled because no\n          # workspace application route is declared for it.",
    )
    .replace(
      "# all. Generous windows: first boot runs DB migrations and, on\n          # Apple Silicon, amd64 emulation.",
      "# all. Generous windows: first boot runs database migrations.",
    )
    .replace(
      "varied cgroup setups on attendee laptops. ~80% of the 256Mi limit.",
      "fixed learner-VM cgroup contract. ~80% of the 256Mi limit.",
    )
    .replace(
      "This is the pioneer module — red sticky note and we'll dig in together.",
      "This is the pioneer module — open Need help and we'll dig in together.",
    )
    .replace(
      "This is an ephemeral lab sandbox on your own laptop — never do\n# this for anything reachable from a real network.",
      "This is an isolated learner workspace with Intar-authorized routes — never\n# use workshop credentials for production or any independently exposed service.",
    )
    .replace(
      "# on a stable NodePort so attendees can use presigned URLs and S3 clients from\n# the laptop without a port-forward: http://localhost:30900",
      "# on a stable guest-only NodePort. Intar reaches it through SSH direct\n# forwarding; the port is never published from the learner VM.",
    )
    .replace(
      "# A CloudNativePG PostgreSQL cluster, sized for a laptop.",
      "# A CloudNativePG PostgreSQL cluster, sized for the learner VM.",
    )
    .replace(
      "instances: 1            # HA needs 3 — try it at home, your laptop RAM pays here",
      "instances: 1            # Production HA normally needs 3; this workshop uses 1.",
    )
    .replace(
      "# Caps kept small (workshop laptop); this is a sandbox, not production.",
      "# Caps stay small for the workshop learner VM; this is not a production sizing guide.",
    )
    .replace(
      "# NodePort so the `nats` CLI and apps on the laptop can connect without a\n# port-forward: nats://localhost:30422",
      "# guest-only NodePort so in-workspace clients can connect without a\n# kubectl port-forward: nats://localhost:30422",
    )
    .replace(
      "# mise version installed by dev-setup.sh / CI / devcontainer (the mise.run\n# installer honors MISE_VERSION). Keep the devcontainer copy in sync.",
      "# mise version installed by the signed checkpoint bundle and CI. The mise.run\n# installer honors MISE_VERSION; keep the runtime contract in sync.",
    );
}

function adaptPortalWorkspaceAppService(value: string): string {
  let adapted = value;
  const replaceOnce = (
    anchor: string,
    replacement: string,
    label: string,
  ) => {
    const occurrences = adapted.split(anchor).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `portal workspace-app ${label} anchor occurred ${occurrences} times upstream`,
      );
    }
    adapted = adapted.replace(anchor, replacement);
  };

  const namespaceAnchor = `apiVersion: v1
kind: Namespace
metadata:
  name: portal
---`;
  if (adapted.split(namespaceAnchor).length - 1 !== 1) {
    throw new Error(
      "portal workspace-app namespace anchor was not unique upstream",
    );
  }
  const adapterConfig = `apiVersion: v1
kind: ConfigMap
metadata:
  name: portal-workspace-app-adapter
  namespace: portal
data:
  envoy.yaml: |
    static_resources:
      listeners:
        - name: portal
          per_connection_buffer_limit_bytes: 1048576
          address:
            socket_address:
              address: 0.0.0.0
              port_value: 18080
          filter_chains:
            - filters:
                - name: envoy.filters.network.http_connection_manager
                  typed_config:
                    "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
                    stat_prefix: portal_workspace_app
                    normalize_path: false
                    merge_slashes: false
                    path_with_escaped_slashes_action: REJECT_REQUEST
                    route_config:
                      name: portal
                      virtual_hosts:
                        - name: portal
                          domains: ["*"]
                          routes:
                            - match:
                                prefix: /__intar-s3/
                                headers:
                                  - name: ":method"
                                    safe_regex_match:
                                      google_re2: {}
                                      regex: "^(GET|HEAD)$"
                              route:
                                cluster: rustfs
                                prefix_rewrite: /
                                host_rewrite_literal: rustfs-svc.rustfs.svc.cluster.local:9000
                                timeout: 0s
                              request_headers_to_remove:
                                - forwarded
                                - x-forwarded-for
                                - x-forwarded-host
                                - x-forwarded-proto
                                - x-forwarded-port
                              response_headers_to_add:
                                - header:
                                    key: cache-control
                                    value: private, no-store
                                  append_action: OVERWRITE_IF_EXISTS_OR_ADD
                                - header:
                                    key: referrer-policy
                                    value: no-referrer
                                  append_action: OVERWRITE_IF_EXISTS_OR_ADD
                            - match:
                                prefix: /__intar-s3/
                              direct_response:
                                status: 405
                                body:
                                  inline_string: "method not allowed\\n"
                            - match:
                                prefix: /__intar-grafana
                              direct_response:
                                status: 200
                                body:
                                  inline_string: >-
                                    <!doctype html><meta charset="utf-8"><title>Open Grafana</title><p>Return to the Intar workshop room and choose <b>Workspace applications → Grafana</b>.</p>
                              response_headers_to_add:
                                - header:
                                    key: content-type
                                    value: text/html; charset=utf-8
                                  append_action: OVERWRITE_IF_EXISTS_OR_ADD
                                - header:
                                    key: cache-control
                                    value: private, no-store
                                  append_action: OVERWRITE_IF_EXISTS_OR_ADD
                                - header:
                                    key: content-security-policy
                                    value: "default-src 'none'; style-src 'unsafe-inline'"
                                  append_action: OVERWRITE_IF_EXISTS_OR_ADD
                            - match:
                                prefix: /agent/ask
                                headers:
                                  - name: ":method"
                                    exact_match: POST
                              name: portal-agent-stream
                              route:
                                cluster: portal
                                timeout: 130s
                              request_headers_to_remove:
                                - accept-encoding
                            - match:
                                prefix: /
                              name: portal-ui
                              route:
                                cluster: portal
                                timeout: 70s
                              request_headers_to_remove:
                                - accept-encoding
                    http_filters:
                      - name: envoy.filters.http.lua
                        typed_config:
                          "@type": type.googleapis.com/envoy.extensions.filters.http.lua.v3.Lua
                          inline_code: |
                            local function replace_all(value, needle, replacement)
                              local result = {}
                              local offset = 1
                              while true do
                                local first, last = string.find(value, needle, offset, true)
                                if first == nil then
                                  table.insert(result, string.sub(value, offset))
                                  break
                                end
                                table.insert(result, string.sub(value, offset, first - 1))
                                table.insert(result, replacement)
                                offset = last + 1
                              end
                              return table.concat(result)
                            end

                            local function public_base(authority)
                              if authority == "localhost:30600" or authority == "127.0.0.1:30600" then
                                return "http://" .. authority
                              end
                              local label = string.match(
                                authority,
                                "^(wa%-[a-z0-9][a-z0-9%-]*)%.intar%.app$"
                              )
                              if label == nil or #label > 63 or string.sub(label, -1) == "-" then
                                return nil
                              end
                              return "https://" .. authority
                            end

                            function envoy_on_request(handle)
                              local base = public_base(handle:headers():get(":authority") or "")
                              if base == nil then
                                handle:respond(
                                  {
                                    [":status"] = "400",
                                    ["content-type"] = "text/plain",
                                    ["cache-control"] = "no-store"
                                  },
                                  "invalid Host\\n"
                                )
                                return
                              end
                              handle:streamInfo():dynamicMetadata():set(
                                "intar.portal-adapter",
                                "public_base",
                                base
                              )
                            end

                            function envoy_on_response(handle)
                              if handle:streamInfo():routeName() ~= "portal-ui" then
                                return
                              end
                              local content_type = handle:headers():get("content-type") or ""
                              if string.find(content_type, "text/html", 1, true) == nil then
                                return
                              end
                              local metadata = handle:streamInfo():dynamicMetadata():get(
                                "intar.portal-adapter"
                              )
                              if metadata == nil or metadata.public_base == nil then
                                return
                              end
                              local body = handle:body()
                              if body == nil then
                                return
                              end
                              local content = body:getBytes(0, body:length())
                              content = replace_all(
                                content,
                                "http://rustfs-svc.rustfs.svc.cluster.local:9000",
                                metadata.public_base .. "/__intar-s3"
                              )
                              content = replace_all(
                                content,
                                "http://localhost:30030",
                                metadata.public_base .. "/__intar-grafana"
                              )
                              body:setBytes(content)
                              handle:headers():remove("content-length")
                              handle:headers():remove("etag")
                            end
                      - name: envoy.filters.http.router
                        typed_config:
                          "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router
                          suppress_envoy_headers: true
      clusters:
        - name: portal
          type: STATIC
          connect_timeout: 2s
          circuit_breakers:
            thresholds:
              - priority: DEFAULT
                max_requests: 32
          load_assignment:
            cluster_name: portal
            endpoints:
              - lb_endpoints:
                  - endpoint:
                      address:
                        socket_address:
                          address: 127.0.0.1
                          port_value: 8080
        - name: rustfs
          type: STRICT_DNS
          dns_lookup_family: V4_ONLY
          connect_timeout: 2s
          load_assignment:
            cluster_name: rustfs
            endpoints:
              - lb_endpoints:
                  - endpoint:
                      address:
                        socket_address:
                          address: rustfs-svc.rustfs.svc.cluster.local
                          port_value: 9000
    admin:
      address:
        socket_address:
          address: 127.0.0.1
          port_value: 19000
`;
  adapted = adapted.replace(
    namespaceAnchor,
    `${namespaceAnchor}
${adapterConfig}---`,
  );

  replaceOnce(
    `    spec:
      serviceAccountName: portal
      containers:`,
    `    spec:
      serviceAccountName: portal
      automountServiceAccountToken: false
      volumes:
        - name: portal-kube-api-access
          projected:
            defaultMode: 420
            sources:
              - serviceAccountToken:
                  path: token
                  expirationSeconds: 3607
              - configMap:
                  name: kube-root-ca.crt
                  items:
                    - key: ca.crt
                      path: ca.crt
              - downwardAPI:
                  items:
                    - path: namespace
                      fieldRef:
                        apiVersion: v1
                        fieldPath: metadata.namespace
        - name: workspace-app-adapter-config
          configMap:
            name: portal-workspace-app-adapter
        - name: workspace-app-adapter-tmp
          emptyDir:
            sizeLimit: 16Mi
      containers:`,
    "pod volumes",
  );
  replaceOnce(
    `          ports:
            - containerPort: 8080
              name: http`,
    `          ports:
            - containerPort: 8080
              name: portal-http`,
    "portal port",
  );
  replaceOnce(
    `          readinessProbe:
            httpGet:
              path: /healthz
              port: http`,
    `          readinessProbe:
            httpGet:
              path: /healthz
              port: portal-http`,
    "portal readiness probe",
  );
  replaceOnce(
    `          livenessProbe:
            httpGet:
              path: /healthz
              port: http`,
    `          livenessProbe:
            httpGet:
              path: /healthz
              port: portal-http`,
    "portal liveness probe",
  );
  replaceOnce(
    `          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              memory: 128Mi
---
apiVersion: v1
kind: Service`,
    `          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              memory: 128Mi
          volumeMounts:
            - name: portal-kube-api-access
              mountPath: /var/run/secrets/kubernetes.io/serviceaccount
              readOnly: true
        - name: workspace-app-adapter
          image: docker.io/envoyproxy/envoy@sha256:c5e8a68e52f4d4697a9adb280dbe415d77fedf1257e183dcb86205bd438f18bd
          command: ["/usr/local/bin/envoy"]
          args:
            - --disable-hot-restart
            - --concurrency
            - "1"
            - -c
            - /etc/intar-workspace-app/envoy.yaml
            - --log-level
            - warn
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
            readOnlyRootFilesystem: true
            runAsNonRoot: true
            runAsUser: 65534
            runAsGroup: 65534
            seccompProfile:
              type: RuntimeDefault
          ports:
            - containerPort: 18080
              name: gateway
          readinessProbe:
            httpGet:
              path: /healthz
              port: gateway
              httpHeaders:
                - name: Host
                  value: localhost:30600
            initialDelaySeconds: 2
            periodSeconds: 5
          livenessProbe:
            httpGet:
              path: /healthz
              port: gateway
              httpHeaders:
                - name: Host
                  value: localhost:30600
            initialDelaySeconds: 10
            periodSeconds: 15
          resources:
            requests:
              cpu: 10m
              memory: 32Mi
            limits:
              memory: 96Mi
          volumeMounts:
            - name: workspace-app-adapter-config
              mountPath: /etc/intar-workspace-app/envoy.yaml
              subPath: envoy.yaml
              readOnly: true
            - name: workspace-app-adapter-tmp
              mountPath: /tmp
---
apiVersion: v1
kind: Service`,
    "adapter container",
  );
  replaceOnce(
    `      targetPort: http
      nodePort: 30600`,
    `      targetPort: gateway
      nodePort: 30600`,
    "service target",
  );
  replaceOnce(
    `            - name: UPLOADER_URL
              value: http://uploader.pipeline.svc.cluster.local
            # WORKSHOP-GRADE CREDENTIALS, committed on purpose (ephemeral`,
    `            - name: UPLOADER_URL
              value: http://uploader.pipeline.svc.cluster.local
            # The pinned portal image predates the workshop's migration from
            # otel-lgtm to VictoriaMetrics and the OpenTelemetry Collector.
            - name: PROM_URL
              value: http://victoria-metrics.observability.svc.cluster.local:8428
            - name: OTEL_EXPORTER_OTLP_ENDPOINT
              value: http://otel-collector.observability.svc.cluster.local:4318
            # WORKSHOP-GRADE CREDENTIALS, committed on purpose (ephemeral`,
    "current observability endpoints",
  );
  replaceOnce(
    `            # Host the BROWSER uses for presigned URLs (the RustFS NodePort
            # as seen from the attendee's machine). Matches NODEPORT_RUSTFS_S3.
            - name: S3_PUBLIC_ENDPOINT
              value: localhost:30900`,
    `            # Cloudbox signs with the stable in-cluster RustFS authority.
            # The sidecar rewrites rendered URLs to a route-local /__intar-s3/
            # path, then restores this authority before RustFS verifies SigV4.
            - name: S3_PUBLIC_ENDPOINT
              value: rustfs-svc.rustfs.svc.cluster.local:9000`,
    "S3 public endpoint comment",
  );
  replaceOnce(
    `            # Browser-facing Grafana (NodePort 30030, the Victoria-stack
            # Grafana) — used for the portal's observability deep-links.
            - name: GRAFANA_URL`,
    `            # Stable marker for observability deep-links. The sidecar
            # replaces it with guidance to open the separately authorized
            # Grafana route under Workspace applications in the Intar room.
            - name: GRAFANA_URL`,
    "Grafana public endpoint comment",
  );

  return adapted;
}

function adaptPicturePipelineTelemetry(value: string): string {
  let adapted = value;
  const endpoint = "http://otel-collector.observability.svc.cluster.local:4318";
  const replaceOnce = (
    anchor: string,
    replacement: string,
    label: string,
  ) => {
    const occurrences = adapted.split(anchor).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `picture-pipeline ${label} anchor occurred ${occurrences} times upstream`,
      );
    }
    adapted = adapted.replace(anchor, replacement);
  };

  replaceOnce(
    `            - name: BROKER_URL
              value: http://broker-ingress.knative-eventing.svc.cluster.local/pipeline/default
          resources:`,
    `            - name: BROKER_URL
              value: http://broker-ingress.knative-eventing.svc.cluster.local/pipeline/default
            # The pinned v0.1.0 image still defaults to the retired otel-lgtm
            # service, so bind it to the collector deployed by this workshop.
            - name: OTEL_EXPORTER_OTLP_ENDPOINT
              value: ${endpoint}
          resources:`,
    "uploader telemetry endpoint",
  );
  replaceOnce(
    `            - name: S3_BUCKET
              value: images
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              # Image decoding is the one memory-hungry step in the pipeline.`,
    `            - name: S3_BUCKET
              value: images
            # The pinned v0.1.0 image still defaults to the retired otel-lgtm
            # service, so bind it to the collector deployed by this workshop.
            - name: OTEL_EXPORTER_OTLP_ENDPOINT
              value: ${endpoint}
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              # Image decoding is the one memory-hungry step in the pipeline.`,
    "resizer telemetry endpoint",
  );

  return adapted;
}

function adaptRuntimeLabCommon(value: string): string {
  const helperAnchor = `  echo "ERROR: $obj never appeared in ns $ns after \${timeout}s" >&2
  return 1
}

# wait_for_cr <ns> <resource> [crd]`;
  const helperReplacement = `  echo "ERROR: $obj never appeared in ns $ns after \${timeout}s" >&2
  return 1
}

# wait_condition <ns-or-empty> <resource> <condition> [timeout-seconds]
# Poll a single resource, or every item in a resource list such as "nodes",
# until the named Kubernetes condition is True. Kubernetes can briefly expose
# status.conditions as null while a controller initializes an object. Native
# kubectl wait treats that valid transitional state as a fatal accessor error;
# the null-coalescing jq generator below treats it as an empty condition list
# and keeps polling. An empty resource list is never considered ready.
wait_condition() {
  local ns="$1" obj="$2" condition="$3" timeout="\${4:-300}" waited=0 state
  while [ "$waited" -lt "$timeout" ]; do
    if [ -n "$ns" ]; then
      state="$(kubectl -n "$ns" get "$obj" -o json 2>/dev/null)" || state=""
    else
      state="$(kubectl get "$obj" -o json 2>/dev/null)" || state=""
    fi
    if [ -n "$state" ] && jq -e --arg condition "$condition" '
      def has_true_condition($wanted):
        any((.status.conditions? // [])[]?;
          (((.type? // "") | ascii_downcase) == ($wanted | ascii_downcase)) and
          ((((.status? // "") | tostring) | ascii_downcase) == "true"));
      if has("items") then
        (((.items // []) | length) > 0) and
        all((.items // [])[]; has_true_condition($condition))
      else
        has_true_condition($condition)
      end
    ' <<<"$state" >/dev/null; then
      echo "\${obj} condition \${condition}=True"
      return 0
    fi
    sleep 5
    waited=$((waited + 5))
  done
  echo "ERROR: timed out after \${timeout}s waiting for \${obj} condition \${condition}=True in \${ns:-cluster scope}" >&2
  return 1
}

# wait_for_cr <ns> <resource> [crd]`;
  const occurrences = value.split(helperAnchor).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `lab/common.sh condition helper anchor occurred ${occurrences} times upstream`,
    );
  }
  const adapted = value
    .replace(helperAnchor, helperReplacement)
    .replace(
      `wait_for_cr() {
  ns="$1"; resource="$2"; crd="\${3:-}"
  [ -n "$crd" ] && kubectl wait --for=condition=Established "crd/$crd" --timeout=180s`,
      `wait_for_cr() {
  local ns="$1" resource="$2" crd="\${3:-}"
  [ -n "$crd" ] && wait_condition "" "crd/$crd" Established 180`,
    );
  if (
    !adapted.includes("wait_condition() {") ||
    !adapted.includes("(.status.conditions? // [])[]?") ||
    !adapted.includes(
      '[ -n "$crd" ] && wait_condition "" "crd/$crd" Established 180',
    ) ||
    adapted.includes(
      'kubectl wait --for=condition=Established "crd/$crd"',
    )
  ) {
    throw new Error("lab/common.sh null-safe condition adaptation failed");
  }
  return adapted;
}

function adaptRuntimeCnpgFaultRestore(value: string): string {
  const withHelper = value.replace(
    `DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"

kubectl -n faultlab-02 delete cluster orders-db`,
    `DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../../common.sh
source "$DIR/../../../common.sh"

kubectl -n faultlab-02 delete cluster orders-db`,
  );
  const adapted = withHelper.replace(
    "kubectl -n faultlab-02 wait --for=condition=Ready cluster/orders-db --timeout=300s",
    "wait_condition faultlab-02 cluster/orders-db Ready 300",
  );
  if (
    adapted === value ||
    !adapted.includes('source "$DIR/../../../common.sh"') ||
    !adapted.includes(
      "wait_condition faultlab-02 cluster/orders-db Ready 300",
    ) ||
    adapted.includes("kubectl -n faultlab-02 wait --for=condition=Ready")
  ) {
    throw new Error("CNPG fault restore condition adaptation failed");
  }
  return adapted;
}

function renderRuntimeBootstrap(): string {
  const talosImage = imageMappings.get("ghcr.io/siderolabs/talos:v1.13.6");
  if (!talosImage) throw new Error("Talos runtime digest is missing");
  return `#!/usr/bin/env bash
set -euo pipefail

readonly root="\${INTAR_WORKSHOP_INSTALL_ROOT:?missing install root}"
readonly image_lock="\${INTAR_WORKSHOP_IMAGE_LOCK:?missing image lock}"
readonly learner_user="\${INTAR_WORKSHOP_LEARNER_USER:?missing learner user}"
readonly mise_version=v2026.7.3
readonly mise_sha256=06088e84e4514b59fd2b6b17927bcc37aa0ab10020a270868871fb010b92069b

umask 0022
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
getent passwd "\${learner_user}" >/dev/null
if [[ "\${learner_user}" != root ]]; then
  readonly container_group="$(stat --format=%G /var/run/docker.sock)"
  getent group "\${container_group}" >/dev/null
  usermod --append --groups "\${container_group}" "\${learner_user}"
fi

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
mise install --locked
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
    `  kubelet:
    extraMounts:
      # local-path-provisioner writes PV data here; without this bind mount
      # every PVC on Talos stays Pending (kubelet cannot reach the host path).
      - destination: /var/local-path-provisioner
        type: bind
        source: /var/local-path-provisioner
        options: [bind, rshared, rw]`,
    `  # Kubernetes v1.36 no longer accepts kubelet's removed
  # --pod-infra-container-image flag. Configure the CRI sandbox image through
  # Talos' documented containerd fragment instead, retaining the exact digest.
  files:
    - content: |
        [plugins]
          [plugins."io.containerd.cri.v1.images".pinned_images]
            sandbox = "${pin("registry.k8s.io/pause:3.10.1")}"
      path: /etc/cri/conf.d/20-customization.part
      op: create
  kubelet:
    image: ${pin("ghcr.io/siderolabs/kubelet:v1.36.2")}
`,
  );
  if (
    withKubeletImages === adapted ||
    withKubeletImages.includes("pod-infra-container-image:") ||
    !withKubeletImages.includes(
      '[plugins."io.containerd.cri.v1.images".pinned_images]',
    ) ||
    !withKubeletImages.includes(
      `sandbox = "${pin("registry.k8s.io/pause:3.10.1")}"`,
    )
  ) {
    throw new Error("Talos kubelet mount anchor changed upstream");
  }
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

function adaptContainerizedTalosLocalStorage(value: string): string {
  const oldComment = `  # Workshop curation: Talos has an immutable root filesystem — /opt is not
  # writable. /var/local-path-provisioner is the Talos-supported location and
  # MUST be bind-mounted into the kubelet via a machine-config patch
  # (machine.kubelet.extraMounts). See scripts/create-cluster.sh.`;
  const newComment = `  # Workshop curation: Talos already bind-mounts /var/lib/kubelet into its
  # kubelet system container with recursive shared propagation. Keeping
  # workshop PVs below that existing mount avoids a second self-recursive
  # kubelet extra mount while preserving hostPath visibility.`;
  const adapted = value
    .replace(oldComment, newComment)
    .replaceAll(
      "/var/local-path-provisioner",
      "/var/lib/kubelet/local-path-provisioner",
    );
  if (
    adapted === value ||
    adapted.includes("/var/local-path-provisioner") ||
    !adapted.includes("/var/lib/kubelet/local-path-provisioner")
  ) {
    throw new Error("Talos local-path storage anchor changed upstream");
  }
  return adapted;
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

function adaptModule07Verifier(value: string): string {
  let adapted = value;
  const replaceOnce = (
    anchor: string,
    replacement: string,
    label: string,
  ) => {
    const occurrences = adapted.split(anchor).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `module 07 verifier ${label} anchor occurred ${occurrences} times upstream ` +
          `(first=${adapted.indexOf(anchor)}, last=${adapted.lastIndexOf(anchor)})`,
      );
    }
    adapted = adapted.replace(anchor, () => replacement);
  };

  replaceOnce(
    `# --- Zot registry ---------------------------------------------------------------
if curl -fsS --max-time 5 http://localhost:30500/v2/ >/dev/null 2>&1; then
  ok "Zot registry API answers on :30500"
else
  fail "Zot not answering on :30500 — kubectl -n zot get pods,svc"
fi`,
    `# --- Zot registry ---------------------------------------------------------------
ZOT_READY=0
for _ in $(seq 1 36); do
  if curl -fsS --max-time 5 http://localhost:30500/v2/ >/dev/null 2>&1; then
    ZOT_READY=1
    break
  fi
  sleep 5
done
if (( ZOT_READY == 1 )); then
  ok "Zot registry API answers on :30500"
else
  fail "Zot not answering on :30500 — kubectl -n zot get pods,svc"
fi`,
    "Zot API",
  );

  replaceOnce(
    `# --- WorkflowTemplate present ------------------------------------------------------
if kubectl -n builds get workflowtemplate build-and-push >/dev/null 2>&1; then
  ok "WorkflowTemplate build-and-push exists in ns builds"
else
  fail "WorkflowTemplate build-and-push missing in ns builds — is the argo-workflows app fully synced?"
fi`,
    `# --- WorkflowTemplate present ------------------------------------------------------
TEMPLATE_READY=0
for _ in $(seq 1 36); do
  if kubectl -n builds get workflowtemplate build-and-push >/dev/null 2>&1; then
    TEMPLATE_READY=1
    break
  fi
  sleep 5
done
if (( TEMPLATE_READY == 1 )); then
  ok "WorkflowTemplate build-and-push exists in ns builds"
else
  fail "WorkflowTemplate build-and-push missing in ns builds — is the argo-workflows app fully synced?"
fi`,
    "WorkflowTemplate",
  );

  replaceOnce(
    `# --- A build succeeded --------------------------------------------------------------
PHASES="$(kubectl -n builds get workflows \\
  -o jsonpath='{range .items[*]}{.metadata.name}={.status.phase}{"\\n"}{end}' 2>/dev/null | grep '^build-hello-site-' || true)"
if [ -z "$PHASES" ]; then
  fail "no build-hello-site-* workflow found — submit one: kubectl create -f workflow-run.yaml"
elif echo "$PHASES" | grep -q '=Succeeded'; then
  ok "build workflow Succeeded ($(echo "$PHASES" | grep -c '=Succeeded') run(s))"
else
  fail "build workflow(s) exist but none Succeeded ($(echo "$PHASES" | tr '\\n' ' ')) — kubectl -n builds get pods; read the failing step's logs"
fi`,
    `# --- A build succeeded --------------------------------------------------------------
PHASES=""
WORKFLOW_READY=0
for _ in $(seq 1 36); do
  PHASES="$(kubectl -n builds get workflows \\
    -o jsonpath='{range .items[*]}{.metadata.name}={.status.phase}{"\\n"}{end}' 2>/dev/null || true)"
  PHASES="$(awk '/^build-hello-site-/{ print }' <<<"$PHASES")"
  if [[ "$PHASES" == *"=Succeeded"* ]]; then
    WORKFLOW_READY=1
    break
  fi
  sleep 5
done
if (( WORKFLOW_READY == 1 )); then
  SUCCEEDED_COUNT="$(awk 'index($0, "=Succeeded"){ count++ } END{ print count + 0 }' <<<"$PHASES")"
  ok "build workflow Succeeded (\${SUCCEEDED_COUNT} run(s))"
elif [[ -z "$PHASES" ]]; then
  fail "no build-hello-site-* workflow found — submit one: kubectl create -f workflow-run.yaml"
else
  PHASE_SUMMARY="\${PHASES//$'\\n'/ }"
  fail "build workflow(s) exist but none Succeeded (\${PHASE_SUMMARY}) — kubectl -n builds get pods; read the failing step's logs"
fi`,
    "successful workflow",
  );

  replaceOnce(
    `# --- Image actually in the registry ---------------------------------------------------
CATALOG="$(curl -fsS --max-time 5 http://localhost:30500/v2/_catalog 2>/dev/null || echo '{}')"
if echo "$CATALOG" | grep -q 'hello-site'; then
  ok "image 'hello-site' present in Zot catalog"
else
  fail "hello-site not in Zot catalog ($CATALOG) — did the push step succeed? check the workflow logs"
fi`,
    `# --- Image actually in the registry ---------------------------------------------------
TAG_RESPONSE="{}"
IMAGE_READY=0
for _ in $(seq 1 36); do
  TAG_RESPONSE="$(curl -fsS --max-time 5 \\
    http://localhost:30500/v2/hello-site/tags/list 2>/dev/null || echo '{}')"
  if jq -e '.name == "hello-site" and any((.tags // [])[]?; . == "v1")' \\
    <<<"$TAG_RESPONSE" >/dev/null 2>&1; then
    IMAGE_READY=1
    break
  fi
  sleep 5
done
if (( IMAGE_READY == 1 )); then
  ok "image 'hello-site:v1' present in Zot"
else
  fail "hello-site:v1 not in Zot ($TAG_RESPONSE) — did the push step succeed? check the workflow logs"
fi`,
    "exact Zot tag",
  );

  replaceOnce(
    `if kubectl -n demo wait --for=condition=Available deploy/hello-site --timeout=10s >/dev/null 2>&1; then`,
    `if kubectl -n demo wait --for=condition=Available deploy/hello-site --timeout=180s >/dev/null 2>&1; then`,
    "deployment rollout",
  );
  replaceOnce(
    `  if echo "$BODY" | grep -q 'hello-site'; then`,
    `  if [[ "$BODY" == *"hello-site"* ]]; then`,
    "served-page check",
  );

  const forbidden = [
    "http://localhost:30500/v2/_catalog",
    "| grep -q '=Succeeded'",
    "| grep -q 'hello-site'",
    "--timeout=10s",
  ];
  for (const contract of forbidden) {
    if (adapted.includes(contract)) {
      throw new Error(
        `module 07 verifier retains unstable point check: ${contract}`,
      );
    }
  }
  if (
    !adapted.includes("http://localhost:30500/v2/hello-site/tags/list") ||
    !adapted.includes('any((.tags // [])[]?; . == "v1")') ||
    !adapted.includes("WORKFLOW_READY=0") ||
    !adapted.includes("--timeout=180s")
  ) {
    throw new Error("module 07 verifier stabilization contract is incomplete");
  }
  return adapted;
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

function adaptVictoriaLogsNarrative(relativePath: string, value: string): string {
  const [expected, replacement] =
    relativePath === "gitops/catalog/victoria-logs.yaml"
      ? [
          `# /insert/opentelemetry/v1/logs, LogsQL /select/logsql/query, Loki-compatible
# query API for Grafana. In-cluster: victoria-logs.observability.svc:9428.`,
          `# /insert/opentelemetry/v1/logs and LogsQL /select/logsql/query. Grafana
# uses the checksum-pinned native VictoriaLogs plugin. In-cluster:
# victoria-logs.observability.svc:9428.`,
        ]
      : [
          `#   - Loki-compatible query API (used by Grafana's Loki datasource, see
#     grafana/VENDOR.md) under /select/loki/api/v1/*`,
          `#   - Grafana queries through the checksum-pinned native VictoriaLogs
#     datasource plugin; VictoriaLogs does not expose a Loki query API.`,
        ];
  const occurrences = value.split(expected).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `VictoriaLogs narrative anchor occurred ${occurrences} times in ${relativePath}`,
    );
  }
  return value.replace(expected, replacement);
}

function adaptStockGrafana(value: string): string {
  const victoriaLogsUrl =
    "url: http://victoria-logs.observability.svc.cluster.local:9428";
  const victoriaLogsOccurrences = value.split(victoriaLogsUrl).length - 1;
  if (victoriaLogsOccurrences !== 1) {
    throw new Error(
      `stock Grafana VictoriaLogs URL occurred ${victoriaLogsOccurrences} times upstream`,
    );
  }
  let adapted = value.replaceAll(
    "type: victoriametrics-metrics-datasource",
    "type: prometheus",
  );
  const replaceOnce = (
    anchor: string,
    replacement: string,
    label: string,
  ) => {
    const occurrences = adapted.split(anchor).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `stock Grafana ${label} anchor occurred ${occurrences} times upstream`,
      );
    }
    adapted = adapted.replace(anchor, replacement);
  };
  replaceOnce(
    `# issue #57). Pre-wired with three provisioned datasources, all built-in types
# (no plugins — offline rule):
#   - VictoriaMetrics (Prometheus type, default) → PromQL/metrics
#   - VictoriaLogs    (Loki type)                → logs   (see VENDOR.md caveat)
#   - VictoriaTraces  (Jaeger type)              → traces (see VENDOR.md caveat)`,
    `# issue #57). Pre-wired with three provisioned datasources:
#   - VictoriaMetrics (built-in Prometheus type) → PromQL/metrics
#   - VictoriaLogs    (signed plugin 0.29.0)      → LogsQL/logs
#   - VictoriaTraces  (built-in Jaeger type)      → traces`,
    "summary",
  );
  replaceOnce(
    `      # VictoriaMetrics via its NATIVE Grafana datasource plugin (#65), baked
      # into the image (see apps/grafana/Dockerfile) — the MetricsQL query editor
      # instead of the Prometheus shim. Same uid, so nothing that references it
      # by uid breaks.`,
    `      # VictoriaMetrics supports Grafana's built-in Prometheus datasource.
      # Keep the stable uid so workshop deep links and dashboards remain valid.`,
    "VictoriaMetrics comment",
  );
  replaceOnce(
    `      # VictoriaTraces exposes a Jaeger-compatible query API, so we use the
      # built-in Jaeger datasource (offline rule: no plugin at boot) pointed at
      # its /select/jaeger base. Replaces otel-lgtm's Tempo. See VENDOR.md.`,
    `      # VictoriaTraces exposes a Jaeger-compatible query API, so the built-in
      # Jaeger datasource points at its /select/jaeger base.`,
    "VictoriaTraces comment",
  );
  replaceOnce(
    `          # Custom image: stock Grafana 12.4.5 + the native VictoriaMetrics
          # datasource plugins baked in (apps/grafana/Dockerfile, #65).`,
    `          # Stock Grafana. A checksum-pinned, signed VictoriaLogs plugin is
          # staged by the init container into a read-only shared volume.`,
    "image comment",
  );
  replaceOnce(
    `            # No plugins fetched at boot — they're BAKED into the image (#65).
            - name: GF_INSTALL_PLUGINS
              value: ""
            # Load the baked-in native VictoriaMetrics plugins from here. NOT the
            # default /var/lib/grafana/plugins — the data emptyDir below mounts
            # over /var/lib/grafana and would shadow it.
            - name: GF_PATHS_PLUGINS
              value: /opt/grafana-plugins`,
    `            # The init container populates this checksum-verified volume.
            - name: GF_PATHS_PLUGINS
              value: /opt/grafana-plugins`,
    "plugin installation",
  );
  replaceOnce(
    `      containers:
        - name: grafana`,
    `      initContainers:
        - name: install-victorialogs-datasource
          image: "docker.io/grafana/grafana@sha256:26b8f35a9e4e4431995cf64c3f396505a4faf17bcfc19f9ed84943ec6bfd5ecd"
          imagePullPolicy: IfNotPresent
          command: ["/bin/bash", "-ec"]
          args:
            - |
              archive=/tmp/victoriametrics-logs-datasource-v0.29.0.tar.gz
              curl -fsSL --output "\${archive}" \\
                https://github.com/VictoriaMetrics/victorialogs-datasource/releases/download/v0.29.0/victoriametrics-logs-datasource-v0.29.0.tar.gz
              echo "34935dcb7c19107f86a7703ee0a24f40363e0c02483206f3cc9a5de2f5fa4918  \${archive}" |
                sha256sum -c -
              tar -xzf "\${archive}" -C /opt/grafana-plugins
              test -f /opt/grafana-plugins/victoriametrics-logs-datasource/plugin.json
              rm -f "\${archive}"
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: [ ALL ]
            readOnlyRootFilesystem: true
          volumeMounts:
            - name: plugins
              mountPath: /opt/grafana-plugins
            - name: tmp
              mountPath: /tmp
      containers:
        - name: grafana`,
    "plugin init container",
  );
  replaceOnce(
    `          volumeMounts:
            - name: datasources`,
    `          volumeMounts:
            - name: plugins
              mountPath: /opt/grafana-plugins
              readOnly: true
            - name: datasources`,
    "plugin volume mount",
  );
  replaceOnce(
    `      volumes:
        - name: datasources`,
    `      volumes:
        - name: plugins
          emptyDir: {}
        - name: datasources`,
    "plugin volume",
  );
  if (adapted.includes("victoriametrics-metrics-datasource") ||
      !adapted.includes("type: victoriametrics-logs-datasource") ||
      !adapted.includes(victoriaLogsUrl) ||
      !adapted.includes(
        "install-victorialogs-datasource",
      ) ||
      !adapted.includes(
        "34935dcb7c19107f86a7703ee0a24f40363e0c02483206f3cc9a5de2f5fa4918",
      ) ||
      !adapted.includes(
        "GF_PATHS_PLUGINS\n              value: /opt/grafana-plugins",
      ) ||
      adapted.includes("type: loki") ||
      adapted.includes("GF_INSTALL_PLUGINS") ||
      adapted.includes("GF_PLUGINS_PREINSTALL")) {
    throw new Error("stock Grafana adaptation is incomplete");
  }
  return adapted;
}

function adaptGrafanaCatalog(value: string): string {
  const expected = "Browser: http://localhost:30031";
  if (value.split(expected).length - 1 !== 1) {
    throw new Error("Grafana catalog browser-port anchor changed upstream");
  }
  return value.replace(
    expected,
    "Browser: declared as the Grafana workspace application on port 30030",
  );
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
