// Ports of `validate`, `validate_images` (crates/intar-contracts/src/scenario.rs)
// and `validate_bundle` (src/source.rs): the same rules, limits and problem
// texts in the same order. Each returns every problem found; none means
// valid. Inputs have passed the generated schema validator.

import {
  IMAGE_FORMAT,
  MAX_DISK_MIB,
  MAX_MACHINES,
  MAX_MACHINE_SPEC_BYTES,
  MAX_MARKDOWN_BYTES,
  MAX_READY_PER_MACHINE,
  MAX_SCRIPT_BYTES,
  MAX_TASKS_PER_MACHINE,
  PLATFORM_BASE_IMAGE,
  SOURCE_COMPILER_VERSION_V2,
} from "@/generated/constants";
import type {
  HintV1,
  ImageV1,
  ScenarioV1,
  ScriptV1,
  SourceBundleV2,
} from "@/generated/contracts/source-bundle-v2";
import { byteOrder, utf8Length } from "./canonical-json";
import { machineSpec } from "./machine-spec";

type Problem = (text: string) => void;

/** `^[a-z0-9][a-z0-9-]{2,62}$` */
export const isId = (value: string) => /^[a-z0-9][a-z0-9-]{2,62}$/.test(value);

// What Rust's `str::trim` removes: Unicode White_Space, which differs from
// JavaScript's `trim` at U+0085 and U+FEFF.
const blank =
  /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/u;

const sortedKeys = <T>(map: Map<string, T>) => [...map.keys()].sort(byteOrder);

/** A node on a cycle of `edges`, if any. Edges to unknown nodes are ignored. */
function cycleMember(edges: Map<string, string[]>): string | undefined {
  // Kahn: peel nodes nothing unpeeled points at; what is left holds a cycle.
  const left = new Set(sortedKeys(edges));
  for (;;) {
    const free = [...left].find((node) =>
      (edges.get(node) ?? []).every((next) => !left.has(next)),
    );
    if (free === undefined) return [...left][0];
    left.delete(free);
  }
}

function checkScripts(context: string, scripts: ScriptV1[], problem: Problem) {
  const names = new Set<string>();
  for (const { name, script } of scripts) {
    if (!isId(name)) problem(`${context} \`${name}\`: not a valid ID`);
    if (names.has(name)) problem(`${context} \`${name}\`: declared twice`);
    names.add(name);
    if (utf8Length(script) > MAX_SCRIPT_BYTES) {
      problem(`${context} \`${name}\`: over ${MAX_SCRIPT_BYTES} bytes`);
    }
  }
}

function checkHints(context: string, hints: HintV1[], problem: Problem) {
  const ids = new Set<string>();
  for (const { id, body } of hints) {
    if (!isId(id)) problem(`${context} hint \`${id}\`: not a valid ID`);
    if (ids.has(id)) problem(`${context} hint \`${id}\`: declared twice`);
    ids.add(id);
    if (utf8Length(body) > MAX_MARKDOWN_BYTES) {
      problem(`${context} hint \`${id}\`: over ${MAX_MARKDOWN_BYTES} bytes`);
    }
  }
}

/**
 * Each usable `from` name with its chain's disk geometry in MiB (0 for the
 * platform base, which a machine may grow freely).
 */
