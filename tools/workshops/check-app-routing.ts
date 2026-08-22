#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? ".work/workshops/platform-engineering");

const read = (relative: string) => readFileSync(join(root, relative), "utf8");

const requireText = (relative: string, ...needles: string[]) => {
  const value = read(relative);
  for (const needle of needles) {
    if (!value.includes(needle)) {
      throw new Error(`${relative} is missing ${JSON.stringify(needle)}`);
    }
  }
  return value;
};

const rejectText = (relative: string, ...needles: string[]) => {
  const value = read(relative);
  for (const needle of needles) {
    if (value.includes(needle)) {
      throw new Error(
        `${relative} unexpectedly contains ${JSON.stringify(needle)}`,
      );
    }
  }
  return value;
};

const requireOrderedText = (relative: string, ...needles: string[]) => {
  const value = read(relative);
  let offset = 0;
  for (const needle of needles) {
    const index = value.indexOf(needle, offset);
    if (index < 0) {
      throw new Error(
        `${relative} is missing ordered text ${JSON.stringify(needle)}`,
      );
    }
    offset = index + needle.length;
  }
  return value;
};

const applicationBlock = (manifest: string, id: string) => {
  const match = manifest.match(
    new RegExp(`  application "${id}" \\{([\\s\\S]*?)\\n  \\}`, "u"),
  );
  if (!match?.[1]) {
    throw new Error(
      `workshop.hcl is missing application ${JSON.stringify(id)}`,
    );
  }
  return match[1];
};

const runtimeProfileBlock = (manifest: string, id: string) => {
  const match = manifest.match(
    new RegExp(`  runtime_profile "${id}" \\{([\\s\\S]*?)\\n  \\}`, "u"),
  );
  if (!match?.[1]) {
    throw new Error(
      `workshop.hcl is missing runtime profile ${JSON.stringify(id)}`,
    );
  }
  return match[1];
};

const manifest = read("workshop.hcl");
const runtimeProfileIds = [...manifest.matchAll(/runtime_profile "([^"]+)"/gu)].map(
  (match) => match[1],
);
if (
  JSON.stringify(runtimeProfileIds) !==
    JSON.stringify(["hetzner-cpx42", "gcp-e2-standard-4"])
) {
  throw new Error(
    `the production revision must declare the ordered Hetzner and GCP profiles; observed ${JSON.stringify(runtimeProfileIds)}`,
  );
}
const hetznerProfile = runtimeProfileBlock(manifest, "hetzner-cpx42");
const expectedHetznerProfile = `provider      = "hetzner_cloud"
    vm_id         = "learner"
    machine_type  = "cpx42"
    system_image  = "debian-13"`;
if (hetznerProfile.trim() !== expectedHetznerProfile) {
  throw new Error("the Hetzner runtime profile does not match its pinned contract");
}
const gcpProfile = runtimeProfileBlock(manifest, "gcp-e2-standard-4");
const expectedGcpProfile = `provider       = "gcp_compute"
    vm_id          = "learner"
    machine_type   = "e2-standard-4"
    system_image   = "projects/debian-cloud/global/images/family/debian-13"
    root_disk_type = "pd-balanced"
    locations = [
      "europe-west3-a",
      "europe-west3-b",
      "europe-west3-c",
    ]`;
if (gcpProfile.trim() !== expectedGcpProfile) {
  throw new Error("the GCP runtime profile does not match its pinned contract");
}
const knative = applicationBlock(manifest, "knative");
for (const expected of [
  "port           = 31080",
  'protocol       = "http"',
  'upstream_host  = "hello.demo.127.0.0.1.sslip.io"',
  'release_module = "06"',
]) {
  if (!knative.includes(expected)) {
    throw new Error(
      `Knative application is missing ${JSON.stringify(expected)}`,
    );
  }
}
if ((manifest.match(/upstream_host\s*=/gu)?.length ?? 0) !== 1) {
  throw new Error("only the Knative application may declare an upstream host");
}
if ((manifest.match(/port\s+= 31080/gu)?.length ?? 0) !== 1) {
  throw new Error("workshop.hcl must declare Knative port 31080 exactly once");
}

