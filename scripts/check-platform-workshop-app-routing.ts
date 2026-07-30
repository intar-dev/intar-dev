#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "workshops/platform-engineering");

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

const manifest = read("workshop.hcl");
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
  "uploading test image through the portal",
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
  "VictoriaTraces datasource did not expose one connected upload trace",
);

requireText(
  "runtime/source/gitops/components/grafana/service-nodeport.yaml",
  "nodePort: 30030",
);
requireText(
  "runtime/source/gitops/catalog/grafana.yaml",
  "Browser: http://localhost:30030",
);
rejectText(
  "runtime/source/gitops/catalog/grafana.yaml",
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