function imageGeometry(images: ImageV1[], problem: Problem): Map<string, number> {
  const byName = new Map<string, ImageV1>();
  for (const image of images) {
    const { name } = image;
    if (!isId(name) || name === PLATFORM_BASE_IMAGE) {
      problem(`image \`${name}\`: not a valid image name`);
    }
    if (byName.has(name)) problem(`image \`${name}\`: declared twice`);
    byName.set(name, image);
    const disk = image.disk_mib;
    if ((image.from === PLATFORM_BASE_IMAGE) !== (disk != null)) {
      problem(
        `image \`${name}\`: disk is set exactly when from is \`${PLATFORM_BASE_IMAGE}\``,
      );
    }
    if (disk != null && disk > MAX_DISK_MIB) {
      problem(`image \`${name}\`: disk is over the ${MAX_DISK_MIB} MiB limit`);
    }
    checkScripts(`image \`${name}\` setup`, image.setup, problem);
    if (images.some((parent) => parent.wake === true && parent.name === image.from)) {
      problem(
        `image \`${name}\`: from the wake image \`${image.from}\`; only a machine can start from a wake image`,
      );
    }
  }
  const edges = new Map([...byName].map(([name, image]) => [name, [image.from]]));
  const looped = cycleMember(edges);
  if (looped !== undefined) {
    problem(`image \`${looped}\`: its from chain forms a cycle`);
    return new Map();
  }
  const geometry = new Map([[PLATFORM_BASE_IMAGE, 0]]);
  for (const name of sortedKeys(byName)) {
    let image = byName.get(name)!;
    // No cycle, so the walk ends at the base or at an unknown name.
    while (image.from !== PLATFORM_BASE_IMAGE) {
      const parent = byName.get(image.from);
      if (!parent) break;
      image = parent;
    }
    if (image.from === PLATFORM_BASE_IMAGE) {
      geometry.set(name, image.disk_mib ?? 0);
    } else {
      problem(`image \`${name}\`: from \`${image.from}\` names no image`);
    }
  }
  return geometry;
}

/** The image rules alone, for a repository that may have no scenario. */
export function validateImages(images: ImageV1[]): string[] {
  const problems: string[] = [];
  imageGeometry(images, (text) => problems.push(text));
  return problems;
}

/** Every rule a lowered scenario and its repository's images must keep. */
export function validate(scenario: ScenarioV1, images: ImageV1[]): string[] {
  const problems: string[] = [];
  const problem: Problem = (text) => problems.push(text);

  const geometry = imageGeometry(images, problem);

  if (!isId(scenario.slug)) problem(`scenario \`${scenario.slug}\`: not a valid ID`);
  for (const [field, text] of [
    ["briefing", scenario.briefing],
    ["solution", scenario.solution],
    ["credit", scenario.credit],
  ] as const) {
    if (text != null && utf8Length(text) > MAX_MARKDOWN_BYTES) {
      problem(`${field}: over ${MAX_MARKDOWN_BYTES} bytes`);
    }
  }
  checkHints("scenario", scenario.hints, problem);

  if (scenario.machines.length === 0 || scenario.machines.length > MAX_MACHINES) {
    problem(`a scenario has 1 to ${MAX_MACHINES} machines`);
  }
  const machineNames = new Set<string>();
  for (const machine of scenario.machines) {
    const { name } = machine;
    if (!isId(name)) problem(`machine \`${name}\`: not a valid ID`);
    if (machineNames.has(name)) problem(`machine \`${name}\`: declared twice`);
    machineNames.add(name);
    if (machine.cpu_millis === 0 || machine.memory_mib === 0) {
      problem(`machine \`${name}\`: cpu and memory must be above zero`);
    }
    const minimum = geometry.get(machine.from);
    if (minimum === undefined) {
      problem(`machine \`${name}\`: from \`${machine.from}\` names no image`);
    } else if (machine.disk_mib < minimum) {
      problem(`machine \`${name}\`: disk is smaller than its image's ${minimum} MiB`);
    }
    const fromWake = images.some((image) => image.wake === true && image.name === machine.from);
    if (fromWake && machine.setup[0]?.name === "packages") {
      problem(
        `machine \`${name}\`: a machine from the wake image \`${machine.from}\` installs no packages; move them into the image`,
      );
    }
    if (machine.disk_mib > MAX_DISK_MIB) {
      problem(`machine \`${name}\`: disk is over the ${MAX_DISK_MIB} MiB limit`);
    }
    if (machine.ready.length > MAX_READY_PER_MACHINE) {
      problem(`machine \`${name}\`: more than ${MAX_READY_PER_MACHINE} ready blocks`);
    }
    checkScripts(`machine \`${name}\` setup`, machine.setup, problem);
    checkScripts(`machine \`${name}\` ready`, machine.ready, problem);
    if (scenario.tasks.filter((task) => task.machine === name).length > MAX_TASKS_PER_MACHINE) {
      problem(`machine \`${name}\`: more than ${MAX_TASKS_PER_MACHINE} tasks`);
    }
    const spec = machineSpec(scenario, "", name, "verify");
    if (!spec || utf8Length(JSON.stringify(spec)) > MAX_MACHINE_SPEC_BYTES) {
      problem(`machine \`${name}\`: its spec is over ${MAX_MACHINE_SPEC_BYTES} bytes`);
    }
  }

  const taskIds = new Set<string>();
  for (const task of scenario.tasks) {
    const { id } = task;
    if (!isId(id)) problem(`task \`${id}\`: not a valid ID`);
    if (taskIds.has(id)) problem(`task \`${id}\`: declared twice`);
    taskIds.add(id);
    if (!machineNames.has(task.machine)) {
      problem(`task \`${id}\`: machine \`${task.machine}\` is not declared`);
    }
    if (blank.test(task.check)) problem(`task \`${id}\`: needs a check`);
    if (task.solve == null && task.needs.length === 0) {
      problem(`task \`${id}\`: has neither solve nor needs, so it cannot be verified`);
    }
    for (const [what, script] of [["check", task.check], ["solve", task.solve]] as const) {
      if (script != null && utf8Length(script) > MAX_SCRIPT_BYTES) {
        problem(`task \`${id}\` ${what}: over ${MAX_SCRIPT_BYTES} bytes`);
      }
    }
    if (task.body != null && utf8Length(task.body) > MAX_MARKDOWN_BYTES) {
      problem(`task \`${id}\` body: over ${MAX_MARKDOWN_BYTES} bytes`);
    }
    checkHints(`task \`${id}\``, task.hints, problem);
  }
  for (const task of scenario.tasks) {
    for (const need of task.needs) {
      if (!taskIds.has(need)) problem(`task \`${task.id}\`: needs unknown task \`${need}\``);
    }
  }
  const looped = cycleMember(new Map(scenario.tasks.map((task) => [task.id, task.needs])));
  if (looped !== undefined) problem(`task \`${looped}\`: its needs form a cycle`);

  return problems;
}

