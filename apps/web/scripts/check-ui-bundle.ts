import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const assetDirectory = fileURLToPath(
  new URL("../dist/client/_astro/", import.meta.url),
);
const kibibyte = 1024;

const leafBudgets = [
  { prefix: "App", maximumKiB: 40, required: true },
  { prefix: "Dashboard", maximumKiB: 12, required: true },
  { prefix: "ScenarioRun", maximumKiB: 22, required: true },
  { prefix: "RunArtifactViewer", maximumKiB: 8, required: false },
  { prefix: "NativeSshDialogButton", maximumKiB: 24, required: true },
  { prefix: "terminal", maximumKiB: 95, required: true },
] as const;

const routeClosureBudgets = [
  { prefix: "Dashboard", maximumKiB: 28 },
  { prefix: "ScenarioRun", maximumKiB: 80 },
] as const;

const onDemandPrefixes = [
  "terminal",
  "NativeSshDialogButton",
  "RunArtifactViewer",
] as const;

const staticImportPattern =
  /\b(?:import(?!\s*\()|export)\s*(?:[\w$*{},\s]+\s*from\s*)?["']([^"']+)["']/g;

async function main() {
  const assets = await readAssets();
  const errors: string[] = [];
  const reports: string[] = [];

  const editorAssets = assets.filter((asset) => asset.startsWith("editor."));
  if (editorAssets.length > 0) {
    errors.push(
      `CodeMirror editor chunk must not be emitted: ${editorAssets.join(", ")}`,
    );
  }

  const chunks = await readChunks(assets);
  const gzipSizes = gzipSizesFor(chunks);
  const leafAssets = new Map<string, string>();

  for (const budget of leafBudgets) {
    const asset = findChunk(budget.prefix, chunks, budget.required, errors);
    if (!asset) continue;

    leafAssets.set(budget.prefix, asset);
    checkGzipBudget({
      label: asset,
      gzipBytes: gzipSizes.get(asset)!,
      maximumKiB: budget.maximumKiB,
      errors,
      reports,
    });
  }

  const appAsset = leafAssets.get("App");
  if (appAsset) {
    const appClosure = collectStaticImportClosure(appAsset, chunks);
    reports.push(
      `App static closure: ${formatKiB(sumGzipBytes(appClosure, gzipSizes))} KiB (${appClosure.size} chunks)`,
    );
    rejectEagerOnDemandChunks("App", appClosure, errors);

    for (const budget of routeClosureBudgets) {
      const asset = leafAssets.get(budget.prefix);
      if (!asset) continue;

      const routeClosure = collectStaticImportClosure(asset, chunks);
      const incrementalClosure = subtractChunks(routeClosure, appClosure);
      const label = `${budget.prefix} static closure after App`;

      checkGzipBudget({
        label,
        gzipBytes: sumGzipBytes(incrementalClosure, gzipSizes),
        maximumKiB: budget.maximumKiB,
        errors,
        reports,
        chunkCount: incrementalClosure.size,
      });
      rejectEagerOnDemandChunks(budget.prefix, routeClosure, errors);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      ["UI bundle budget check failed:", ...errors.map((error) => `- ${error}`)].join(
        "\n",
      ),
    );
  }

  console.log(
    ["UI bundle gzip budgets passed:", ...reports.map((report) => `- ${report}`)].join(
      "\n",
    ),
  );
}

async function readAssets() {
  try {
    return await readdir(assetDirectory);
  } catch {
    throw new Error(
      `UI bundle output is missing: ${assetDirectory}. Run an Astro production build first.`,
    );
  }
}

async function readChunks(assets: readonly string[]) {
  const chunkEntries = await Promise.all(
    assets
      .filter((asset) => asset.endsWith(".js"))
      .map(async (asset) => {
        const source = await readFile(`${assetDirectory}/${asset}`, "utf8");
        return [asset, source] as const;
      }),
  );

  return new Map(chunkEntries);
}

function gzipSizesFor(chunks: ReadonlyMap<string, string>) {
  return new Map(
    [...chunks].map(([asset, source]) => [
      asset,
      gzipSync(source, { level: 9 }).byteLength,
    ]),
  );
}

function findChunk(
  prefix: string,
  chunks: ReadonlyMap<string, string>,
  required: boolean,
  errors: string[],
) {
  const matches = [...chunks.keys()].filter(
    (asset) => asset.startsWith(`${prefix}.`) && asset.endsWith(".js"),
  );

  if (matches.length === 0) {
    if (required) {
      errors.push(`missing expected ${prefix} JavaScript chunk`);
    }
    return null;
  }

  if (matches.length > 1) {
    errors.push(
      `expected one ${prefix} JavaScript chunk, found ${matches.join(", ")}`,
    );
    return null;
  }

  return matches[0]!;
}

function checkGzipBudget({
  label,
  gzipBytes,
  maximumKiB,
  errors,
  reports,
  chunkCount,
}: {
  label: string;
  gzipBytes: number;
  maximumKiB: number;
  errors: string[];
  reports: string[];
  chunkCount?: number;
}) {
  const chunkSummary = chunkCount === undefined ? "" : ` (${chunkCount} chunks)`;
  const report = `${label}: ${formatKiB(gzipBytes)} KiB / ${maximumKiB} KiB${chunkSummary}`;

  if (gzipBytes > maximumKiB * kibibyte) {
    errors.push(report);
    return;
  }

  reports.push(report);
}

function rejectEagerOnDemandChunks(
  entryPrefix: string,
  closure: ReadonlySet<string>,
  errors: string[],
) {
  const eagerChunks = [...closure].filter((asset) =>
    onDemandPrefixes.some((prefix) => asset.startsWith(`${prefix}.`)),
  );

  if (eagerChunks.length > 0) {
    errors.push(
      `${entryPrefix} static closure must not include on-demand chunks: ${eagerChunks.join(", ")}`,
    );
  }
}

function sumGzipBytes(
  closure: ReadonlySet<string>,
  gzipSizes: ReadonlyMap<string, number>,
) {
  return [...closure].reduce(
    (total, asset) => total + (gzipSizes.get(asset) ?? 0),
    0,
  );
}

export function subtractChunks(
  chunks: ReadonlySet<string>,
  baseline: ReadonlySet<string>,
) {
  return new Set([...chunks].filter((asset) => !baseline.has(asset)));
}

export function collectStaticImportClosure(
  entry: string,
  chunks: ReadonlyMap<string, string>,
) {
  const closure = new Set<string>();
  const pending = [entry];

  while (pending.length > 0) {
    const asset = pending.pop()!;
    if (closure.has(asset)) continue;

    const source = chunks.get(asset);
    if (source === undefined) {
      throw new Error(`static import closure is missing ${asset}`);
    }

    closure.add(asset);
    for (const dependency of staticChunkImports(source)) {
      if (!chunks.has(dependency)) {
        throw new Error(
          `${asset} statically imports missing JavaScript chunk ${dependency}`,
        );
      }
      pending.push(dependency);
    }
  }

  return closure;
}

export function staticChunkImports(source: string) {
  const imports = new Set<string>();

  for (const match of source.matchAll(staticImportPattern)) {
    const specifier = match[1]!;
    if (!specifier.startsWith(".") || !specifier.endsWith(".js")) continue;

    const slash = specifier.lastIndexOf("/");
    imports.add(slash === -1 ? specifier : specifier.slice(slash + 1));
  }

  return imports;
}

function formatKiB(bytes: number) {
  return (bytes / kibibyte).toFixed(1);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