const grafana = applicationBlock(manifest, "grafana");
for (const expected of [
  "port           = 30030",
  'protocol       = "http"',
  'release_module = "09"',
]) {
  if (!grafana.includes(expected)) {
    throw new Error(
      `Grafana application is missing ${JSON.stringify(expected)}`,
    );
  }
}
if ((manifest.match(/port\s+= 30030/gu)?.length ?? 0) !== 1) {
  throw new Error("workshop.hcl must declare Grafana port 30030 exactly once");
}

const cloudbox = applicationBlock(manifest, "cloudbox");
for (const expected of [
  "port           = 30600",
  'protocol       = "http"',
  'release_module = "08"',
]) {
  if (!cloudbox.includes(expected)) {
    throw new Error(
      `Cloudbox application is missing ${JSON.stringify(expected)}`,
    );
  }
}
if ((manifest.match(/port\s+= 30600/gu)?.length ?? 0) !== 1) {
  throw new Error("workshop.hcl must declare Cloudbox port 30600 exactly once");
}

const versions = requireText(
  "runtime/source/scripts/versions.env",
  'NODEPORT_RUSTFS_CONSOLE="30901"',
  'NODEPORT_GRAFANA="30030"',
  'NODEPORT_KOURIER="31080"',
);
if ((versions.match(/NODEPORT_RUSTFS_CONSOLE/gu)?.length ?? 0) !== 1) {
  throw new Error("RustFS console NodePort variable must be unique");
}
if (versions.includes("NODEPORT_KNATIVE_APP") || versions.includes("31081")) {
  throw new Error("Knative must use the existing Kourier NodePort");
}

requireText(
  "runtime/source/scripts/create-cluster.sh",
  "${NODEPORT_RUSTFS_CONSOLE}:${NODEPORT_RUSTFS_CONSOLE}/tcp",
  "${NODEPORT_GRAFANA}:${NODEPORT_GRAFANA}/tcp",
  "${NODEPORT_KOURIER}:${NODEPORT_KOURIER}/tcp",
);

const gitea = requireText(
  "runtime/source/scripts/bootstrap-gitops.sh",
  "PUBLIC_URL_DETECTION: auto",
  "ROOT_URL: http://localhost:${NODEPORT_GITEA}/",
  "LOCAL_ROOT_URL: ${GITEA_CLUSTER_URL}/",
);
if (/^\s*ROOT_URL:\s+\$\{GITEA_CLUSTER_URL\}\/\s*$/mu.test(gitea)) {
  throw new Error("Gitea still fixes its public URL to cluster DNS");
}

requireText(
  "runtime/source/gitops/components/rustfs/service-nodeport.yaml",
  "nodePort: 30900",
  "nodePort: 30901",
  "port: 9001",
  "targetPort: 9001",
);
const rustfs = requireText(
  "runtime/source/gitops/components/rustfs/rustfs.yaml",
  'RUSTFS_CONSOLE_ADDRESS: ":9001"',
  "containerPort: 9001",
  "targetPort: 9001",
);
if (rustfs.includes("NET_BIND_SERVICE")) {
  throw new Error("RustFS listener or security capabilities were changed");
}

