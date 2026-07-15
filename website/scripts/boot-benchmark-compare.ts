import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  BOOT_BENCHMARK_VARIANTS,
  compareBootBenchmarkResults,
  parseBootBenchmarkResult,
} from "./boot-benchmark-core";

async function main(): Promise<void> {
  const { paths, outputPath } = parseOptions(process.argv.slice(2));
  const results = await Promise.all(
    paths.map(async (path) => {
      const absolute = resolve(path);
      const value = JSON.parse(await readFile(absolute, "utf8")) as unknown;
      return parseBootBenchmarkResult(value, absolute);
    }),
  );
  const comparison = compareBootBenchmarkResults(results);
  if (outputPath) {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(
      outputPath,
      `${JSON.stringify(comparison, null, 2)}\n`,
      "utf8",
    );
  }

  console.log(
    `host=${comparison.host_id} scenario=${comparison.scenario_id} artifact=${comparison.artifact_fingerprint_sha256.slice(0, 12)}`,
  );
  console.log(
    "variant\timplementation\tcpu_policy\tgate\tp50_ms\tp95_ms\tpassed\tfailed",
  );
  for (const variant of comparison.variants) {
    console.log(
      [
        variant.variant,
        variant.implementation_sha256.slice(0, 12),
        variant.cpu_policy.kind,
        variant.passed ? "PASS" : "FAIL",
        variant.p50_ms ?? "n/a",
        variant.p95_ms ?? "n/a",
        variant.measured_passed,
        variant.measured_failed,
      ].join("\t"),
    );
  }
  if (outputPath) console.log(`comparison_json=${outputPath}`);
}

function parseOptions(argv: string[]): {
  paths: string[];
  outputPath: string | null;
} {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      `Usage: bun run bench:boot:compare -- [--output comparison.json] ${BOOT_BENCHMARK_VARIANTS.map((variant) => `${variant}.json`).join(" ")}`,
    );
    process.exit(0);
  }
  const paths: string[] = [];
  let outputPath: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--output") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) {
        throw new Error("--output requires a path");
      }
      outputPath = resolve(value);
    } else if (arg.startsWith("--output=")) {
      const value = arg.slice("--output=".length);
      if (!value) throw new Error("--output requires a path");
      outputPath = resolve(value);
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      paths.push(arg);
    }
  }
  if (paths.length !== BOOT_BENCHMARK_VARIANTS.length) {
    throw new Error(
      `comparison requires exactly ${BOOT_BENCHMARK_VARIANTS.length} benchmark result files`,
    );
  }
  return { paths, outputPath };
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(
      `[boot-benchmark-compare] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
