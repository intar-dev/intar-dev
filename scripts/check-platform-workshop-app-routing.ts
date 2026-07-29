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

const versions = requireText(
  "runtime/source/scripts/versions.env",
  'NODEPORT_RUSTFS_CONSOLE="30901"',
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

const imageLock = read("runtime/images.lock");
const runtimeImageLock = read("runtime/source/scripts/images.lock");
if (imageLock !== runtimeImageLock) {
  throw new Error("workshop runtime image locks differ");
}
const imageLockSha256 = createHash("sha256").update(imageLock).digest("hex");
if (
  imageLockSha256 !==
  "24c00299502b37b53197fa4aaf668f1954c0e807b59d7da473705df40bf8df4a"
) {
  throw new Error("workspace application routing must not add a runtime image");
}

process.stdout.write(
  `Verified configuration-only workspace application routing under ${root}\n`,
);