const portalAdapter = requireText(
  "runtime/source/gitops/components/portal/portal.yaml",
  "name: portal-workspace-app-adapter",
  "per_connection_buffer_limit_bytes: 1048576",
  "port_value: 18080",
  'domains: ["*"]',
  "prefix: /__intar-s3/",
  'regex: "^(GET|HEAD)$"',
  "cluster: rustfs",
  "prefix_rewrite: /",
  "host_rewrite_literal: rustfs-svc.rustfs.svc.cluster.local:9000",
  "timeout: 0s",
  "status: 405",
  '"method not allowed\\n"',
  "Workspace applications → Grafana",
  "prefix: /agent/ask",
  "name: portal-agent-stream",
  "timeout: 130s",
  "name: portal-ui",
  "timeout: 70s",
  'authority == "localhost:30600"',
  'authority == "127.0.0.1:30600"',
  '"^(wa%-[a-z0-9][a-z0-9%-]*)%.intar%.app$"',
  "#label > 63",
  'string.sub(label, -1) == "-"',
  'return "https://" .. authority',
  '[":status"] = "400"',
  '"invalid Host\\n"',
  'routeName() ~= "portal-ui"',
  '"http://rustfs-svc.rustfs.svc.cluster.local:9000"',
  'metadata.public_base .. "/__intar-s3"',
  '"http://localhost:30030"',
  'metadata.public_base .. "/__intar-grafana"',
  "suppress_envoy_headers: true",
  "automountServiceAccountToken: false",
  "name: portal-kube-api-access",
  "mountPath: /var/run/secrets/kubernetes.io/serviceaccount",
  "--concurrency",
  "runAsGroup: 65534",
  "type: RuntimeDefault",
  "docker.io/envoyproxy/envoy@sha256:c5e8a68e52f4d4697a9adb280dbe415d77fedf1257e183dcb86205bd438f18bd",
  "targetPort: gateway",
);
const portalSigningAuthority = "rustfs-svc.rustfs.svc.cluster.local:9000";
for (const anchor of [
  `host_rewrite_literal: ${portalSigningAuthority}`,
  `"http://${portalSigningAuthority}",`,
  `- name: S3_PUBLIC_ENDPOINT\n              value: ${portalSigningAuthority}`,
]) {
  if (portalAdapter.split(anchor).length - 1 !== 1) {
    throw new Error(
      `portal presigning, response rewrite, and S3 proxy Host must share one internal RustFS authority: ${anchor}`,
    );
  }
}
if (/S3_PUBLIC_ENDPOINT\s*\n\s*value: localhost:30900/u.test(portalAdapter)) {
  throw new Error(
    "portal must not use pod loopback for MinIO presigning and region discovery",
  );
}
const cloudboxOtel =
  "- name: OTEL_EXPORTER_OTLP_ENDPOINT\n              value: http://otel-collector.observability.svc.cluster.local:4318";
