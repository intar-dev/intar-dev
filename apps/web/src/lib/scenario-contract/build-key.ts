// `build_key`, the identity of a built image: a byte-exact port of
// crates/intar-contracts/src/scenario/build_key.rs, which documents the
// encoding. The golden vectors in fixtures/scenario/build-keys.json pin it.

import { CLUSTER_BAKE_REVISION, IMAGE_FORMAT, PLATFORM_BASE_IMAGE } from "@/generated/constants";
import type {
  ClusterV1,
  ImageV1,
  MachineV1,
  ScenarioV1,
  ScriptV1,
} from "@/generated/contracts/source-bundle-v2";
import { byteOrder, sha256Digest } from "./canonical-json";

export interface BuildKeys {
  images: Record<string, string>;
  machines: Record<string, string>;
  clusters: Record<string, string>;
}

interface BuildRecord {
  kind: "base" | "image" | "machine";
  parent: string;
  defer: string[];
  env: MachineV1["env"] | null;
  stages: ScriptV1[];
  disk: number | null;
}

const encoder = new TextEncoder();

class Encoding {
  chunks: Uint8Array[] = [];
  count(length: number) {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, length);
    this.chunks.push(bytes);
  }
  put(text: string) {
    const bytes = encoder.encode(text);
    this.count(bytes.length);
    this.chunks.push(bytes);
  }
  digest(): Promise<string> {
    const bytes = new Uint8Array(this.chunks.reduce((total, chunk) => total + chunk.length, 0));
    let offset = 0;
    for (const chunk of this.chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return sha256Digest(bytes);
  }
}

async function clusterKey(
  cluster: ClusterV1,
  machines: MachineV1[],
  images: Record<string, string>,
): Promise<string> {
  const e = new Encoding();
  for (const text of [IMAGE_FORMAT, "cluster", CLUSTER_BAKE_REVISION, cluster.talos, cluster.kubernetes, cluster.name]) e.put(text);
  const nodes = machines.filter(
    (machine) => machine.cluster?.cluster === cluster.name && machine.cluster.role !== "management",
  );
  e.count(nodes.length);
  for (const node of nodes) {
    e.put(node.name);
    e.put(node.cluster!.role);
    e.put(String(node.disk_mib));
  }
  e.count(cluster.patches.length);
  for (const patch of cluster.patches) {
    e.put(patch.name);
    e.put(patch.script);
  }
  // The management machine's own key: a change to any machine of the
  // cluster changes every machine's key (one bake, one PKI).
  const management = machines.filter(
    (machine) => machine.cluster?.cluster === cluster.name && machine.cluster.role === "management",
  );
  e.count(management.length);
  for (const machine of management) {
    e.put(machine.name);
    e.put(await machineKey(machine, images));
  }
  return e.digest();
}

function clusterMachineKey(cluster: string, name: string, role: string, own: string): Promise<string> {
  const e = new Encoding();
  for (const text of [IMAGE_FORMAT, "cluster-machine", cluster, name, role, own]) e.put(text);
  return e.digest();
}

function key(record: BuildRecord): Promise<string> {
  const e = new Encoding();
  e.put(IMAGE_FORMAT);
  e.put(record.kind);
  e.put(record.parent);
  const defer = [...new Set(record.defer)].sort(byteOrder);
  e.count(defer.length);
  for (const unit of defer) e.put(unit);
  const env = Object.entries(record.env ?? {}).sort(([a], [b]) => byteOrder(a, b));
  e.count(env.length);
  for (const [name, value] of env) {
    e.put(name);
    e.put(value ?? "");
  }
  e.count(record.stages.length);
  for (const stage of record.stages) {
    e.put(stage.name);
    e.put(stage.script);
  }
  e.put(record.disk === null ? "" : String(record.disk));
  return e.digest();
}

/** The key of the platform base `trixie`. */
export function baseKey(): Promise<string> {
  return key({
    kind: "base",
    parent: PLATFORM_BASE_IMAGE,
    defer: [],
    env: null,
    stages: [],
    disk: null,
  });
}

/** The key of every repository image; throws why one has none. */
export async function imageKeys(images: ImageV1[]): Promise<Record<string, string>> {
  const byName = new Map(images.map((image) => [image.name, image]));
  const keys = new Map<string, string>();
  const imageKey = async (name: string, walking: string[]): Promise<string> => {
    if (name === PLATFORM_BASE_IMAGE) return baseKey();
    const found = keys.get(name);
    if (found) return found;
    if (walking.includes(name)) {
      throw new Error(`image \`${name}\`: its from chain forms a cycle`);
    }
    const image = byName.get(name);
    if (!image) throw new Error(`\`${name}\` names no image`);
    const parent = await imageKey(image.from, [...walking, name]);
    const computed = await key({
      kind: "image",
      parent,
      defer: image.defer,
      env: null,
      stages: image.setup,
      disk: image.from === PLATFORM_BASE_IMAGE ? (image.disk_mib ?? null) : null,
    });
    keys.set(name, computed);
    return computed;
  };
  for (const image of images) await imageKey(image.name, []);
  return Object.fromEntries(keys);
}

async function machineKey(
  machine: MachineV1,
  images: Record<string, string>,
): Promise<string> {
  const onBase = machine.from === PLATFORM_BASE_IMAGE;
  const parent = onBase ? await baseKey() : images[machine.from];
  if (parent === undefined) {
    throw new Error(`machine \`${machine.name}\`: from \`${machine.from}\` names no image`);
  }
  // `packages` is lowered into the first setup stage.
  const builds = machine.setup.length > 0;
  if (onBase && !builds && machine.defer.length === 0) return parent;
  return key({
    kind: "machine",
    parent,
    defer: machine.defer,
    env: builds ? machine.env : null,
    stages: machine.setup,
    disk: onBase && builds ? machine.disk_mib : null,
  });
}

/** The key of every machine of `scenario` and of every repository image. */
export async function buildKeys(
  scenario: Pick<ScenarioV1, "machines" | "clusters">,
  images: ImageV1[],
): Promise<BuildKeys> {
  const imageKeysByName = await imageKeys(images);
  const clusters: Record<string, string> = {};
  for (const cluster of scenario.clusters ?? []) {
    clusters[cluster.name] = await clusterKey(cluster, scenario.machines, imageKeysByName);
  }
  const machines: Record<string, string> = {};
  for (const machine of scenario.machines) {
    const member = machine.cluster;
    if (member == null) {
      machines[machine.name] = await machineKey(machine, imageKeysByName);
      continue;
    }
    const cluster = clusters[member.cluster];
    if (cluster === undefined) {
      throw new Error(`machine \`${machine.name}\`: cluster \`${member.cluster}\` is not declared`);
    }
    const own = member.role === "management" ? await machineKey(machine, imageKeysByName) : "";
    machines[machine.name] = await clusterMachineKey(cluster, machine.name, member.role, own);
  }
  return { images: imageKeysByName, machines, clusters };
}
