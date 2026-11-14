// `build_key`, the identity of a built image: a byte-exact port of
// crates/intar-contracts/src/scenario/build_key.rs, which documents the
// encoding. The golden vectors in fixtures/scenario/build-keys.json pin it.

import { IMAGE_FORMAT, PLATFORM_BASE_IMAGE } from "@/generated/constants";
import type {
  ImageV1,
  MachineV1,
  ScenarioV1,
  ScriptV1,
} from "@/generated/contracts/source-bundle-v2";
import { byteOrder, sha256Digest } from "./canonical-json";

export interface BuildKeys {
  images: Record<string, string>;
  machines: Record<string, string>;
}

interface BuildRecord {
  kind: "base" | "image" | "machine";
  parent: string;
  defer: string[];
  env: MachineV1["env"] | null;
  stages: ScriptV1[];
  disk: number | null;
  wake: boolean;
}

const encoder = new TextEncoder();

function key(record: BuildRecord): Promise<string> {
  const chunks: Uint8Array[] = [];
  const count = (length: number) => {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, length);
    chunks.push(bytes);
  };
  const put = (text: string) => {
    const bytes = encoder.encode(text);
    count(bytes.length);
    chunks.push(bytes);
  };
  put(IMAGE_FORMAT);
  put(record.kind);
  put(record.parent);
  const defer = [...new Set(record.defer)].sort(byteOrder);
  count(defer.length);
  defer.forEach(put);
  const env = Object.entries(record.env ?? {}).sort(([a], [b]) => byteOrder(a, b));
  count(env.length);
  for (const [name, value] of env) {
    put(name);
    put(value ?? "");
  }
  count(record.stages.length);
  for (const stage of record.stages) {
    put(stage.name);
    put(stage.script);
  }
  put(record.disk === null ? "" : String(record.disk));
  if (record.wake) put("wake");

  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return sha256Digest(bytes);
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
    wake: false,
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
      wake: image.wake === true,
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
    wake: false,
  });
}

/** The key of every machine of `scenario` and of every repository image. */
export async function buildKeys(
  scenario: Pick<ScenarioV1, "machines">,
  images: ImageV1[],
): Promise<BuildKeys> {
  const imageKeysByName = await imageKeys(images);
  const machines: Record<string, string> = {};
  for (const machine of scenario.machines) {
    machines[machine.name] = await machineKey(machine, imageKeysByName);
  }
  return { images: imageKeysByName, machines };
}