if (portalAdapter.split(cloudboxOtel).length - 1 !== 1) {
  throw new Error("portal must use the workshop OpenTelemetry Collector");
}
if (
  !portalAdapter.includes(
    "- name: PROM_URL\n              value: http://victoria-metrics.observability.svc.cluster.local:8428",
  )
) {
  throw new Error("portal must use the workshop VictoriaMetrics service");
}
if ((portalAdapter.match(/prefix: \/__intar-s3\//gu)?.length ?? 0) !== 2) {
  throw new Error(
    "portal adapter must have one GET/HEAD S3 route and one 405 fallback",
  );
}
if ((portalAdapter.match(/targetPort: gateway/gu)?.length ?? 0) !== 1) {
  throw new Error("portal NodePort must target only the workspace-app adapter");
}
if (
  (portalAdapter.match(
    /mountPath: \/var\/run\/secrets\/kubernetes\.io\/serviceaccount/gu,
  )?.length ?? 0) !== 1
) {
  throw new Error(
    "only the portal container may mount the Kubernetes API credential",
  );
}
requireOrderedText(
  "runtime/source/gitops/components/portal/portal.yaml",
  `                            - match:
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
                                timeout: 0s`,
  `                            - match:
                                prefix: /__intar-s3/
                              direct_response:
                                status: 405`,
  `                            - match:
                                prefix: /agent/ask
                                headers:
                                  - name: ":method"
                                    exact_match: POST
                              name: portal-agent-stream
                              route:
                                cluster: portal
                                timeout: 130s`,
  `                            - match:
                                prefix: /
                              name: portal-ui
                              route:
                                cluster: portal
                                timeout: 70s`,
);

const kourier = requireText(
  "runtime/source/gitops/components/knative-serving/kourier.yaml",
  "nodePort: 31080",
);
rejectText(
  "runtime/source/gitops/components/knative-serving/kourier.yaml",
  "workspace-app-adapter",
  "host_rewrite_literal",
);
if (/^  (?:trusted-hops-count|stream-idle-timeout):/mu.test(kourier)) {
  throw new Error("Kourier must not trust an application-specific proxy hop");
}
const adapter =
  "runtime/source/gitops/components/knative-serving/workspace-app-adapter.yaml";
if (existsSync(join(root, adapter))) {
  throw new Error(
    `${adapter} must not exist; upstream Host routing belongs to Stargate`,
  );
}

requireText(
  "scripts/verify-02.sh",
  "wa-workshop-probe.intar.app",
  "X-Forwarded-Host:",
  "gitea-http.gitea.svc.cluster.local",
);
requireText(
  "scripts/verify-03.sh",
  "http://localhost:30901/",
  "User-Agent: Mozilla/5.0 (compatible; Intar-Workspace-App-Probe/1.0)",
  "X-Forwarded-Port: 443",
  "safe same-origin redirect",
  "unsafe, missing, or duplicate redirect location",
  "redirect target returned HTTP",
  "did not return non-empty HTML",
  "did not reference a JavaScript or CSS asset",
  "http://localhost:30901${rustfs_asset_path}",
  "asset is empty or returned HTML",
);
requireText(
  "scripts/verify-06.sh",
  "upstream_host=hello.demo.127.0.0.1.sslip.io",
  "X-Forwarded-Host:",
  "http://localhost:31080/",
  "did not answer through the declared upstream-host contract",
);
requireText(
  "scripts/verify-08.sh",
  "wa-workshop-probe.intar.app",
  "X-Forwarded-Host:",
  "http://localhost:30600/",
  "canonical workspace-app Host",
  "wa-workshop-probe.intar.app.attacker.invalid",
  "invalid-Host probe",
  "accepted invalid Host",
  '"${invalid_host_status}" != "400"',
  "-X PUT",
  '"${s3_put_status}" != "405"',
  "--head",
  "http://localhost:30600/__intar-s3/app-assets/hello.txt",
  "instead of RustFS 2xx/403",
  "http://localhost:30600/__intar-grafana",
  "safe Intar navigation",
);

requireOrderedText(
  "scripts/catch-up-09.sh",
  "victoria-metrics.yaml",
  "victoria-logs.yaml",
  "victoria-traces.yaml",
  "grafana.yaml",
  "otel-collector.yaml",
  "wait_app victoria-metrics 600",
  "wait_app victoria-logs 600",
  "wait_app victoria-traces 600",
  "wait_app grafana 600",
  "rollout status deployment/grafana --timeout=600s",
  "wait_app otel-collector 600",
  "rollout status deployment/otel-collector-gateway --timeout=600s",
  "rollout status daemonset/otel-collector-agent --timeout=600s",
  "http://localhost:30030/api/health",
  "trap 'rm -f \"$TMP_PNG\"' EXIT",
  "uploading test image through the portal",
  "module09_trace_ready=0",
  "module09_gallery_ready=0",
  "module09_deadline=$((SECONDS + 300))",
  "module09_gallery_last_state=not_checked",
  "curl -sS --max-time 20",
  "module09_attempt % 6 == 0",
  "module 09 connected upload trace did not converge within 300s",
  "Cloudbox gallery did not converge on a non-empty canonical /__intar-s3/ object within 300s",
  "trap - EXIT",
);

requireText(
  "scripts/verify-09.sh",
  "victoria-metrics victoria-logs victoria-traces grafana otel-collector",
  "deployment/otel-collector-gateway",
  "daemonset/otel-collector-agent",
  "services/${backend}:http/proxy/health",
  "http://localhost:30030/api/health",
  "/api/datasources/proxy/uid/victoriametrics/api/v1/query?query=up",
  "/api/datasources/uid/victorialogs/health",
  "/api/datasources/proxy/uid/victoriatraces/api/traces?service=cloudbox-portal&limit=20",
  '["cloudbox-portal", "cloudbox-uploader", "cloudbox-resizer"]',
  "[.processes[]?.serviceName]",
  "module09_trace_ready=0",
  "module09_gallery_ready=0",
  "module09_gallery_last_state=not_checked",
  "curl -sS --max-time 20",
  "module09_deadline=$((SECONDS + 60))",
  "for module09_attempt in $(seq 1 12)",
  "module 09 connected upload trace did not converge within 60s",
  "http://localhost:30600/gallery/grid",
  "Cloudbox gallery exposed a localhost URL",
  "https://wa-workshop-probe\\.intar\\.app/__intar-s3/",
  String.raw`sed 's/&amp;/\&/g'`,
  'module09_gallery_path="${module09_gallery_url#https://wa-workshop-probe.intar.app}"',
  "Cloudbox gallery did not converge on a non-empty canonical /__intar-s3/ object within 60s",
  "module09_gallery_hard_failure=1",
  "grid rendered without a canonical object URL",
  "http://localhost:30600/__intar-s3/app-assets/hello.txt",
  "--head",
  '"${gallery_s3_head_status}" != "403"',
  "instead of RustFS 2xx/403",
);
rejectText(
  "scripts/verify-09.sh",
  "Nothing here yet",
  "contained objects without a canonical",
);

requireText(
  "runtime/source/gitops/components/grafana/service-nodeport.yaml",
  "nodePort: 30030",
);
requireText(
  "runtime/source/gitops/catalog/grafana.yaml",
  "Browser: declared as the Grafana workspace application on port 30030",
);
rejectText(
  "runtime/source/gitops/catalog/grafana.yaml",
  "http://localhost:30030",
  "localhost:30031",
);
requireText(
  "runtime/source/gitops/components/grafana/grafana.yaml",
  "type: victoriametrics-logs-datasource",
  "url: http://victoria-logs.observability.svc.cluster.local:9428",
  "install-victorialogs-datasource",
  "victoriametrics-logs-datasource-v0.29.0.tar.gz",
  "34935dcb7c19107f86a7703ee0a24f40363e0c02483206f3cc9a5de2f5fa4918",
  "GF_PATHS_PLUGINS",
  "value: /opt/grafana-plugins",
  "readOnlyRootFilesystem: true",
  "mountPath: /opt/grafana-plugins",
);
rejectText(
  "runtime/source/gitops/components/grafana/grafana.yaml",
  "type: loki",
  "GF_INSTALL_PLUGINS",
  "GF_PLUGINS_PREINSTALL",
  "/select/logsql/query",
);
requireText(
  "runtime/source/gitops/catalog/victoria-logs.yaml",
  "checksum-pinned native VictoriaLogs plugin",
);
requireText(
  "runtime/source/gitops/components/victoria-logs/victoria-logs.yaml",
  "VictoriaLogs does not expose a Loki query API",
);
rejectText(
  "runtime/source/gitops/catalog/victoria-logs.yaml",
  "Loki-compatible",
);
rejectText(
  "runtime/source/gitops/components/victoria-logs/victoria-logs.yaml",
  "Loki-compatible",
  "/select/loki/",
);
requireText(
  "SOURCE.md",
  "built-in Prometheus and Jaeger datasources",
  "signed VictoriaLogs",
  "verifying the reviewed",
);
rejectText("SOURCE.md", "built-in Prometheus, Loki, and Jaeger datasources");
requireText(
  "slides/slide-018.md",
  "VictoriaLogs** (LogsQL through its native datasource)",
  "checksum-pinned signed VictoriaLogs plugin",
);
rejectText(
  "slides/slide-018.md",
  "VictoriaLogs** (Loki API)",
  "with *built-in* datasources",
);
requireText(
  "slides/notes/slide-018.md",
  "Prometheus/native VictoriaLogs/Jaeger datasources",
);
rejectText(
  "slides/notes/slide-018.md",
  "Prometheus/Loki/Jaeger datasources",
);

requireText(
  "content/module-02.md",
  "under **Workspace applications** in the Intar workshop room, open **Gitea**",
  "from the same **Workspace applications** list, open **Argo CD**",
);
rejectText(
  "content/module-02.md",
  "Gitea: http://localhost:30300",
  "ArgoCD: http://localhost:30080",
);
requireText(
  "content/module-03.md",
  "prove it with `curl --fail` from the same",
  "guest-local and intentionally not exposed as a",
  "open **RustFS** under **Workspace applications**",
);
rejectText(
  "content/module-03.md",
  "Open it in your browser",
  "download link to someone with zero AWS involved",
);
requireText(
  "hints/module-03-05.md",
  "docker run --rm --network host -i",
  "public.ecr.aws/aws-cli/aws-cli@sha256:bad3346a39098ab077be6ed58c7e1fe68321a4a844c7c740318100013e6c3581",
  'PRESIGNED_URL="$(aws_s3 s3 presign',
  'curl --fail --show-error "$PRESIGNED_URL"',
  "Workspace applications → RustFS",
  "S3 API URL is guest-local",
);
rejectText("hints/module-03-05.md", "open the printed URL in your browser");
for (const relative of [
  "content/module-03-solution.md",
  "scripts/catch-up-03.sh",
]) {
  requireText(
    relative,
    "docker run --rm --network host -i",
    "public.ecr.aws/aws-cli/aws-cli@sha256:bad3346a39098ab077be6ed58c7e1fe68321a4a844c7c740318100013e6c3581",
    'PRESIGNED_URL="$(aws_s3 s3 presign',
    'curl --fail --show-error --output /dev/null "$PRESIGNED_URL"',
    "Presigned object download verified inside the learner VM.",
  );
  rejectText(relative, "if command -v aws", "in-cluster aws-cli pod");
}
requireText(
  "scripts/verify-03.sh",
  "rustfs_object_key",
  "rustfs_presigned_url",
  "RustFS presigned download failed inside the learner VM",
  "docker run --rm --network host -i",
  "public.ecr.aws/aws-cli/aws-cli@sha256:bad3346a39098ab077be6ed58c7e1fe68321a4a844c7c740318100013e6c3581",
);
requireText(
  "facilitator/module-03.md",
  "guest-local presigned URL with `curl` in the learner terminal",
  "private facilitator screen",
  "roster-by-module live-verification view",
  "watch Intar's **Need help** queue",
  "module-03 catch-up checkpoint through Intar",
);
rejectText(
  "facilitator/module-03.md",
  "Cloudbox Console's Workshop page up on the projector",
  "sweep for red stickies",
  "catch-up.sh 3",
);
requireText(
  "facilitator/module-07.md",
  "facilitator is explicitly enrolled with a workspace",
  "consenting participant's shared workspace",
  "guest-local OCI API",
);
rejectText("facilitator/module-07.md", "projector cluster");
requireText(
  "content/module-08.md",
  "Open it under **Workspace applications**",
  "the Intar workshop room",
  "not a declared Intar workspace application",
);
rejectText(
  "content/module-08.md",
  "http://localhost:30600",
  "guest sign-in at :30700",
);
requireText(
  "content/module-09.md",
  "under **Workspace applications** in the Intar workshop room, open **Cloudbox Console**",
  "in **Grafana** under **Workspace applications** in the Intar workshop room",
);
rejectText(
  "content/module-09.md",
  "http://localhost:30600/gallery",
  "http://localhost:30030",
);
requireText(
  "hints/module-08-04.md",
  "Workspace applications → Cloudbox Console → Databases",
);
rejectText("hints/module-08-04.md", "open http://localhost:30600");
requireText(
  "hints/module-09-05.md",
  "open **Grafana** under **Workspace applications** in the Intar workshop room",
);
rejectText("hints/module-09-05.md", "http://localhost:30030");
requireText(
  "hints/module-09-06.md",
  "Workspace applications → Cloudbox Console → Gallery",
  "aws --endpoint-url http://localhost:30900",
);
rejectText("hints/module-09-06.md", "http://localhost:30600/gallery");

requireText(
  "slides/slide-025.md",
  "Intar workshop room → **Agenda** → **Live verification**",
  "Verification latches; later regressions remain visible",
);
rejectText("slides/slide-025.md", "Cloudbox Console", "localhost");
requireText(
  "slides/notes/slide-025.md",
  "technical verification",
  "current probe health",
  "caught-up state",
  "explain-back",
);
requireText(
  "slides/slide-064.md",
  "in Intar, open Workspace applications → Cloudbox Console",
);
rejectText("slides/slide-064.md", "open http://localhost:30600");
for (const relative of [
  "facilitator/module-08.md",
  "slides/notes/slide-063.md",
]) {
  requireText(
    relative,
    "Backstage is not a declared Intar workspace application",
  );
  rejectText(relative, "guest sign-in at :30700");
}
requireText(
  "facilitator/module-08.md",
  "open **Cloudbox Console** under **Workspace applications**",
  "It becomes available with module 08",
  "Intar's native verification view used earlier",
);
rejectText(
  "facilitator/module-08.md",
  "explore the Console at :30600",
  "they've been watching all day",
);
requireText(
  "slides/notes/slide-040.md",
  "Intar's synchronized break timer",
  "private facilitator screen",
  "Need help",
);
rejectText(
  "slides/notes/slide-040.md",
  "Cloudbox Console",
  "red stickies",
);
requireText(
  "slides/notes/slide-055.md",
  "facilitator is explicitly enrolled with a workspace",
  "consenting participant's shared workspace",
);
rejectText("slides/notes/slide-055.md", "projector cluster");
requireText(
  "slides/notes/slide-064.md",
  "open **Cloudbox Console** under **Workspace applications**",
  "It becomes available with module 08",
);
rejectText(
  "slides/notes/slide-064.md",
  "explore the Console at :30600",
  "they've been watching all day",
);

requireText(
  "content/module-08-solution.md",
  "curl -fsS --max-time 5 -o /dev/null http://localhost:30600/",
  "open it under Workspace applications in the Intar room",
  "see it in Cloudbox Console under Databases",
);
requireText(
  "scripts/catch-up-08.sh",
  "curl -fsS --max-time 5 -o /dev/null http://localhost:30600/",
  "open it under Workspace applications in the Intar room",
  "see it in Cloudbox Console under Databases",
);
requireText(
  "content/module-09-solution.md",
  "http://localhost:30600/gallery/upload",
  "see it in Cloudbox Console under Gallery",
);
requireText(
  "scripts/catch-up-09.sh",
  "http://localhost:30600/gallery/upload",
  "see it in Cloudbox Console under Gallery",
);

for (const relative of [
  "runtime/source/lab/02-gitops/verify.sh",
  "runtime/source/lab/03-data/verify.sh",
  "runtime/source/lab/04-self-service/verify.sh",
]) {
  requireText(relative, "Workspace applications in the Intar room");
  rejectText(relative, "open http://localhost:30080", "Check http://localhost:30080");
}
requireText(
  "runtime/source/lab/08-portal/verify.sh",
  "curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://localhost:30600/",
  "Cloudbox Console's New database form in Intar",
);
rejectText(
  "runtime/source/lab/08-portal/verify.sh",
  "(http://localhost:30600/databases)",
);
requireText(
  "runtime/source/lab/09-capstone/verify.sh",
  "aws --endpoint-url http://localhost:30900",
  "Cloudbox Console's Gallery in Intar",
);
rejectText(
  "runtime/source/lab/09-capstone/verify.sh",
  "photo at http://localhost:30600/gallery",
);

requireText(
  "content/module-01.md",
  "dedicated Intar",
  "learner VM",
  "facilitator can restore the canonical checkpoint",
);
rejectText(
  "content/module-01.md",
  "runs on your laptop",
  "Docker on your laptop",
  "./scripts/kind-fallback.sh",
  "images are already local",
);
requireText(
  "facilitator/module-00.md",
  "dedicated Intar workspace",
  "Hetzner CPX42",
  "GCP e2-standard-4",
  "registry egress",
  "Intar recovery path",
);
rejectText(
  "facilitator/module-00.md",
  "Docker Desktop",
  "OrbStack",
  "WSL2",
  "Codespaces",
  "airplane mode",
  "prework email",
);
requireText(
  "hints/module-00-02.md",
  "Platform Engineering production revision",
  "pins CPX42 for Hetzner sessions",
  "e2-standard-4 with a pd-balanced boot disk for GCP sessions",
);
requireText(
  "slides/slide-005.md",
  "inside your **own workspace**",
  "Your connected cloud project",
  "Verified teardown",
);
rejectText("slides/slide-005.md", "No account", "No bill", "tomorrow");
requireText(
  "slides/slide-019.md",
  "runtime/images.lock",
  "**Fits one 16 GiB learner VM**",
  "Talos, Docker, and Debian",
);
rejectText("slides/slide-019.md", "16 GB laptop", "≥10 GB to Docker");
requireText(
  "slides/slide-023.md",
  "**Need help**",
  "browser-terminal assistance",
  "Restore or recreate through Intar",
);
rejectText(
  "slides/slide-023.md",
  "green sticky",
  "red sticky",
  "Devcontainer",
);
requireText(
  "slides/slide-028.md",
  "dedicated Intar workspace is provably ready",
  "**Need help**",
);
requireText(
  "slides/slide-080.md",
  "Your learner VM",
  "live until verified teardown",
);
requireText(
  "slides/slide-085.md",
  "**Every layer understood. Your platform. Your terms.**",
);
for (const relative of [
  "slides/notes/slide-005.md",
  "slides/notes/slide-026.md",
  "slides/notes/slide-027.md",
  "slides/notes/slide-028.md",
  "slides/notes/slide-080.md",
  "slides/notes/slide-085.md",
]) {
  rejectText(
    relative,
    "Docker Desktop",
    "OrbStack",
    "WSL2",
    "Codespaces",
    "airplane mode",
    "No bill",
    "laptop lid",
    "cluster on your laptop",
  );
}
requireText(
  "slides/notes/slide-080.md",
  "billed directly to the organization's selected BYOK cloud project",
  "zero instances, disks, addresses, routes, keys, grants, operations, or slots",
);

requireText(
  "slides/slide-063.md",
  "# Interlude: Backstage, unpacked",
  "bundled screenshots",
  "hosted runtime intentionally disabled",
);
for (const relative of [
  "facilitator/module-05.md",
  "facilitator/module-08.md",
  "slides/notes/slide-049.md",
  "slides/notes/slide-062.md",
  "slides/notes/slide-063.md",
]) {
  rejectText(
    relative,
    "pre-enable backstage.yaml",
    "Backstage live",
    "backstage.yaml was pre-enabled",
    "backstage.yaml stays in the catalog",
  );
}
requireText(
  "runtime/source/gitops/catalog/backstage.yaml",
  "keep this disabled",
  "no Backstage workspace application route is declared",
);
rejectText(
  "runtime/source/gitops/catalog/backstage.yaml",
  "commit -m 'enable backstage'",
);
rejectText(
  "slides/notes/slide-025.md",
  "~100 lines of Go",
  "everyone's laptop",
);
requireText(
  "runtime/source/gitops/components/portal/portal.yaml",
  "sidecar rewrites rendered URLs to a route-local /__intar-s3/",
  "Grafana route under Workspace applications in the Intar room",
);
rejectText(
  "runtime/source/gitops/components/portal/portal.yaml",
  "as seen from the attendee's machine",
  "Browser-facing Grafana (NodePort 30030",
);

const imageLock = read("runtime/images.lock");
const runtimeImageLock = read("runtime/source/scripts/images.lock");
if (imageLock !== runtimeImageLock) {
  throw new Error("workshop runtime image locks differ");
}
const imageLockSha256 = createHash("sha256").update(imageLock).digest("hex");
if (
  imageLockSha256 !==
  "2a8e6a7b2122095ce0a5e569ae065018ca822c53eb0833f090cb43e672638f30"
) {
  throw new Error("workspace application routing must not add a runtime image");
}

process.stdout.write(
  `Verified configuration-only workspace application routing under ${root}\n`,
);