/** Every rule a bundle must keep, each problem listed once. */
export function validateBundle(bundle: SourceBundleV2): string[] {
  const problems: string[] = [];
  if (bundle.compiler !== SOURCE_COMPILER_VERSION_V2) {
    problems.push(`compiler \`${bundle.compiler}\` is not current`);
  }
  if (bundle.image_format !== IMAGE_FORMAT) {
    problems.push(`image format \`${bundle.image_format}\` is not current`);
  }
  problems.push(...validateImages(bundle.images));
  const slugs = new Set<string>();
  for (const scenario of bundle.scenarios) {
    if (slugs.has(scenario.slug)) problems.push(`scenario \`${scenario.slug}\`: declared twice`);
    slugs.add(scenario.slug);
    for (const found of validate(scenario, bundle.images)) {
      // Image problems are already listed once.
      problems.push(found.startsWith("image `") ? found : `scenario \`${scenario.slug}\`: ${found}`);
    }
  }
  const catalog = bundle.course_catalog;
  if (catalog.version !== 2) problems.push(`course catalog version ${catalog.version} is not 2`);
  const courses = new Set<string>();
  for (const course of catalog.courses) {
    if (courses.has(course.course_id)) problems.push(`course \`${course.course_id}\`: declared twice`);
    courses.add(course.course_id);
    const lectures = new Set<string>();
    for (const lecture of course.lectures) {
      const at = `lecture \`${course.course_id}/${lecture.lecture_id}\``;
      if (lectures.has(lecture.lecture_id)) problems.push(`${at}: declared twice`);
      lectures.add(lecture.lecture_id);
      const slug = lecture.scenario_id;
      if (slug != null && !slugs.has(slug)) {
        problems.push(`${at}: scenario \`${slug}\` is not in this repository`);
      }
    }
  }
  return [...new Set(problems)];
}
